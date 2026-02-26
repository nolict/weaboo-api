# Deployment Guide — HuggingFace + Cloudflare Workers

Panduan ini menjelaskan cara deploy sistem video archival step-by-step dari nol.
Urutan deploy: **Supabase → Cloudflare Workers → HuggingFace Space → Weaboo API**.

---

## Yang Kamu Butuhkan

Sebelum mulai, siapkan akun-akun berikut:

| Akun | Jumlah | Gratis? | Link Daftar |
|------|--------|---------|-------------|
| Supabase | 1 | ✅ Ya | https://supabase.com |
| Cloudflare | 1 | ✅ Ya (Workers free 100k req/hari) | https://cloudflare.com |
| HuggingFace | 6 | ✅ Ya | https://huggingface.co/join |

> **6 akun HuggingFace:** 1 akun untuk host Space (worker), 5 akun untuk penyimpanan video.
> Bisa pakai email berbeda atau email + alias (e.g. Gmail + dots trick).

---

## Langkah 1 — Supabase: Jalankan Migration

### 1.1 Buka Supabase Dashboard

1. Login ke https://supabase.com
2. Pilih project kamu (atau buat project baru jika belum ada)
3. Di sidebar kiri, klik **SQL Editor**
4. Klik tombol **New query**

### 1.2 Jalankan Migration

1. Buka file `supabase/migrations/hf_storage_migration.sql` di code editor kamu
2. Copy **seluruh isi file** tersebut
3. Paste ke SQL Editor Supabase
4. Klik tombol **Run** (atau tekan `Ctrl+Enter`)
5. Pastikan muncul pesan sukses — tidak ada error merah

Migration ini membuat:
- Tabel `video_queue` (antrian download)
- Tabel `video_store` (hasil upload ke HF)
- 4 stored procedures (RPCs) untuk operasi queue

### 1.3 Ambil Supabase Credentials

Kamu butuh 2 nilai ini untuk dipakai di langkah-langkah berikutnya:

1. Di sidebar kiri Supabase, klik **Project Settings** → **API**
2. Catat/copy dua nilai ini:

```
Project URL   → contoh: https://abcdefghij.supabase.co
               → ini akan jadi nilai SUPABASE_URL

service_role  → contoh: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6...
(bukan anon!) → ini akan jadi nilai SUPABASE_SERVICE_ROLE_KEY
```

> ⚠️ Jangan gunakan key `anon` — harus `service_role` agar bisa insert/update dari server.
> ⚠️ Jangan pernah expose `service_role` key di frontend atau commit ke Git.

---

## Langkah 2 — Cloudflare Workers: Deploy Proxy

### 2.1 Install Wrangler CLI

Buka terminal di folder project kamu:

```bash
npm install -g wrangler
```

Verifikasi berhasil:

```bash
wrangler --version
# output: ⛅️ wrangler X.X.X
```

### 2.2 Login ke Cloudflare

```bash
wrangler login
```

Browser akan terbuka → login ke akun Cloudflare kamu → klik **Allow**.
Kembali ke terminal, harusnya muncul: `Successfully logged in`.

### 2.3 Masuk ke Folder Worker

```bash
cd cloudflare-worker
```

### 2.4 Set Secret Environment Variables

> **Note:** CF Workers hanya butuh `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` jika kamu masih pakai route `/stream/:malId/:episode`. Dengan implementasi terbaru, stream URL format adalah `/proxy?url=<encoded_url>` — CF Worker tidak perlu query Supabase sama sekali. Kamu bisa deploy tanpa set secrets ini.

Jika ingin set secrets (opsional):

```bash
wrangler secret put SUPABASE_URL
```
Saat diminta, paste nilai `Project URL` dari Langkah 1.3, tekan Enter.

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```
Saat diminta, paste nilai `service_role` key dari Langkah 1.3, tekan Enter.

### 2.5 Deploy Worker

```bash
wrangler deploy
```

Output akan menampilkan URL worker kamu:

```
✅ Deployed weaboo-stream to https://weaboo-stream.YOUR-SUBDOMAIN.workers.dev
```

**Catat URL ini** — contoh: `https://weaboo-stream.abcdef.workers.dev`
Ini akan jadi nilai `CLOUDFLARE_WORKERS_URL`.

### 2.6 Test Worker

```bash
curl https://weaboo-stream.YOUR-SUBDOMAIN.workers.dev/health
```

Expected response:
```json
{"status": "ok", "worker": "weaboo-stream"}
```

---

## Langkah 3 — HuggingFace: Siapkan Token

Kamu butuh mendapatkan token dari semua 6 akun HuggingFace.

### 3.1 Cara Buat Token (Lakukan untuk SEMUA 6 akun)

Untuk setiap akun HuggingFace (1 akun worker + 5 akun storage):

1. Login ke https://huggingface.co dengan akun tersebut
2. Klik foto profil (pojok kanan atas) → **Settings**
3. Di sidebar kiri, klik **Access Tokens**
4. Klik **New token**
5. Isi:
   - **Name:** `weaboo-worker` (atau nama bebas)
   - **Role:** pilih **Write** (wajib, agar bisa buat repo dan upload file)
6. Klik **Generate a token**
7. **Copy token-nya sekarang** — tidak bisa dilihat lagi setelah ditutup!

Token formatnya: `hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 3.2 Catat Semua Token dan Username

Buat catatan seperti ini (jangan disimpan di tempat public):

```
Akun Worker (host Space):
  Username : nama-akun-worker
  Token    : hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Akun Storage 1:
  Username : nama-akun-storage-1
  Token    : hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Akun Storage 2:
  Username : nama-akun-storage-2
  Token    : hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Akun Storage 3:
  Username : nama-akun-storage-3
  Token    : hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Akun Storage 4:
  Username : nama-akun-storage-4
  Token    : hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Akun Storage 5:
  Username : nama-akun-storage-5
  Token    : hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Langkah 4 — HuggingFace Space: Deploy Worker App

### 4.1 Buat Space Baru

Gunakan **akun worker** (bukan akun storage):

1. Login ke HuggingFace dengan **akun worker**
2. Klik **+** di pojok kanan atas → **New Space**
3. Isi form:
   - **Space name:** `weaboo-worker`
   - **License:** `mit` (atau bebas)
   - **Select the Space SDK:** pilih **Docker**
   - **Docker template:** pilih **Blank**
   - **Space hardware:** `CPU basic · FREE` (gratis)
   - **Visibility:** pilih **Private** (agar tidak bisa diakses orang lain)
4. Klik **Create Space**

Space kosong akan terbuat. URL Space kamu:
`https://huggingface.co/spaces/nama-akun-worker/weaboo-worker`

### 4.2 Upload File ke Space

Ada dua cara — pilih yang lebih mudah:

#### Cara A: Upload via Web UI (Termudah)

1. Buka Space kamu di browser
2. Klik tab **Files**
3. Klik **Add file** → **Upload files**
4. Upload file-file berikut dari folder `huggingface-space/` di project kamu:
   - `app.py`
   - `requirements.txt`
   - `Dockerfile`
   - `README.md`
5. Klik **Commit changes to main**

#### Cara B: Upload via Git

```bash
# Install git-lfs jika belum ada
git lfs install

# Clone repo Space
git clone https://huggingface.co/spaces/nama-akun-worker/weaboo-worker
cd weaboo-worker

# Copy semua file dari project
cp ../huggingface-space/app.py .
cp ../huggingface-space/requirements.txt .
cp ../huggingface-space/Dockerfile .
cp ../huggingface-space/README.md .

# Push
git add .
git commit -m "init: weaboo worker"
git push
```

Setelah push, Space akan otomatis build Docker image. Proses ini butuh **3–5 menit**.

### 4.3 Set Environment Variables di Space

1. Buka Space kamu: `https://huggingface.co/spaces/nama-akun-worker/weaboo-worker`
2. Klik tab **Settings**
3. Scroll ke bawah → **Variables and secrets**
4. Klik **New secret** untuk setiap nilai berikut (gunakan **secret** bukan variable, agar tidak terlihat):

| Name | Value |
|------|-------|
| `SUPABASE_URL` | URL dari Langkah 1.3 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key dari Langkah 1.3 |
| `HF_TOKEN_WORKER` | Token akun worker dari Langkah 3.2 |
| `HF_TOKEN_STORAGE_1` | Token akun storage 1 dari Langkah 3.2 |
| `HF_TOKEN_STORAGE_2` | Token akun storage 2 dari Langkah 3.2 |
| `HF_TOKEN_STORAGE_3` | Token akun storage 3 dari Langkah 3.2 |
| `HF_TOKEN_STORAGE_4` | Token akun storage 4 dari Langkah 3.2 |
| `HF_TOKEN_STORAGE_5` | Token akun storage 5 dari Langkah 3.2 |
| `HF_STORAGE_USERNAME_1` | Username akun storage 1 |
| `HF_STORAGE_USERNAME_2` | Username akun storage 2 |
| `HF_STORAGE_USERNAME_3` | Username akun storage 3 |
| `HF_STORAGE_USERNAME_4` | Username akun storage 4 |
| `HF_STORAGE_USERNAME_5` | Username akun storage 5 |
| `HF_FILE_SALT` | Random secret — generate: `openssl rand -hex 32`. **Harus sama** dengan nilai di Weaboo API `.env`. Dipakai untuk: (1) obfuscate nama file, (2) autentikasi webhook /trigger |
| `CLOUDFLARE_WORKERS_URL` | URL CF Worker dari Langkah 2.5 |

Setelah mengisi semua secret, Space akan **restart otomatis** untuk apply perubahan.

### 4.4 Verifikasi Space Berjalan

Tunggu 1–2 menit setelah Space restart, lalu:

```bash
curl https://nama-akun-worker-weaboo-worker.hf.space/health
```

> **Format URL Space:** `https://{username}-{space-name}.hf.space`
> Contoh: username=`johndoe`, space=`weaboo-worker` → `https://johndoe-weaboo-worker.hf.space`

Expected response:
```json
{
  "status": "ok",
  "worker_running": true,
  "storage_accounts": 5,
  "cf_workers_configured": true
}
```

**Catat URL Space ini** — ini akan jadi nilai `HF_SPACE_WEBHOOK_URL`.

---

## Langkah 5 — Weaboo API: Isi File .env

### 5.1 Buat File .env

Di root folder project, copy dari template:

```bash
cp .env.example .env
```

### 5.2 Isi Semua Nilai

Buka file `.env` dan isi nilainya:

```env
PORT=3000
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
CLOUDFLARE_WORKERS_URL=...
HF_SPACE_WEBHOOK_URL=...
HF_FILE_SALT=...
```

> ⚠️ **Penting:** Nilai `HF_FILE_SALT` di `.env` harus **identik** dengan yang diset di HF Space secrets.
> Jika berbeda, filename yang di-generate akan berbeda dan video tidak bisa ditemukan.

### 5.3 Jalankan Weaboo API

```bash
bun src/index.ts
```

---

## Langkah 6 — Test End-to-End

### 6.1 Test Streaming Endpoint

Pertama, pastikan ada mapping di Supabase (fetch anime dulu):

```bash
# Fetch anime untuk memastikan mapping tersimpan di Supabase
curl http://localhost:3000/api/v1/anime/mal/55825

# Lalu test streaming — ganti malId dan episode sesuai data yang ada
curl http://localhost:3000/api/v1/streaming/55825/1
```

### 6.2 Periksa Response

Response sekarang harusnya ada field `stream` di setiap server:

```json
{
  "success": true,
  "mal_id": 55825,
  "episode": 1,
  "data": {
    "animasu": [
      {
        "provider": "Vidhidepro 720p",
        "url": "https://vidhidepro.com/v/...",
        "url_resolved": "https://dramiyos-cdn.com/index-v1-a1.m3u8?t=...",
        "resolution": "720p",
        "stream": "https://weaboo-stream.abc.workers.dev/stream/55825/1/animasu/720p"
      }
    ]
  }
}
```

Jika `stream` muncul → integrasi CF Workers berhasil ✅

### 6.3 Cek Queue di HF Space

```bash
curl https://nama-akun-worker-weaboo-worker.hf.space/status
```

Harusnya ada entry `pending` atau `downloading`:

```json
{
  "queue": {
    "pending": 1,
    "downloading": 0,
    "ready": 0
  },
  "archived": 0
}
```

### 6.4 Tunggu Video Selesai Di-archive

Background worker HF Space akan proses queue secara otomatis. Waktu yang dibutuhkan tergantung ukuran video:
- Video 200MB: ~5–10 menit
- Video 2GB: ~30–60 menit

Monitor progress:

```bash
# Poll status setiap 30 detik
watch -n 30 "curl -s https://nama-akun-worker-weaboo-worker.hf.space/status"
```

Setelah status berubah ke `ready`, fetch streaming lagi — `stream` URL sekarang akan serve dari HuggingFace.

---

## Troubleshooting

### `stream` selalu null di response

- Pastikan `CLOUDFLARE_WORKERS_URL` sudah diisi di `.env`
- Pastikan `url_resolved` tidak null (resolver harus berhasil decode embed URL)

### HF Space `/health` tidak bisa diakses

- Space mungkin sedang **cold start** (tidur) — tunggu 1–2 menit lalu coba lagi
- Cek tab **Logs** di HF Space untuk melihat error saat build/start

### Worker Cloudflare return 404 untuk semua stream

- Pastikan Supabase secrets sudah diset di CF Worker (`wrangler secret list` untuk cek)
- Pastikan migration SQL sudah dijalankan (tabel `video_queue` dan `video_store` harus ada)

### Job di queue stuck di `downloading` terus

- Space mungkin crash saat proses — cek **Logs** di HF Space
- Kemungkinan `url_resolved` sudah expired (token video habis)
- Reset job di Supabase SQL Editor:
  ```sql
  UPDATE video_queue SET status = 'pending' WHERE status = 'downloading';
  ```

### `HF_FILE_SALT` berbeda antara API dan Space

- `HF_FILE_SALT` melayani dua fungsi: (1) obfuscate nama file di HF storage, (2) autentikasi webhook requests ke `/trigger` endpoint
- Akibatnya: `file_key` yang di-generate berbeda → video tidak bisa ditemukan di store, dan webhook akan rejected
- Fix: samakan nilai `HF_FILE_SALT` di `.env` dan di HF Space secrets → restart keduanya

### HF Space gagal upload (error Git LFS)

- Pastikan file `huggingface-space/README.md` ada dan punya YAML header yang benar
- Pastikan token yang diset punya permission **Write** (bukan Read)

---

## Cache Strategy (Streaming)

Weaboo API menggunakan dua layer cache untuk streaming:

| Layer | TTL | Scope |
|-------|-----|-------|
| Scrape cache | 20 menit | Embed URLs + url_resolved dari provider |
| HF store check | Selalu fresh | Cek Supabase video_store per request (~20ms) |

**Cara kerja:**
- Cache hit (20 menit): Skip scrape, langsung cek HF store
- Jika video sudah di HF: `url_resolved` otomatis update ke HF URL
- Jika belum di HF: `url_resolved` tetap URL CDN embed asli
- Tidak perlu invalidate cache manual — update terjadi otomatis di request berikutnya setelah upload selesai

---

## Catatan: Repo HuggingFace Dibuat Public

Dataset repo di HuggingFace dibuat **public** secara sengaja. Ini agar Cloudflare Workers bisa langsung stream video dari HF raw URL tanpa perlu menyimpan token HF di Workers.

**Keamanan tetap terjaga karena:**
- Nama file = 32 karakter SHA-256 hash (contoh: `a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5.mp4`)
- Tidak ada index atau listing yang mudah dibaca manusia
- Tanpa tahu `HF_FILE_SALT` yang kamu gunakan, tidak ada yang bisa menebak nama file
- URL video tidak pernah di-expose langsung ke user — semua akses lewat CF Workers

**Yang user lihat hanya:**
```
https://weaboo-stream.abc.workers.dev/stream/55825/1/animasu/720p
```
Bukan URL HuggingFace-nya secara langsung.
