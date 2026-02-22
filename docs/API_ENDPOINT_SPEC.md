# API Endpoint Specification

## Base URL

```
http://localhost:3000
```

## Endpoints

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
    "home": "/api/v1/home"
  }
}
```

---

### 2. Home Aggregator

```http
GET /api/v1/home
GET /api/home
```

**Description**: Aggregates anime data from all available providers with intelligent deduplication.

**Response** (200 OK):
```json
{
  "success": true,
  "count": 15,
  "duration": "1.24s",
  "data": [
    {
      "name": "One Piece",
      "cover": "https://example.com/image.jpg",
      "slugs": "one-piece",
      "provider": "animasu",
      "sources": ["animasu", "samehadaku"]
    }
  ]
}
```

**Response Fields**:
- `success` (boolean): Request success status
- `count` (number): Number of unique anime returned
- `duration` (string): Request processing time
- `data` (array): Array of anime objects

**Anime Object Schema**:
- `name` (string): Cleaned anime title (no "Sub Indo", "Batch", etc.)
- `cover` (string): Direct URL to cover image
- `slugs` (string): Canonical slug (normalized, lowercase, hyphenated)
- `provider` (string): Primary provider name
- `sources` (array): List of all providers that have this anime

**Error Response** (500 Internal Server Error):
```json
{
  "success": false,
  "error": "Error message here"
}
```

---

### 3. Not Found

```http
GET /any/invalid/path
```

**Response** (404 Not Found):
```json
{
  "success": false,
  "error": "Not Found",
  "message": "Endpoint /any/invalid/path not found"
}
```

---

## Data Providers

### Currently Supported

1. **Animasu** (v1.animasu.app)
   - Status: ✅ Active
   - Selectors: `.bs` container, `a[title]` for titles

2. **Samehadaku** (v1.samehadaku.how)
   - Status: ⚠️ Cloudflare Protected
   - Fallback: API continues with other providers

## Deduplication Logic

The API uses a sophisticated normalization engine:

1. **Title Cleaning**: Removes "Sub Indo", "Batch", "(Season X)", etc.
2. **Canonical Slug**: Converts to lowercase, removes special chars, hyphenates
3. **Similarity Matching**: Levenshtein distance algorithm (85% threshold)
4. **Source Tracking**: Maintains list of all providers for each anime

**Example**:
- Input 1: "One Piece - Sub Indo"
- Input 2: "One Piece (Batch)"
- Output: Single entry with `sources: ["animasu", "samehadaku"]`

## Response Headers

All responses include:
- `Content-Type: application/json`
- `X-Response-Time`: Request duration (on success)

## Rate Limiting

Currently: None (future enhancement planned)

## Caching

Currently: None (future enhancement planned)
