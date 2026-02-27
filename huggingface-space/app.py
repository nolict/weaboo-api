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


def get_repo_id(account_idx: int) -> str:
    """
    Generate the dataset repo ID for a given storage account.
    Format: {username}/weaboo-storage
    Single global dataset per account — all anime stored inside with
    path structure: {mal_id}/ep{episode}/{file_key}.mp4
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
    return f"{username}/weaboo-storage"


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


# ── aria2c / mega / ffmpeg download ──────────────────────────────────────────

def _is_mega_url(url: str) -> bool:
    """Detect if a URL is a Mega.nz embed or file URL."""
    try:
        from urllib.parse import urlparse
        hostname = urlparse(url).hostname or ""
        return "mega.nz" in hostname or "mega.co.nz" in hostname
    except Exception:
        return False


def _mega_base64_to_bytes(s: str) -> bytes:
    """Decode Mega's URL-safe base64 (no padding) to bytes."""
    import base64 as _base64
    s = s.replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    return _base64.b64decode(s)


def _mega_get_file_key_and_iv(key_bytes: bytes):
    """
    Mega file key is 32 bytes: first 16 are the AES key (XORed in pairs),
    last 16 are the IV (first 8 bytes) + counter (last 8 bytes, always 0).
    Returns (aes_key: bytes, iv: bytes)
    """
    # XOR the two halves to get the actual AES key
    k = [key_bytes[i] ^ key_bytes[i + 16] for i in range(16)]
    aes_key = bytes(k)
    # IV = first 8 bytes of second half, repeated to 16 bytes (counter mode)
    iv = key_bytes[16:24] + b"\x00" * 8
    return aes_key, iv


def _download_mega(url: str, output_path: str) -> bool:
    """
    Download and decrypt a Mega.nz file without mega.py library.
    Compatible with Python 3.11+ (mega.py uses removed asyncio.coroutine).

    Mega file encryption: AES-128-CTR with key+IV embedded in URL hash fragment.
    URL format: https://mega.nz/embed/{NODE_ID}#{KEY_BASE64}
                https://mega.nz/file/{NODE_ID}#{KEY_BASE64}

    Flow:
      1. Parse NODE_ID and KEY from URL
      2. POST to Mega API (/cs) with action "g" → get CDN URL + encrypted attr
      3. Download encrypted bytes from CDN URL via aria2c (fast multi-thread)
      4. Decrypt AES-128-CTR on-the-fly while writing output file
    """
    import urllib.request
    import json as json_mod
    from Crypto.Cipher import AES

    log.info(f"  ⬇️  Mega native download (AES-128-CTR decrypt): {url[:80]}...")

    try:
        # ── Step 1: Parse NODE_ID and KEY from URL ────────────────────────────
        # Handle both /embed/ and /file/ paths
        node_match = re.search(r"mega\.nz/(?:embed|file)/([A-Za-z0-9_-]+)#?([A-Za-z0-9_-]*)", url)
        if not node_match:
            log.error(f"  ❌ Mega: cannot parse NODE_ID from URL: {url}")
            return False

        node_id = node_match.group(1)
        key_b64 = node_match.group(2)

        if not key_b64:
            log.error("  ❌ Mega: no KEY in URL hash — cannot decrypt")
            return False

        # Decode the file key (32 bytes for a file)
        raw_key = _mega_base64_to_bytes(key_b64)
        if len(raw_key) != 32:
            log.error(f"  ❌ Mega: unexpected key length {len(raw_key)} (expected 32)")
            return False

        aes_key, iv = _mega_get_file_key_and_iv(raw_key)

        # ── Step 2: Get CDN download URL from Mega API (with retry for -3 EAGAIN) ──
        import time as _time
        cdn_url = None
        file_size = 0
        max_retries = 5
        for attempt in range(max_retries):
            api_url = f"https://g.api.mega.co.nz/cs?id={os.urandom(4).hex()}"
            req_body = json_mod.dumps([{"a": "g", "g": 1, "p": node_id}]).encode()
            req = urllib.request.Request(
                api_url,
                data=req_body,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Origin": "https://mega.nz",
                    "Referer": "https://mega.nz/",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                api_data = json_mod.loads(resp.read())

            if not isinstance(api_data, list) or not api_data:
                log.error(f"  ❌ Mega API: unexpected response: {api_data}")
                return False

            result = api_data[0]

            # -3 = EAGAIN (rate limited) — retry with exponential backoff
            if result == -3 or result == -4:
                wait = 2 ** attempt  # 1s, 2s, 4s, 8s, 16s
                log.warning(f"  ⚠️  Mega API rate limited ({result}), retry {attempt + 1}/{max_retries} in {wait}s...")
                _time.sleep(wait)
                continue

            if isinstance(result, int):
                log.error(f"  ❌ Mega API error code: {result}")
                return False

            cdn_url = result.get("g")
            file_size = result.get("s", 0)
            if not cdn_url:
                log.error("  ❌ Mega API: no CDN URL in response")
                return False
            break  # success

        if cdn_url is None:
            log.error(f"  ❌ Mega API: still rate limited after {max_retries} retries")
            return False

        log.info(f"  📡 Mega CDN URL obtained, size={file_size / (1024*1024):.1f} MB")

        # ── Step 3: Download encrypted bytes from CDN via urllib (streaming) ──
        # We stream + decrypt simultaneously to avoid double memory usage.
        # aria2c cannot be used here because we need to decrypt on-the-fly.
        chunk_size = 1024 * 1024  # 1 MB chunks

        cdn_req = urllib.request.Request(
            cdn_url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        )
        log.info(f"  ⬇️  Downloading encrypted bytes from Mega CDN...")
        with urllib.request.urlopen(cdn_req, timeout=3600) as cdn_resp, \
             open(output_path, "wb") as out_f:
            # AES-128-CTR: Mega uses a custom CTR where the counter increments
            # every 16 bytes but is tracked as 64-bit counter in the IV structure.
            # nonce = first 8 bytes of iv, initial_value (counter) starts at 0.
            cipher = AES.new(
                aes_key,
                AES.MODE_CTR,
                nonce=iv[:8],
                initial_value=b"\x00" * 8,
            )
            downloaded = 0
            while True:
                chunk = cdn_resp.read(chunk_size)
                if not chunk:
                    break
                decrypted = cipher.decrypt(chunk)
                out_f.write(decrypted)
                downloaded += len(chunk)

        if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
            log.error("  ❌ Mega: output file missing or empty after decrypt")
            return False

        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        log.info(f"  ✅ Mega download+decrypt complete: {size_mb:.1f} MB → {output_path}")
        return True

    except Exception as e:
        log.error(f"  ❌ Mega native download failed: {e}")
        # Clean up partial output file if it exists
        if os.path.exists(output_path):
            os.remove(output_path)
        return False


def download_with_aria2c(url: str, output_path: str) -> bool:
    """
    Download a video file. Dispatch to the correct downloader based on URL:
    - Mega.nz URLs → _download_mega (native AES-128-CTR decryption)
    - Vidhidepro embed URLs → re-resolve fresh from HF Space ASN → ffmpeg HLS
    - HLS .m3u8 URLs → ffmpeg (reassembles + muxes segments into MP4)
    - Everything else → aria2c (multi-thread accelerated direct download)
    Returns True on success, False on failure.
    """
    if _is_mega_url(url):
        return _download_mega(url, output_path)

    # Vidhidepro embed URL: re-resolve fresh so CDN token is bound to HF Space ASN
    if _is_vidhidepro_embed(url):
        fresh_url = _resolve_vidhidepro_fresh(url)
        if fresh_url is None:
            log.error("  ❌ Vidhidepro re-resolve returned None — cannot download")
            return False
        return _download_hls_ffmpeg(fresh_url, output_path)

    is_hls = ".m3u8" in url or "m3u8" in url.lower()
    if is_hls:
        return _download_hls_ffmpeg(url, output_path)

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


def _is_vidhidepro_embed(url: str) -> bool:
    """Check if URL is a Vidhidepro embed URL (vidhidepro/vidhidefast/callistanise)."""
    try:
        from urllib.parse import urlparse
        hostname = urlparse(url).hostname or ""
        return any(h in hostname for h in ["vidhidepro", "vidhidefast", "callistanise"])
    except Exception:
        return False


def _resolve_vidhidepro_fresh(embed_url: str) -> Optional[str]:
    """
    Re-resolve a Vidhidepro embed URL to get a fresh HLS sub-playlist URL.
    Called from HF Space just before download so the CDN token is bound to
    HF Space's ASN (not the API server's ASN from earlier scrape time).
    Returns fresh HLS URL or None if resolution fails.
    """
    import urllib.request
    import re as _re

    log.info(f"  🔄 Re-resolving Vidhidepro embed URL from HF Space: {embed_url[:60]}...")
    try:
        req = urllib.request.Request(
            embed_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
                "Referer": "https://vidhidefast.com/",
            },
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        if not html or "eval(function" not in html:
            log.warning("  ⚠️  Vidhidepro re-resolve: no packed JS found")
            return None

        # Find and unpack the Dean Edwards packed JS
        # Extract the packed string: eval(function(p,a,c,k,e,d){...}('...',N,N,'...'.split('|')))
        pack_match = _re.search(
            r"eval\(function\(p,a,c,k,e,(?:d|r)\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)\)",
            html,
            _re.DOTALL,
        )
        if not pack_match:
            log.warning("  ⚠️  Vidhidepro re-resolve: packed JS regex no match")
            return None

        p, a, c, k = pack_match.group(1), int(pack_match.group(2)), int(pack_match.group(3)), pack_match.group(4).split("|")

        def unpack(p: str, a: int, c: int, k: list) -> str:
            def base_n(num: int, base: int) -> str:
                digits = "0123456789abcdefghijklmnopqrstuvwxyz"
                if num == 0:
                    return "0"
                result = ""
                while num:
                    result = digits[num % base] + result
                    num //= base
                return result

            for i in range(c - 1, -1, -1):
                if k[i]:
                    p = _re.sub(r"\b" + base_n(i, a) + r"\b", k[i], p)
            return p

        unpacked = unpack(p, a, c, k)

        # Extract hls2 (highest quality CDN URL)
        for key in ["hls2", "hls4", "hls3"]:
            m = _re.search(rf'"{key}"\s*:\s*"([^"]+)"', unpacked)
            if m:
                master_url = m.group(1).replace("\\/", "/")
                log.info(f"  🎯 Got {key} master URL: {master_url[:80]}...")

                # Fetch master.m3u8 to get sub-playlist URL
                master_req = urllib.request.Request(
                    master_url,
                    headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
                )
                with urllib.request.urlopen(master_req, timeout=15) as master_resp:
                    m3u8_content = master_resp.read().decode("utf-8", errors="ignore")
                    final_url = master_resp.geturl()  # resolved URL after redirect

                # Parse sub-playlist from master.m3u8
                lines = m3u8_content.splitlines()
                for i, line in enumerate(lines):
                    if line.startswith("#EXT-X-STREAM-INF") and i + 1 < len(lines):
                        sub_path = lines[i + 1].strip()
                        if sub_path and not sub_path.startswith("#"):
                            if sub_path.startswith("http"):
                                log.info(f"  ✅ Fresh HLS URL: {sub_path[:80]}...")
                                return sub_path
                            else:
                                # Relative path — absolutise using master URL base
                                base = final_url.rsplit("/", 1)[0]
                                abs_url = f"{base}/{sub_path}"
                                log.info(f"  ✅ Fresh HLS URL (abs): {abs_url[:80]}...")
                                return abs_url

                log.warning(f"  ⚠️  Vidhidepro re-resolve: no sub-playlist in master.m3u8")
                return master_url  # fallback: return master URL

        log.warning("  ⚠️  Vidhidepro re-resolve: no hls links found in unpacked JS")
        return None

    except Exception as e:
        log.error(f"  ❌ Vidhidepro re-resolve failed: {e}")
        return None


def _download_hls_ffmpeg(url: str, output_path: str) -> bool:
    """Download an HLS stream using ffmpeg (copy codec, no re-encode)."""
    cmd = [
        "ffmpeg",
        "-y",                    # overwrite output
        # Spoof browser UA + Referer so CDNs (dramiyos-cdn, acek-cdn) don't 403
        "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "-headers", "Referer: https://callistanise.com/\r\n",
        # Allow all HLS-related protocols
        "-allowed_extensions", "ALL",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        # Disable ffmpeg internal reconnect/retry — prevents mixing segments
        # from two different token-bound URLs (causes AVERROR_INVALIDDATA code 183)
        "-reconnect", "0",
        "-reconnect_streamed", "0",
        "-reconnect_on_network_error", "0",
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

def claim_pending_jobs(limit: int = 5) -> list[dict]:
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

def build_hf_direct_url(username: str, hf_path: str) -> str:
    """
    Build the HuggingFace raw download URL for a dataset file.
    All files stored in single global repo: {username}/weaboo-storage
    Format: https://huggingface.co/datasets/{username}/weaboo-storage/resolve/main/{path}
    """
    return f"https://huggingface.co/datasets/{username}/weaboo-storage/resolve/main/{hf_path}"


async def process_job(job: dict) -> None:
    """
    Process a single video_queue job end-to-end:
      1. Download video via aria2c (or ffmpeg for HLS)
      2. Upload to ALL HuggingFace storage accounts (backup/redundancy)
      3. Upsert primary account to video_store (upsert_video_store also marks queue ready)
      4. Explicitly mark queue as ready in case job_id is a real UUID
      5. Clean up temp file
    """
    job_id: Optional[str] = job.get("id")  # may be None for webhook-triggered jobs without DB row
    mal_id: int = job["mal_id"]
    episode: int = job["episode"]
    provider: str = job["provider"]
    video_url: str = job["video_url"]
    resolution: Optional[str] = job.get("resolution")

    # Helper: only call update_queue_status if we have a real UUID
    def _update_status(status: str, error: Optional[str] = None) -> None:
        if job_id is not None:
            update_queue_status(job_id, status, error)

    log.info(f"🎬 Processing: mal={mal_id} ep={episode} provider={provider} res={resolution or 'unknown'} id={job_id or 'webhook'}")

    # Guard: check available disk space before downloading
    # HF Space /tmp is limited — abort early if < 2GB free to avoid disk full crashes
    import shutil as _shutil
    disk = _shutil.disk_usage("/tmp")
    free_gb = disk.free / (1024 ** 3)
    if free_gb < 2.0:
        log.error(f"  ❌ Insufficient disk space: {free_gb:.1f}GB free (need 2GB)")
        _update_status("failed", f"Insufficient disk space: {free_gb:.1f}GB free")
        return

    file_key = make_file_key(mal_id, episode, provider, resolution)
    ext = "mp4"  # Always output as mp4 (ffmpeg converts HLS segments to MP4 container)

    if not _valid_accounts:
        log.error("  ❌ No storage accounts configured")
        _update_status("failed", "No storage accounts configured")
        return

    # ── Step 1: Download to temp file (once, then upload to all accounts) ────
    tmpdir = tempfile.mkdtemp(prefix="weaboo_")
    tmp_file = os.path.join(tmpdir, f"{file_key}.{ext}")

    try:
        _update_status("downloading")
        success = await asyncio.get_event_loop().run_in_executor(
            None, download_with_aria2c, video_url, tmp_file
        )

        if not success or not os.path.exists(tmp_file):
            raise RuntimeError("Download failed or output file missing")

        file_size_mb = os.path.getsize(tmp_file) / (1024 * 1024)
        log.info(f"  📁 Downloaded: {file_size_mb:.1f} MB → {tmp_file}")

        # ── Step 2: Upload to ALL storage accounts (backup/redundancy) ────────
        _update_status("uploading")
        hf_path = make_hf_path(mal_id, episode, file_key, False)

        # Track which account to use as primary for video_store
        primary_uploaded = False
        upload_success_count = 0

        for account_idx in _valid_accounts:
            try:
                api = get_hf_api(account_idx)
                repo_id = get_repo_id(account_idx)  # single global repo per account
                username = HF_USERNAMES[account_idx]

                await asyncio.get_event_loop().run_in_executor(
                    None, ensure_repo_exists, api, repo_id, False
                )

                log.info(f"  ⬆️  Uploading to account {account_idx + 1}: {repo_id}/{hf_path}")

                # Capture loop variables explicitly to avoid closure capture bug
                _tmp_file = tmp_file
                _hf_path = hf_path
                _commit_msg = f"weaboo: add ep{episode} ({provider})"

                # Per-repo lock: serialize uploads to the same repo to prevent
                # 412 Precondition Failed (Git merge conflict from concurrent commits).
                repo_lock = await _get_repo_lock(account_idx, repo_id)
                async with repo_lock:
                    await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda _api=api, _repo_id=repo_id: _api.upload_file(
                            path_or_fileobj=_tmp_file,
                            path_in_repo=_hf_path,
                            repo_id=_repo_id,
                            repo_type="dataset",
                            commit_message=_commit_msg,
                        ),
                    )

                log.info(f"  ✅ Upload complete: account {account_idx + 1} → {repo_id}/{hf_path}")
                upload_success_count += 1

                # upsert_video_store only for the first successful account (primary).
                # The SQL RPC also marks video_queue status=ready for this mal/ep/provider/res.
                if not primary_uploaded:
                    hf_direct_url = build_hf_direct_url(username, hf_path)
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
                    log.info(f"  📦 video_store upserted (primary account {account_idx + 1})")

            except Exception as e:
                log.error(f"  ❌ Upload failed for account {account_idx + 1}: {e}")
                # Continue to next account — don't stop all uploads

        if not primary_uploaded:
            raise RuntimeError("Upload failed for all storage accounts")

        log.info(f"  🎉 Job done: {upload_success_count}/{len(_valid_accounts)} accounts uploaded")
        # upsert_video_store already marked queue as ready via SQL.
        # Explicitly update status in case job_id is a real UUID from webhook
        # (upsert_video_store uses mal/ep/provider/res match, not job_id).
        _update_status("ready")

    except Exception as e:
        log.error(f"  ❌ Job failed (mal={mal_id} ep={episode}): {e}")
        _update_status("failed", str(e)[:500])

    finally:
        # Always clean up temp directory
        shutil.rmtree(tmpdir, ignore_errors=True)
        log.debug(f"  🗑️  Cleaned up temp dir: {tmpdir}")


# ── Background polling worker ─────────────────────────────────────────────────

# Semaphore to limit concurrent jobs (avoid OOM on large video files)
_job_semaphore = asyncio.Semaphore(5)

# In-memory set of job keys currently being processed.
# Prevents duplicate concurrent processing of the same (mal_id, episode, provider, resolution).
_active_job_keys: set[str] = set()
_active_job_keys_lock = asyncio.Lock()

# Per-repo upload locks — prevents concurrent uploads to the same HF repo
# which cause 412 Precondition Failed (Git merge conflict).
# Key: "{account_idx}:{repo_id}", Value: asyncio.Lock()
_repo_locks: dict[str, asyncio.Lock] = {}
_repo_locks_meta = asyncio.Lock()


async def _get_repo_lock(account_idx: int, repo_id: str) -> asyncio.Lock:
    """Get or create a per-repo asyncio lock to serialize uploads to the same repo."""
    key = f"{account_idx}:{repo_id}"
    async with _repo_locks_meta:
        if key not in _repo_locks:
            _repo_locks[key] = asyncio.Lock()
        return _repo_locks[key]


_is_running = False


def reset_stale_jobs() -> None:
    """
    On startup: reset jobs stuck in 'downloading' or 'uploading' back to 'pending'.
    These are jobs that were in-flight when the HF Space last restarted/crashed.
    Without this, they stay stuck forever since no worker will pick them up.
    Max age before considering stuck: 2 hours (generous for large files).
    """
    try:
        result = (
            supabase.table("video_queue")
            .select("id, status, updated_at")
            .in_("status", ["downloading", "uploading"])
            .execute()
        )
        stale = result.data or []
        if not stale:
            return

        import datetime
        now = datetime.datetime.now(datetime.timezone.utc)
        reset_count = 0
        for job in stale:
            updated = job.get("updated_at")
            if updated:
                try:
                    # Parse ISO timestamp
                    updated_dt = datetime.datetime.fromisoformat(updated.replace("Z", "+00:00"))
                    age_minutes = (now - updated_dt).total_seconds() / 60
                    if age_minutes < 120:
                        continue  # Still fresh — might be legitimately in progress
                except Exception:
                    pass

            # Reset stale job → pending
            supabase.rpc(
                "update_video_queue_status",
                {"p_id": job["id"], "p_status": "pending", "p_error": None},
            ).execute()
            reset_count += 1

        if reset_count > 0:
            log.info(f"♻️  Reset {reset_count} stale job(s) (downloading/uploading → pending)")
    except Exception as e:
        log.error(f"[Worker] reset_stale_jobs failed: {e}")


async def background_worker() -> None:
    """
    Polls Supabase video_queue every 5 seconds for pending jobs.
    Processes up to 20 jobs concurrently (controlled by semaphore).
    Runs indefinitely as a background asyncio task.

    Scenarios handled:
    - Multiple users fetch same episode → dedup via _active_job_keys
    - Multiple users fetch different episodes → all process concurrently (≤20)
    - HF Space restart mid-job → reset_stale_jobs() on startup resets stuck jobs
    - Mega rate limit → retry with backoff in _download_mega
    - 412 HF conflict → retry with backoff in upload loop
    - Semaphore overflow (>20 concurrent) → excess jobs stay in queue, picked up next poll
    """
    global _is_running
    _is_running = True
    log.info("🚀 Background worker started — polling every 5s")

    # On startup: recover any jobs stuck from previous instance crash/restart
    await asyncio.get_event_loop().run_in_executor(None, reset_stale_jobs)

    while True:
        try:
            jobs = await asyncio.get_event_loop().run_in_executor(None, claim_pending_jobs, 5)

            if jobs:
                log.info(f"📋 Claimed {len(jobs)} pending job(s)")
                tasks = [_run_with_semaphore(job) for job in jobs]
                # gather concurrent — semaphore limits actual concurrency to 20
                await asyncio.gather(*tasks, return_exceptions=True)
            else:
                log.debug("⏳ No pending jobs")

        except Exception as e:
            log.error(f"[Worker] Poll cycle error: {e}")

        await asyncio.sleep(5)


async def _run_with_semaphore(job: dict) -> None:
    """
    Run a single job with:
    1. Deduplication — skip if the same (mal_id, episode, provider, resolution)
       is already being processed in this instance (e.g. 5 concurrent webhooks).
    2. Concurrency control — semaphore limits max parallel jobs to 20.
    """
    job_key = f"{job['mal_id']}:{job['episode']}:{job['provider']}:{job.get('resolution')}"

    async with _active_job_keys_lock:
        if job_key in _active_job_keys:
            log.info(f"  ⏭️  Skipping duplicate in-flight job: {job_key}")
            return
        _active_job_keys.add(job_key)

    try:
        async with _job_semaphore:
            await process_job(job)
    finally:
        async with _active_job_keys_lock:
            _active_job_keys.discard(job_key)


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

    # Fetch the actual queue entry ID so process_job can update status correctly.
    # The entry must already exist (enqueue_video was called by Weaboo API before trigger).
    # If not found yet (race condition), fall back to a sentinel that process_job will handle.
    try:
        queue_row = (
            supabase.table("video_queue")
            .select("id")
            .eq("mal_id", mal_id)
            .eq("episode", episode)
            .eq("provider", provider)
            .eq("resolution", resolution)
            .maybe_single()
            .execute()
        )
        real_id = queue_row.data["id"] if queue_row.data else None
    except Exception:
        real_id = None

    job = {
        "id": real_id,  # real UUID or None — process_job skips status update if None
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
