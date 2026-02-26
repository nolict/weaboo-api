"""
Weaboo API — HuggingFace Space Worker
FastAPI app + background worker for downloading anime episode videos and
uploading them to HuggingFace Dataset storage accounts.

Architecture:
  - FastAPI serves /health and /trigger endpoints
  - Background asyncio task polls Supabase video_queue every 10 seconds
  - On POST /trigger: immediately process the given queue entry (realtime)
  - Downloads via aria2c (multi-thread, fast for large files)
  - Uploads via huggingface_hub with path_or_fileobj → auto Git LFS for >5MB files
  - Distributes across 5 storage accounts (least-used first, round-robin fallback)
  - Filenames obfuscated via SHA-256 hash + secret salt

Environment variables (set in HF Space settings):
  SUPABASE_URL                — Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY   — Supabase service role key
  HF_TOKEN_WORKER             — HF token for THIS space (worker account)
  HF_TOKEN_STORAGE_1..5       — HF tokens for 5 storage accounts
  HF_STORAGE_USERNAME_1..5    — HF usernames for 5 storage accounts
  HF_FILE_SALT                — Secret salt for filename obfuscation
  CLOUDFLARE_WORKERS_URL      — CF Workers base URL for constructing stream_url
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shutil
import subprocess
import tempfile
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_bearer_scheme = HTTPBearer(auto_error=False)
from fastapi.responses import JSONResponse
from huggingface_hub import HfApi
from huggingface_hub.utils import RepositoryNotFoundError
from supabase import Client, create_client

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("weaboo-worker")

# ── Environment ───────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HF_FILE_SALT = os.environ.get("HF_FILE_SALT", "weaboo-default-salt")
CF_WORKERS_BASE_URL = os.environ.get("CLOUDFLARE_WORKERS_URL", "").rstrip("/")
# Webhook secret — pakai HF_FILE_SALT yang sudah ada, tidak perlu env var baru
WEBHOOK_SECRET = HF_FILE_SALT

# Worker account token (for the Space itself — not used for storage)
HF_TOKEN_WORKER = os.environ.get("HF_TOKEN_WORKER", "")

# Storage accounts — 5 slots
HF_STORAGE_COUNT = 5
HF_TOKENS: list[str] = [
    os.environ.get(f"HF_TOKEN_STORAGE_{i}", "") for i in range(1, HF_STORAGE_COUNT + 1)
]
HF_USERNAMES: list[str] = [
    os.environ.get(f"HF_STORAGE_USERNAME_{i}", "") for i in range(1, HF_STORAGE_COUNT + 1)
]

# Validate at least one storage account is configured
_valid_accounts = [i for i in range(HF_STORAGE_COUNT) if HF_TOKENS[i] and HF_USERNAMES[i]]
if not _valid_accounts:
    log.warning("⚠️  No HF storage accounts configured! Set HF_TOKEN_STORAGE_1..5 and HF_STORAGE_USERNAME_1..5")

# ── Supabase client ───────────────────────────────────────────────────────────

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── HuggingFace helpers ───────────────────────────────────────────────────────

def get_hf_api(account_idx: int) -> HfApi:
    """Return an HfApi instance for the given storage account index (0-based)."""
    token = HF_TOKENS[account_idx]
    if not token:
        raise ValueError(f"HF_TOKEN_STORAGE_{account_idx + 1} is not set")
    return HfApi(token=token)


def get_repo_id(account_idx: int, mal_id: int) -> str:
    """
    Generate the dataset repo ID for a given storage account and anime.
    Format: {username}/weaboo-{mal_id}
    Each anime gets its own repo to keep storage organized.
    Username is sanitized: spaces → hyphens, strip invalid chars.
    """
    username = HF_USERNAMES[account_idx]
    if not username:
        raise ValueError(f"HF_STORAGE_USERNAME_{account_idx + 1} is not set")
    # Sanitize username: strip whitespace, replace spaces with hyphens
    username = username.strip().replace(" ", "-")
    # Remove any characters that are not alphanumeric, hyphen, underscore, or dot
    username = re.sub(r"[^a-zA-Z0-9\-_.]", "", username)
    # Strip leading/trailing hyphens and dots
    username = username.strip("-.")
    if not username:
        raise ValueError(f"HF_STORAGE_USERNAME_{account_idx + 1} is invalid after sanitization")
    return f"{username}/weaboo-{mal_id}"


def ensure_repo_exists(api: HfApi, repo_id: str, private: bool = False) -> None:
    """
    Create the HF dataset repo if it doesn't exist yet.
    Repos are PUBLIC by default — CF Workers streams directly from HF raw URL
    without needing an auth token. Files are obfuscated via SHA-256 hash so
    the contents are not discoverable even though the repo is public.
    """
    try:
        api.repo_info(repo_id=repo_id, repo_type="dataset")
        log.debug(f"  Repo exists: {repo_id}")
    except RepositoryNotFoundError:
        log.info(f"  Creating new repo: {repo_id} (public, obfuscated filenames)")
        api.create_repo(repo_id=repo_id, repo_type="dataset", private=private)


def pick_storage_account(mal_id: int) -> int:
    """
    Pick the best storage account index (0-based) for a given anime.
    Strategy:
      1. Check which accounts have the fewest repos (least used)
      2. Fallback: round-robin via mal_id % count
    Returns account index (0-based).
    """
    if not _valid_accounts:
        raise RuntimeError("No valid HF storage accounts configured")

    # Try to find least-used account by checking repo count
    min_count = float("inf")
    best_idx = _valid_accounts[mal_id % len(_valid_accounts)]  # fallback

    for idx in _valid_accounts:
        try:
            api = get_hf_api(idx)
            repos = list(api.list_datasets(author=HF_USERNAMES[idx], limit=100))
            count = len(repos)
            if count < min_count:
                min_count = count
                best_idx = idx
        except Exception as e:
            log.debug(f"  Could not check account {idx + 1} repo count: {e}")

    return best_idx


def make_file_key(mal_id: int, episode: int, provider: str, resolution: Optional[str]) -> str:
    """
    Generate an obfuscated filename key using SHA-256.
    Format: first 32 hex chars of SHA-256(salt:mal_id:episode:provider:resolution)
    The extension (.mp4 or .m3u8) is appended separately at upload time.
    """
    raw = f"{HF_FILE_SALT}:{mal_id}:{episode}:{provider}:{resolution or 'unknown'}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def make_hf_path(mal_id: int, episode: int, file_key: str, is_hls: bool) -> str:
    """
    Build the path inside the HF dataset repo.
    Format: {mal_id}/ep{episode}/{file_key}.mp4 (or .m3u8 for HLS)
    Using mal_id as top-level folder ensures each anime is isolated.
    """
    ext = "m3u8" if is_hls else "mp4"
    return f"{mal_id}/ep{episode}/{file_key}.{ext}"


def make_stream_url(hf_direct_url: str) -> str:
    """
    Build the Cloudflare Workers proxy URL for a given HF direct URL.
    Format: {CF_WORKERS_BASE_URL}/proxy?url=<encoded_hf_direct_url>
    """
    if not CF_WORKERS_BASE_URL:
        return hf_direct_url  # fallback: return HF URL directly if CF not configured
    encoded = hf_direct_url.replace(":", "%3A").replace("/", "%2F").replace("?", "%3F").replace("=", "%3D").replace("&", "%26")
    return f"{CF_WORKERS_BASE_URL}/proxy?url={encoded}"


# ── aria2c download ───────────────────────────────────────────────────────────

def download_with_aria2c(url: str, output_path: str) -> bool:
    """
    Download a video file using aria2c with multi-thread acceleration.
    Supports both direct MP4 URLs and HLS .m3u8 playlists.
    For HLS: falls back to ffmpeg (aria2c cannot reassemble segments).
    Returns True on success, False on failure.
    """
    is_hls = ".m3u8" in url or "m3u8" in url.lower()

    if is_hls:
        return _download_hls_ffmpeg(url, output_path)
    else:
        return _download_mp4_aria2c(url, output_path)


def _download_mp4_aria2c(url: str, output_path: str) -> bool:
    """Download a direct MP4/video URL with aria2c (8 connections, 8 splits)."""
    output_dir = os.path.dirname(output_path)
    output_file = os.path.basename(output_path)

    cmd = [
        "aria2c",
        "--split=8",                         # split file into 8 parts
        "--max-connection-per-server=8",     # 8 connections per server
        "--min-split-size=1M",               # min part size 1MB
        "--max-tries=3",                     # retry 3 times on error
        "--retry-wait=2",                    # wait 2s between retries
        "--timeout=60",                      # connection timeout 60s
        "--connect-timeout=30",              # DNS + connect timeout
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "--allow-overwrite=true",
        f"--dir={output_dir}",
        f"--out={output_file}",
        url,
    ]

    log.info(f"  ⬇️  aria2c download: {url[:80]}...")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if result.returncode == 0:
            log.info(f"  ✅ Download complete: {output_path}")
            return True
        else:
            log.error(f"  ❌ aria2c failed (code {result.returncode}): {result.stderr[:500]}")
            return False
    except subprocess.TimeoutExpired:
        log.error("  ❌ aria2c timed out after 1 hour")
        return False
    except FileNotFoundError:
        log.error("  ❌ aria2c not found — install aria2 package in Space")
        return False


def _download_hls_ffmpeg(url: str, output_path: str) -> bool:
    """Download an HLS stream using ffmpeg (copy codec, no re-encode)."""
    cmd = [
        "ffmpeg",
        "-y",                    # overwrite output
        "-i", url,               # input HLS URL
        "-c", "copy",            # copy streams without re-encoding
        "-bsf:a", "aac_adtstoasc",  # fix AAC stream for MP4 container
        output_path,
    ]

    log.info(f"  ⬇️  ffmpeg HLS download: {url[:80]}...")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
        if result.returncode == 0:
            log.info(f"  ✅ HLS download complete: {output_path}")
            return True
        else:
            log.error(f"  ❌ ffmpeg failed (code {result.returncode}): {result.stderr[-500:]}")
            return False
    except subprocess.TimeoutExpired:
        log.error("  ❌ ffmpeg timed out after 2 hours")
        return False
    except FileNotFoundError:
        log.error("  ❌ ffmpeg not found — install ffmpeg in Space")
        return False


# ── Supabase queue helpers ────────────────────────────────────────────────────

def claim_pending_jobs(limit: int = 3) -> list[dict]:
    """Atomically claim pending jobs from video_queue (sets status=downloading)."""
    try:
        result = supabase.rpc("claim_pending_videos", {"p_limit": limit}).execute()
        return result.data or []
    except Exception as e:
        log.error(f"[Queue] claim_pending_jobs failed: {e}")
        return []


def update_queue_status(job_id: str, status: str, error: Optional[str] = None) -> None:
    """Update the status of a video_queue entry."""
    try:
        supabase.rpc(
            "update_video_queue_status",
            {"p_id": job_id, "p_status": status, "p_error": error},
        ).execute()
    except Exception as e:
        log.error(f"[Queue] update_queue_status failed: {e}")


def upsert_video_store(
    mal_id: int,
    episode: int,
    provider: str,
    resolution: Optional[str],
    file_key: str,
    hf_account: int,
    hf_repo: str,
    hf_path: str,
    hf_direct_url: str,
    stream_url: str,
) -> None:
    """Save completed upload info to video_store and mark queue entry as ready."""
    try:
        supabase.rpc(
            "upsert_video_store",
            {
                "p_mal_id": mal_id,
                "p_episode": episode,
                "p_provider": provider,
                "p_resolution": resolution,
                "p_file_key": file_key,
                "p_hf_account": hf_account,
                "p_hf_repo": hf_repo,
                "p_hf_path": hf_path,
                "p_hf_direct_url": hf_direct_url,
                "p_stream_url": stream_url,
            },
        ).execute()
        log.info(f"  ✅ video_store upserted: mal={mal_id} ep={episode} provider={provider}")
    except Exception as e:
        log.error(f"[Queue] upsert_video_store failed: {e}")


# ── Core processing ───────────────────────────────────────────────────────────

def build_hf_direct_url(username: str, repo_name: str, hf_path: str) -> str:
    """
    Build the HuggingFace raw download URL for a dataset file.
    Format: https://huggingface.co/datasets/{repo_id}/resolve/main/{path}
    """
    return f"https://huggingface.co/datasets/{username}/{repo_name}/resolve/main/{hf_path}"


async def process_job(job: dict) -> None:
    """
    Process a single video_queue job end-to-end:
      1. Download video via aria2c (or ffmpeg for HLS)
      2. Upload to HuggingFace Dataset (auto Git LFS via path_or_fileobj)
      3. Upsert to video_store + mark queue as ready
      4. Clean up temp file
    """
    job_id: str = job["id"]
    mal_id: int = job["mal_id"]
    episode: int = job["episode"]
    provider: str = job["provider"]
    video_url: str = job["video_url"]
    resolution: Optional[str] = job.get("resolution")

    log.info(f"🎬 Processing: mal={mal_id} ep={episode} provider={provider} res={resolution or 'unknown'}")

    is_hls = ".m3u8" in video_url or "m3u8" in video_url.lower()
    file_key = make_file_key(mal_id, episode, provider, resolution)
    ext = "mp4"  # Always output as mp4 (ffmpeg converts HLS segments to MP4 container)

    if not _valid_accounts:
        log.error("  ❌ No storage accounts configured")
        update_queue_status(job_id, "failed", "No storage accounts configured")
        return

    # ── Step 1: Download to temp file (sekali, lalu upload ke semua akun) ────
    tmpdir = tempfile.mkdtemp(prefix="weaboo_")
    tmp_file = os.path.join(tmpdir, f"{file_key}.{ext}")

    try:
        update_queue_status(job_id, "downloading")
        success = await asyncio.get_event_loop().run_in_executor(
            None, download_with_aria2c, video_url, tmp_file
        )

        if not success or not os.path.exists(tmp_file):
            raise RuntimeError("Download failed or output file missing")

        file_size_mb = os.path.getsize(tmp_file) / (1024 * 1024)
        log.info(f"  📁 Downloaded: {file_size_mb:.1f} MB → {tmp_file}")

        # ── Step 2: Upload ke SEMUA akun storage (backup/redundancy) ──────────
        update_queue_status(job_id, "uploading")
        hf_path = make_hf_path(mal_id, episode, file_key, False)

        # Gunakan akun pertama yang berhasil sebagai primary untuk video_store
        primary_uploaded = False

        for account_idx in _valid_accounts:
            try:
                api = get_hf_api(account_idx)
                repo_id = get_repo_id(account_idx, mal_id)
                repo_name = f"weaboo-{mal_id}"
                username = HF_USERNAMES[account_idx]

                await asyncio.get_event_loop().run_in_executor(
                    None, ensure_repo_exists, api, repo_id, False
                )

                log.info(f"  ⬆️  Uploading to account {account_idx + 1}: {repo_id}/{hf_path}")

                await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda _api=api, _repo_id=repo_id: _api.upload_file(
                        path_or_fileobj=tmp_file,
                        path_in_repo=hf_path,
                        repo_id=_repo_id,
                        repo_type="dataset",
                        commit_message=f"weaboo: add ep{episode} ({provider})",
                    ),
                )

                log.info(f"  ✅ Upload complete: account {account_idx + 1} → {repo_id}/{hf_path}")

                # Simpan akun pertama yang berhasil ke video_store sebagai primary
                if not primary_uploaded:
                    hf_direct_url = build_hf_direct_url(username, repo_name, hf_path)
                    stream_url = make_stream_url(hf_direct_url)
                    upsert_video_store(
                        mal_id=mal_id,
                        episode=episode,
                        provider=provider,
                        resolution=resolution,
                        file_key=file_key,
                        hf_account=account_idx + 1,
                        hf_repo=repo_id,
                        hf_path=hf_path,
                        hf_direct_url=hf_direct_url,
                        stream_url=stream_url,
                    )
                    primary_uploaded = True

            except Exception as e:
                log.error(f"  ❌ Upload failed for account {account_idx + 1}: {e}")
                # Lanjut ke akun berikutnya, jangan stop semua

        if not primary_uploaded:
            raise RuntimeError("Upload failed for all storage accounts")

    except Exception as e:
        log.error(f"  ❌ Job failed (mal={mal_id} ep={episode}): {e}")
        update_queue_status(job_id, "failed", str(e)[:500])

    finally:
        # Always clean up temp directory
        shutil.rmtree(tmpdir, ignore_errors=True)
        log.debug(f"  🗑️  Cleaned up temp dir: {tmpdir}")


# ── Background polling worker ─────────────────────────────────────────────────

# Semaphore to limit concurrent jobs (avoid OOM on large video files)
_job_semaphore = asyncio.Semaphore(2)
_is_running = False


async def background_worker() -> None:
    """
    Polls Supabase video_queue every 10 seconds for pending jobs.
    Processes up to 2 jobs concurrently (controlled by semaphore).
    Runs indefinitely as a background asyncio task.
    """
    global _is_running
    _is_running = True
    log.info("🚀 Background worker started — polling every 10s")

    while True:
        try:
            jobs = await asyncio.get_event_loop().run_in_executor(None, claim_pending_jobs, 2)

            if jobs:
                log.info(f"📋 Claimed {len(jobs)} pending job(s)")
                tasks = [_run_with_semaphore(job) for job in jobs]
                await asyncio.gather(*tasks, return_exceptions=True)
            else:
                log.debug("⏳ No pending jobs")

        except Exception as e:
            log.error(f"[Worker] Poll cycle error: {e}")

        await asyncio.sleep(10)


async def _run_with_semaphore(job: dict) -> None:
    """Run a single job with concurrency control via semaphore."""
    async with _job_semaphore:
        await process_job(job)


# ── FastAPI app ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start background worker on app startup."""
    task = asyncio.create_task(background_worker())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="Weaboo HF Worker",
    description="Background video download + HuggingFace upload worker for Weaboo API",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/")
async def root() -> JSONResponse:
    """Root endpoint — satisfies HuggingFace Space health check."""
    return JSONResponse({
        "name": "weaboo-worker",
        "status": "ok",
        "worker_running": _is_running,
    })


@app.get("/health")
async def health() -> JSONResponse:
    """Health check — confirms the Space is awake and worker is running."""
    return JSONResponse({
        "status": "ok",
        "worker_running": _is_running,
        "storage_accounts": len(_valid_accounts),
        "cf_workers_configured": bool(CF_WORKERS_BASE_URL),
    })


@app.post("/trigger")
async def trigger(
    request: Request,
    background_tasks: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials = Security(_bearer_scheme),
) -> JSONResponse:
    """
    Realtime webhook trigger called by Weaboo API after enqueuing a video.
    Requires Authorization: Bearer <WEBHOOK_SECRET> header.

    Body (JSON):
      {
        "mal_id": 55825,
        "episode": 1,
        "provider": "animasu",
        "video_url": "https://...",
        "resolution": "720p"
      }
    """
    # ── Auth check ────────────────────────────────────────────────────────────
    if WEBHOOK_SECRET:
        token = credentials.credentials if credentials else None
        if token != WEBHOOK_SECRET:
            raise HTTPException(status_code=401, detail="Invalid or missing webhook secret")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    mal_id = body.get("mal_id")
    episode = body.get("episode")
    provider = body.get("provider")
    video_url = body.get("video_url")
    resolution = body.get("resolution")

    if not all([mal_id, episode, provider, video_url]):
        raise HTTPException(status_code=400, detail="Missing required fields: mal_id, episode, provider, video_url")

    if provider not in ("animasu", "samehadaku"):
        raise HTTPException(status_code=400, detail="provider must be 'animasu' or 'samehadaku'")

    log.info(f"⚡ Webhook trigger: mal={mal_id} ep={episode} provider={provider}")

    # Check if this job is already claimed/processing (avoid duplicate work)
    try:
        existing = (
            supabase.table("video_queue")
            .select("status")
            .eq("mal_id", mal_id)
            .eq("episode", episode)
            .eq("provider", provider)
            .eq("resolution", resolution)
            .maybe_single()
            .execute()
        )
        if existing.data and existing.data.get("status") in ("downloading", "uploading", "ready"):
            log.info(f"  ⏭️  Job already {existing.data['status']} — skipping trigger")
            return JSONResponse({"queued": False, "reason": existing.data["status"]})
    except Exception:
        pass  # Safe to proceed even if status check fails

    # Build a synthetic job dict for immediate processing
    job = {
        "id": "webhook-triggered",
        "mal_id": mal_id,
        "episode": episode,
        "provider": provider,
        "video_url": video_url,
        "resolution": resolution,
    }

    # Run in background so we return 200 immediately to the caller
    background_tasks.add_task(_run_with_semaphore, job)

    return JSONResponse({"queued": True, "mal_id": mal_id, "episode": episode, "provider": provider})


@app.get("/status")
async def status() -> JSONResponse:
    """Return current queue statistics from Supabase."""
    try:
        result = (
            supabase.table("video_queue")
            .select("status")
            .execute()
        )
        rows = result.data or []
        counts: dict[str, int] = {}
        for row in rows:
            s = row.get("status", "unknown")
            counts[s] = counts.get(s, 0) + 1

        store_result = supabase.table("video_store").select("id", count="exact").execute()
        archived_count = store_result.count or 0

        return JSONResponse({
            "queue": counts,
            "archived": archived_count,
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
