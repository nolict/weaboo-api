# API Endpoint Specification

## Base URL

```
http://localhost:3000
```

## Endpoints

---

### 1. Health Check

```http
GET /health
GET /
```

**Description**: Returns server health status and available endpoints.

**Response** (200 OK):
```json
{
  "status": "ok",
  "service": "weaboo-api",
  "version": "v1",
  "endpoints": {
    "home": "/api/v1/home",
    "search": "/api/v1/search?genre=<name|id>&page=<n>",
    "anime": "/api/v1/anime/:slug?provider=[samehadaku|animasu]",
    "animeByMalId": "/api/v1/anime/mal/:malId"
  }
}
```

---

### 2. Home Aggregator

```http
GET /api/v1/home
```

**Description**: Aggregates currently-airing anime from all providers (Animasu + Samehadaku) with intelligent deduplication.

**Response** (200 OK):
```json
{
  "success": true,
  "count": 17,
  "duration": "2.49s",
  "data": [
    {
      "name": "Jigokuraku Season 2",
      "cover": "https://...",
      "slugs": "jigokuraku-s2",
      "provider": "animasu",
      "sources": ["animasu", "samehadaku"],
      "providerSlugs": {
        "animasu": "jigokuraku-s2",
        "samehadaku": "jigokuraku-season-2"
      }
    }
  ]
}
```

**Response Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Request success status |
| `count` | number | Number of unique anime returned |
| `duration` | string | Request processing time |
| `data` | array | Array of anime objects |

**Anime Object Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Cleaned anime title |
| `cover` | string | URL to cover image |
| `slugs` | string | Original slug from primary provider |
| `provider` | string | Primary provider name (`animasu` or `samehadaku`) |
| `sources` | string[] | All providers that have this anime |
| `providerSlugs` | object | Per-provider original slug mapping |

**Error Response** (500):
```json
{ "success": false, "error": "Error message here" }
```

---

### 3. Genre Search

```http
GET /api/v1/search?genre=<name|id>&page=<n>
```

**Description**: Search anime by MAL genre. Returns 10 anime per page, sorted by score descending.

**Query Parameters**:
| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `genre` | ✅ Yes | string or number | Genre name (e.g. `action`, `sci-fi`, `slice of life`) or MAL genre ID (e.g. `1`) |
| `page` | ❌ No | number | Page number (default: `1`) |

**Supported Genre Names** (case-insensitive):
`action`, `adventure`, `avant garde`, `award winning`, `boys love`, `comedy`, `drama`, `fantasy`, `girls love`, `gourmet`, `horror`, `mystery`, `romance`, `sci-fi`, `slice of life`, `sports`, `supernatural`, `suspense`, `ecchi`, `erotica`, `hentai`, `mecha`, `music`, `psychological`, `historical`, `military`, `parody`, `samurai`, `school`, `space`, `vampire`, `harem`, `demons`, `game`, `magic`, `martial arts`, `police`, `super power`, `isekai`, `josei`, `kids`, `seinen`, `shoujo`, `shounen`, and more.

**Response** (200 OK):
```json
{
  "success": true,
  "genre_id": 1,
  "page": 1,
  "has_next_page": true,
  "count": 10,
  "data": [
    {
      "mal_id": 55825,
      "name": "Jigokuraku 2nd Season",
      "cover": "https://cdn.myanimelist.net/images/anime/..."
    }
  ]
}
```

**Response Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Request success status |
| `genre_id` | number | Resolved MAL genre ID used for the query |
| `page` | number | Current page number |
| `has_next_page` | boolean | Whether more pages exist |
| `count` | number | Number of items in this page (≤ 10) |
| `data` | array | Array of anime items |

**Anime Item Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `mal_id` | number | MyAnimeList anime ID |
| `name` | string | Anime title (English if available, otherwise romaji) |
| `cover` | string | Cover image URL from MAL CDN |

**Error Responses**:
```json
// 400 — missing genre
{ "success": false, "error": "Missing query parameter: genre" }

// 400 — unknown genre name
{ "success": false, "error": "Unknown genre: \"xyz\". Use a MAL genre name or numeric ID." }

// 400 — invalid page
{ "success": false, "error": "Invalid page number. Must be a positive integer." }

// 500 — Jikan unavailable
{ "success": false, "error": "Genre search failed: ..." }
```

---

### 4. Anime Detail by Slug

```http
GET /api/v1/anime/:slug?provider=[samehadaku|animasu]
```

**Description**: Full anime detail — MAL mapping, MAL full metadata, and episode list from both providers. Triggers enrichment pipeline on cache miss (scrape → pHash → Jikan → cross-provider discovery → Supabase upsert).

**Path Parameters**:
| Parameter | Description |
|-----------|-------------|
| `slug` | Provider-specific anime slug (e.g. `jigokuraku-s2`, `sakamoto-days-cour-2`) |

**Query Parameters**:
| Parameter | Required | Values | Description |
|-----------|----------|--------|-------------|
| `provider` | ✅ Yes | `samehadaku` \| `animasu` | Which provider the slug belongs to |

**Response** (200 OK):
```json
{
  "success": true,
  "cached": false,
  "data": {
    "mapping": {
      "id": "uuid",
      "mal_id": 55825,
      "title_main": "Jigokuraku 2nd Season",
      "slug_samehadaku": "jigokuraku-season-2",
      "slug_animasu": "jigokuraku-s2",
      "phash_v1": "0000...f400",
      "release_year": 2026,
      "total_episodes": 12,
      "last_sync": "2026-02-23T07:18:12Z"
    },
    "mal": {
      "mal_id": 55825,
      "title": "Jigokuraku 2nd Season",
      "title_english": "Hell's Paradise Season 2",
      "title_japanese": "地獄楽 第2期",
      "synopsis": "...",
      "type": "TV",
      "episodes": 12,
      "status": "Currently Airing",
      "duration": "24 min per ep",
      "score": 8.45,
      "rank": 312,
      "year": 2026,
      "season": "winter",
      "genres": [{ "mal_id": 1, "name": "Action" }],
      "studios": [{ "mal_id": 44, "name": "MAPPA" }],
      "images": {
        "jpg": {
          "image_url": "https://cdn.myanimelist.net/...",
          "large_image_url": "https://cdn.myanimelist.net/..."
        }
      }
    },
    "episodes": {
      "animasu": [
        { "label": "Episode 1", "episodeStart": 1, "episodeEnd": 1, "url": "https://v1.animasu.app/nonton-jigokuraku-s2-episode-1/" }
      ],
      "samehadaku": [
        { "label": "Episode 1", "episodeStart": 1, "episodeEnd": 1, "url": "https://v1.samehadaku.how/jigokuraku-season-2-episode-1/" }
      ]
    }
  }
}
```

**Response Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Request success status |
| `cached` | boolean | `true` = returned from Supabase cache, `false` = freshly enriched |
| `data.mapping` | object | Supabase mapping record |
| `data.mal` | object \| null | MAL full metadata (`null` if Jikan unreachable and not cached) |
| `data.episodes.animasu` | array \| null | Episode list from Animasu (`null` if no slug) |
| `data.episodes.samehadaku` | array \| null | Episode list from Samehadaku (`null` if no slug) |

**Episode Entry Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Raw display label (e.g. `"Episode 7"`, `"Sakamoto Days Cour 2 Episode 11"`) |
| `episodeStart` | number | First (or only) episode number |
| `episodeEnd` | number | Last episode number (`= episodeStart` for single episodes) |
| `url` | string | Full watch URL |

**Error Responses**:
```json
// 400 — missing provider
{ "success": false, "cached": false, "data": null, "error": "Missing query parameter: provider=[samehadaku|animasu]" }

// 400 — invalid provider
{ "success": false, "cached": false, "data": null, "error": "Invalid provider \"xyz\". Must be one of: samehadaku, animasu" }

// 404 — mapping not found
{ "success": false, "cached": false, "data": null, "error": "Could not resolve mapping for samehadaku/unknown-slug. ..." }
```

**Caching**:
- **Mapping** — permanent in Supabase (`anime_mappings` table)
- **MAL metadata** — permanent in Supabase (`mal_metadata` table)
- **Episodes** — 20-minute in-memory TTL per provider slug

---

### 5. Anime Detail by MAL ID

```http
GET /api/v1/anime/mal/:malId
```

**Description**: Same response as `/api/v1/anime/:slug`, but discovered via MAL ID instead of a provider slug. Useful after genre search — take a `mal_id` from search results and fetch full detail including provider slugs and episode lists.

**Path Parameters**:
| Parameter | Description |
|-----------|-------------|
| `malId` | MyAnimeList anime ID (numeric) |

**Discovery Flow** (on cache miss):
1. Check Supabase `findMappingByMalId` → cache hit, return immediately
2. Fetch anime title from Jikan `/anime/:id/full`
3. Search Samehadaku using full romaji title → validate via pHash + metadata
4. Search Animasu using MAL title variants → validate
5. Upsert mapping to Supabase
6. Fetch MAL metadata + episode lists → return

**Response**: Identical to `GET /api/v1/anime/:slug` — `{ success, cached, data: { mapping, mal, episodes } }`

**Error Responses**:
```json
// 400 — invalid MAL ID
{ "success": false, "cached": false, "data": null, "error": "Invalid MAL ID" }

// 404 — not found
{ "success": false, "cached": false, "data": null, "error": "Could not resolve mapping for mal_id=99999" }
```

**Note**: Cold-start enrichment (search + scrape + pHash) can take up to ~30s. Subsequent requests for the same MAL ID are instant (Supabase cache hit).

---

### 6. Not Found

```http
GET /any/invalid/path
```

**Response** (404):
```json
{
  "success": false,
  "error": "Not Found",
  "message": "Endpoint /any/invalid/path not found"
}
```

---

## Data Providers

| Provider | Base URL | Bypass |
|----------|----------|--------|
| **Animasu** | `https://v1.animasu.app` | None — native `fetch()` works |
| **Samehadaku** | `https://v1.samehadaku.how` | Cloudflare — must use `axios` |

## Caching Summary

| Data | Storage | TTL |
|------|---------|-----|
| Anime mapping (slug → MAL ID) | Supabase `anime_mappings` | Permanent |
| MAL full metadata | Supabase `mal_metadata` | Permanent |
| Episode lists | In-memory (per provider slug) | 20 minutes |
| Samehadaku homepage | In-memory | 5 minutes |

## Response Headers

All responses include:
- `Content-Type: application/json`
- `X-Response-Time`: Request duration (on `/api/v1/home` success)

## Rate Limiting

Jikan API requests are throttled to **400ms between calls** internally to respect MAL rate limits. No external rate limiting is applied.
