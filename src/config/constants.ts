export const PROVIDERS = {
  SAMEHADAKU: {
    name: 'samehadaku',
    url: 'https://v1.samehadaku.how/anime-terbaru/',
    baseUrl: 'https://v1.samehadaku.how',
  },
  ANIMASU: {
    name: 'animasu',
    url: 'https://v1.animasu.app/anime-sedang-tayang-terbaru/',
    baseUrl: 'https://v1.animasu.app',
  },
} as const

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const API_VERSION = 'v1'
export const PORT = process.env.PORT ?? 3000

// ── Jikan (MyAnimeList unofficial API) ─────────────────────────────────────
export const JIKAN_BASE_URL = 'https://api.jikan.moe/v4'

// ── Matching thresholds ─────────────────────────────────────────────────────
// Hamming distance: max bit-difference between two pHashes to be "same image"
export const PHASH_HAMMING_THRESHOLD = 5
// Levenshtein similarity: minimum ratio [0–1] to confirm title match
export const TITLE_SIMILARITY_THRESHOLD = 0.85
// Episode tolerance: provider A may be N episodes ahead of provider B
export const EPISODE_COUNT_TOLERANCE = 2

// ── Image processing ────────────────────────────────────────────────────────
// blockhash-core produces a 256-bit hash → 64 hex characters
export const PHASH_BITS = 256
export const PHASH_HEX_LENGTH = 64
