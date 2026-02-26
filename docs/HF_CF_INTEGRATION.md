# HuggingFace + Cloudflare Workers Integration

## Overview

Sistem ini mengintegrasikan Weaboo API dengan HuggingFace Dataset sebagai penyimpanan video permanen dan Cloudflare Workers sebagai proxy streaming. Tujuannya adalah agar user tetap bisa menonton video bahkan saat video sedang dalam proses archival ke HuggingFace.

---

## Arsitektur

```
User → GET /api/v1/streaming/:malId/:episode
         │
         ▼
  StreamingController
         │
         ├─ [Cache hit <20min] Skip scrape, cek HF store fresh
         │
         └─ [Cache miss] Scrape provider → cache 20 menit
                  │
                  └─ enrichWithStreamUrls() [ALWAYS runs, per request]
                      │
                      ├─ Cek video_store Supabase (~20ms)
                      │   ├─ [Ada] url_resolved = HF URL, stream = CF/proxy?url=HF_URL
                      │   └─ [Tidak ada] url_resolved = CDN URL, stream = CF/proxy?url=CDN_URL
                      │       └─ enqueue + trigger webhook (jika belum di queue)
                      ▼
             HuggingFace Space (FastAPI + background worker)
                      │
                      ├─ aria2c download video
                      ├─ upload ke SEMUA 5 akun HF Dataset (backup)
                      └─ upsert_video_store() → Supabase
                         (next request → serve dari HF ✅)
```

---

## Komponen

| Komponen | Lokasi | Peran |
|----------|--------|-------|
| Weaboo API (Bun) | `src/` | Scraping, enqueue, trigger webhook |
| Supabase | Cloud | Queue & store state management |
| Cloudflare Workers | `cloudflare-worker/` | Proxy stream (HF atau url_resolved) |
| HuggingFace Space | `huggingface-space/` | Download + upload worker |
| HuggingFace Datasets | 5 akun storage | Penyimpanan video permanen |

---

## Flow Lengkap

### Request Pertama (video belum di-archive)

1. User fetch `GET /api/v1/streaming/55825/1`
2. API scrape Animasu + Samehadaku → dapat embed URLs
3. Resolver decode embed → dapat `url_resolved` (direct m3u8/mp4)
4. Cek `video_store` di Supabase → **tidak ada**
5. Generate `stream` URL: `https://worker.workers.dev/proxy?url=<encoded_url_resolved>`
6. Enqueue ke `video_queue` (status: `pending`)
7. Trigger webhook ke HF Space (`POST /trigger`) — fire and forget
8. **Return response langsung ke user** (stream proxy ke url_resolved)

Di balik layar:
9. HF Space terima webhook → klaim job
10. aria2c download video (multi-thread, 8 connections)
11. Upload ke HF Dataset via `huggingface_hub` (auto Git LFS untuk file >5MB)
12. Upsert `video_store` di Supabase (status: `ready`)

### Request Berikutnya (video sudah di-archive)

1. User fetch `GET /api/v1/streaming/55825/1`
2. Cek `video_store` → **ada**
3. `stream` = `stored.stream_url` (CF Workers → HF Dataset)
4. **Return response** — video served dari HF (lebih stabil, tidak expire)

---

## Response Shape

Field `stream` ditambahkan ke setiap `StreamingServer`:

```json
{
  "success": true,
  "mal_id": 55825,
  "episode": 1,
  "data": {
    "animasu": [
      {
        "provider": "Vidhidepro 720p",
        "url": "https://vidhidepro.com/v/abc123",
        "url_resolved": "https://dramiyos-cdn.com/index-v1-a1.m3u8?t=...",
        "resolution": "720p",
        "stream": "https://weaboo-stream.workers.dev/proxy?url=https%3A%2F%2Fdramiyos-cdn.com%2Findex.m3u8%3Ft%3D..."
      }
    ],
    "samehadaku": [
      {
        "provider": "Mega 720p",
        "url": "https://mega.nz/embed/ABC#KEY",
        "url_resolved": "https://gfs270n.userstorage.mega.co.nz/...",
        "resolution": "720p",
        "stream": "https://weaboo-stream.workers.dev/proxy?url=<encoded_hf_url>"
      }
    ]
  }
}
```

**Field descriptions:**

- **`url`** — embed URL asli (iframe src) dari provider
- **`url_resolved`** — direct video/m3u8 URL setelah resolver decode
- **`stream`** — CF Workers proxy URL format `/proxy?url=<encoded_url_resolved>`
  - Sebelum HF ready: `https://worker.workers.dev/proxy?url=<encoded_CDN_URL>`
  - Setelah HF ready: `https://worker.workers.dev/proxy?url=<encoded_HF_URL>`
  - `null` jika `url_resolved` tidak tersedia

---

## Supabase Schema

### Tabel `video_queue`

Antrian download + upload per episode per provider per resolusi.

| Kolom | Tipe | Keterangan |
|-------|------|------------|
| `id` | UUID PK | Auto-generated |
| `mal_id` | INTEGER | MAL ID anime |
| `episode` | INTEGER | Nomor episode |
| `provider` | VARCHAR(20) | `animasu` atau `samehadaku` |
| `video_url` | TEXT | `url_resolved` dari resolver (direct m3u8/mp4) |
| `resolution` | VARCHAR(10) | `480p`, `720p`, `1080p`, atau NULL |
| `status` | VARCHAR(20) | `pending` → `downloading` → `uploading` → `ready` \| `failed` |
| `retry_count` | INTEGER | Jumlah percobaan ulang (auto-increment saat failed) |
| `error_message` | TEXT | Pesan error terakhir jika status `failed` |
| `created_at` | TIMESTAMPTZ | Waktu pertama kali di-enqueue |
| `updated_at` | TIMESTAMPTZ | Waktu update status terakhir |

**Unique constraint:** `(mal_id, episode, provider, resolution)`

### Tabel `video_store`

Hasil upload yang sudah berhasil masuk ke HuggingFace.

| Kolom | Tipe | Keterangan |
|-------|------|------------|
| `id` | UUID PK | Auto-generated |
| `mal_id` | INTEGER | MAL ID anime |
| `episode` | INTEGER | Nomor episode |
| `provider` | VARCHAR(20) | `animasu` atau `samehadaku` |
| `resolution` | VARCHAR(10) | Resolusi video atau NULL |
| `file_key` | VARCHAR(64) | SHA-256 hash 32 char (filename obfuscated) |
| `hf_account` | INTEGER | Index akun storage 1–5 |
| `hf_repo` | TEXT | Full repo ID, e.g. `username1/weaboo-55825` |
| `hf_path` | TEXT | Path di dalam repo, e.g. `55825/ep1/abc123.mp4` |
| `hf_direct_url` | TEXT | URL raw download HuggingFace |
| `stream_url` | TEXT | CF Workers proxy URL (ini yang dikirim ke user) |
| `created_at` | TIMESTAMPTZ | Waktu upload selesai |

**Unique constraint:** `(mal_id, episode, provider, resolution)`

### SQL RPCs

| RPC | Keterangan |
|-----|------------|
| `enqueue_video(...)` | Upsert entry ke `video_queue`. Jika sudah ada dan `failed` → reset ke `pending`. Jika sudah `ready` → no-op |
| `claim_pending_videos(limit)` | Atomically claim N pending jobs (set status `downloading`, skip locked) — aman untuk multi-instance |
| `update_video_queue_status(id, status, error)` | Update status + error message, auto-increment `retry_count` saat `failed` |
| `upsert_video_store(...)` | Simpan hasil upload ke `video_store` + otomatis mark `video_queue` entry sebagai `ready` |

---

## HuggingFace Space

### Struktur

```
huggingface-space/
  app.py            — FastAPI app + background worker
  requirements.txt  — Python dependencies
  Dockerfile        — Docker image (python:3.11-slim + aria2 + ffmpeg)
  README.md         — HF Space YAML config (sdk: docker, app_port: 7860)
```

### Endpoints

| Endpoint | Method | Keterangan |
|----------|--------|------------|
| `/health` | GET | Health check — status worker + jumlah akun storage |
| `/trigger` | POST | Webhook trigger dari Weaboo API untuk memulai proses segera |
| `/status` | GET | Statistik queue dari Supabase (pending, downloading, ready, dll) |

### POST /trigger Body

```json
{
  "mal_id": 55825,
  "episode": 1,
  "provider": "animasu",
  "video_url": "https://dramiyos-cdn.com/index-v1-a1.m3u8?t=...",
  "resolution": "720p"
}
```

### Background Worker

- Poll Supabase `video_queue` setiap **10 detik**
- Claim hingga **2 jobs concurrent** (via `asyncio.Semaphore(2)`) — hindari OOM untuk file ~2GB
- Jika webhook `/trigger` diterima → proses segera tanpa menunggu poll cycle

### Download Strategy

| Tipe URL | Tool | Keterangan |
|----------|------|------------|
| Direct MP4/MKV | `aria2c` | 8 splits, 8 connections per server, retry 3x |
| HLS (`.m3u8`) | `ffmpeg` | Copy codec (tanpa re-encode), mux ke MP4 container |

### Upload ke HuggingFace

Download sekali, upload ke **SEMUA 5 akun** untuk backup/redundancy:
- Menggunakan `huggingface_hub.HfApi.upload_file()` dengan `path_or_fileobj`
- Library otomatis menggunakan **Git LFS** untuk file >5MB
- File ~2GB → upload via Git LFS pointer, konten di-push via LFS protocol
- Repo dibuat otomatis jika belum ada (`private=True`)
- Akun pertama yang berhasil upload disimpan ke `video_store` sebagai primary untuk CF Workers

### Struktur Folder di HF Dataset

```
weaboo-{mal_id}/          ← satu repo per anime
  {mal_id}/
    ep{episode}/
      {file_key}.mp4      ← nama file = SHA-256 hash (obfuscated)
```

Contoh: `weaboo-55825/55825/ep1/a3f2b8c1d4e5f6a7.mp4`

### File Obfuscation

Nama file di-generate via SHA-256:

```
file_key = SHA-256("{HF_FILE_SALT}:{mal_id}:{episode}:{provider}:{resolution}")[:32]
```

Contoh: salt=`mysecret`, mal_id=`55825`, ep=`1`, provider=`animasu`, res=`720p`
→ `file_key = "a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5"`

Mapping dari `file_key` ke metadata asli disimpan di Supabase `video_store`.

**Catatan:** `HF_FILE_SALT` melayani dual purpose: filename obfuscation + webhook auth.

### Distribusi Akun Storage

Algoritma pemilihan akun (least-used first):
1. Cek jumlah repo di setiap akun via HF API
2. Pilih akun dengan jumlah repo paling sedikit
3. Fallback: `mal_id % 5` (round-robin)

Setiap anime selalu masuk ke akun yang sama (konsisten karena check per `mal_id`).

---

## Cloudflare Workers

### Struktur

```
cloudflare-worker/
  worker.js       — Main Workers script
  wrangler.toml   — Workers config (name, compatibility, secrets)
```

### Routes

| Route | Keterangan |
|-------|------------|
| `GET /proxy?url=<encoded>` | Stream proxy (untuk HLS segment rewriting + MP4 direct proxy) |
| `GET /health` | Worker health check |
| `OPTIONS *` | CORS preflight |

### Logic per Request

```
GET /proxy?url=https%3A%2F%2F...
  → decode URL param
  → proxy stream (forward Range headers)
  → if .m3u8: rewrite segment URLs via /proxy?url= recursively
  → if .mp4: direct proxy with Range support
```

### HLS Rewriting

Untuk stream HLS (`.m3u8`), segment URLs di dalam playlist di-rewrite agar semua request `.ts` juga melalui Worker:

```
# Original m3u8:
index-v1-a1.m3u8
  → seg-000.ts?t=...
  → seg-001.ts?t=...

# After rewrite:
https://worker.workers.dev/proxy?url=https%3A%2F%2Fcdn.example.com%2Fseg-000.ts%3Ft%3D...
```

Ini menghindari CORS error di browser saat video player fetch `.ts` segments.

### Environment Variables (CF Workers)

Set via `wrangler secret put` atau CF Dashboard:

| Variable | Keterangan |
|----------|------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |

---

## Cache Strategy

| Layer | TTL | Keterangan |
|-------|-----|------------|
| Scrape cache | 20 menit | Hasil scrape embed URLs + url_resolved dari provider |
| HF store check | Per-request (fresh) | Query Supabase video_store ~20ms setiap request |

url_resolved otomatis berubah ke HF URL begitu video selesai di-upload — tanpa perlu cache invalidation manual.

---

## Environment Variables

Semua vars ada di `.env.example`. Berikut ringkasannya:

### Weaboo API (Bun)

| Variable | Contoh | Keterangan |
|----------|--------|------------|
| `CLOUDFLARE_WORKERS_URL` | `https://weaboo-stream.abc.workers.dev` | Base URL CF Worker |
| `HF_SPACE_WEBHOOK_URL` | `https://user-weaboo-worker.hf.space` | URL HF Space FastAPI |
| `HF_FILE_SALT` | `openssl rand -hex 32` | Salt untuk obfuscate filename + webhook auth |

### HuggingFace Space

| Variable | Keterangan |
|----------|------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `HF_TOKEN_WORKER` | Token akun yang host Space |
| `HF_TOKEN_STORAGE_1` … `HF_TOKEN_STORAGE_5` | Token 5 akun storage |
| `HF_STORAGE_USERNAME_1` … `HF_STORAGE_USERNAME_5` | Username 5 akun storage |
| `HF_FILE_SALT` | **Harus sama** dengan nilai di Weaboo API (filename obfuscation + webhook auth) |
| `CLOUDFLARE_WORKERS_URL` | Base URL CF Worker (untuk build `stream_url`) |

---

## Deployment Guide

### 1. Supabase Migration

Jalankan SQL migration baru di Supabase SQL Editor:

```sql
-- Paste isi file: supabase/migrations/hf_storage_migration.sql
```

Atau via Supabase CLI:

```bash
supabase db push
```

### 2. Cloudflare Workers

```bash
cd cloudflare-worker

# Install Wrangler CLI (jika belum)
npm install -g wrangler

# Login ke akun CF kamu
wrangler login

# Set secrets (jangan taruh di wrangler.toml!)
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Deploy
wrangler deploy

# Output: https://weaboo-stream.<subdomain>.workers.dev
```

Salin URL worker tersebut ke `.env` sebagai `CLOUDFLARE_WORKERS_URL`.

### 3. HuggingFace Space

1. Buat Space baru di HuggingFace → pilih **Docker** SDK
2. Clone repo Space:
   ```bash
   git clone https://huggingface.co/spaces/{username}/weaboo-worker
   ```
3. Copy isi folder `huggingface-space/` ke repo Space:
   ```bash
   cp huggingface-space/* weaboo-worker/
   cd weaboo-worker
   git add .
   git commit -m "init: weaboo worker"
   git push
   ```
4. Set environment variables di HF Space Settings → **Variables and secrets**:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `HF_TOKEN_WORKER`
   - `HF_TOKEN_STORAGE_1` … `HF_TOKEN_STORAGE_5`
   - `HF_STORAGE_USERNAME_1` … `HF_STORAGE_USERNAME_5`
   - `HF_FILE_SALT`
   - `CLOUDFLARE_WORKERS_URL`

5. Space akan otomatis build dan start. Cek health:
   ```bash
   curl https://{username}-weaboo-worker.hf.space/health
   ```

Salin URL Space ke `.env` sebagai `HF_SPACE_WEBHOOK_URL`.

### 4. Weaboo API

Update `.env`:

```env
CLOUDFLARE_WORKERS_URL=https://weaboo-stream.abc.workers.dev
HF_SPACE_WEBHOOK_URL=https://username-weaboo-worker.hf.space
HF_FILE_SALT=your-secret-salt-here
```

Restart server:

```bash
bun src/index.ts
```

---

## Monitoring & Debugging

### Cek Status Queue

```bash
curl https://{username}-weaboo-worker.hf.space/status
```

Response:
```json
{
  "queue": {
    "pending": 3,
    "downloading": 1,
    "uploading": 0,
    "ready": 42,
    "failed": 2
  },
  "archived": 42
}
```

### Cek Langsung di Supabase

```sql
-- Lihat semua pending jobs
SELECT mal_id, episode, provider, resolution, status, retry_count, created_at
FROM video_queue
WHERE status IN ('pending', 'downloading', 'uploading')
ORDER BY created_at ASC;

-- Lihat video yang sudah di-archive
SELECT mal_id, episode, provider, resolution, hf_account, hf_path, created_at
FROM video_store
ORDER BY created_at DESC
LIMIT 20;

-- Reset failed jobs untuk retry
UPDATE video_queue SET status = 'pending', retry_count = 0 WHERE status = 'failed';
```

### Trigger Manual

```bash
curl -X POST https://{username}-weaboo-worker.hf.space/trigger \
  -H "Authorization: Bearer <HF_FILE_SALT>" \
  -H "Content-Type: application/json" \
  -d '{
    "mal_id": 55825,
    "episode": 1,
    "provider": "animasu",
    "video_url": "https://...",
    "resolution": "720p"
  }'
```

Webhook auth menggunakan `HF_FILE_SALT` sebagai Bearer token.

### CF Workers Logs

```bash
cd cloudflare-worker
wrangler tail
```

---

## Catatan Penting

### HLS vs MP4

- **HLS (`.m3u8`)**: Didownload via `ffmpeg` (copy codec ke MP4 container). aria2c tidak bisa reassemble HLS segments.
- **MP4/Direct**: Didownload via `aria2c` (8 connections, lebih cepat untuk file besar).
- Setelah download, semua file disimpan sebagai `.mp4` di HF Dataset.

### Token Expiry

`url_resolved` dari beberapa provider (Vidhidepro/dramiyos-cdn, Mega, Filedon) punya expiry time (beberapa jam hingga 1 hari). Jika job `failed` karena URL expired:
- URL baru akan di-update otomatis saat user fetch streaming lagi (Weaboo API re-resolve embed URL)
- `enqueue_video()` akan update `video_url` pada entry yang `failed` dan reset ke `pending`

### HuggingFace Free Tier

- Setiap akun HF gratis mendapat **1TB storage** untuk dataset
- File video ~2GB per episode → sekitar **500 episode per akun**
- Dengan 5 akun: kapasitas total **~2500 episode**
- Tambah akun baru: update `HF_STORAGE_ACCOUNT_COUNT` di constants + tambah env vars baru

### HF Space Cold Start

- HF Space (tier gratis) akan "tidur" setelah tidak aktif beberapa menit
- Webhook `/trigger` dari Weaboo API punya timeout **5 detik** — jika Space sedang cold start, webhook gagal tapi job tetap ada di queue
- Background poller (10 detik interval) akan tetap memproses job saat Space aktif kembali
- Upgrade ke **HF Pro** atau gunakan **persistent Space** untuk menghindari cold start

### File Naming & Privacy

- Nama file = 32 karakter hex dari SHA-256 — tidak bisa di-reverse tanpa mengetahui `HF_FILE_SALT`
- Repo dibuat **private** — hanya accessible dengan token HF
- CF Workers mengakses HF via direct URL (bukan HF API) — pastikan repo tetap private dan tidak ada yang bisa menebak URL-nya
- Untuk keamanan ekstra: tambahkan auth token di CF Workers request ke HF jika HF mendukung signed URLs di masa depan
