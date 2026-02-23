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

// ── MAL Genre list (from Jikan /genres/anime) ───────────────────────────────
// Maps lowercase genre name → MAL genre ID for name-based lookups.
// Source: https://api.jikan.moe/v4/genres/anime
export const MAL_GENRES: Record<string, number> = {
  action: 1,
  adventure: 2,
  'avant garde': 5,
  'award winning': 46,
  'boys love': 28,
  comedy: 4,
  drama: 8,
  fantasy: 10,
  'girls love': 26,
  gourmet: 47,
  horror: 14,
  mystery: 7,
  romance: 22,
  'sci-fi': 24,
  'slice of life': 36,
  sports: 30,
  supernatural: 37,
  suspense: 41,
  ecchi: 9,
  erotica: 49,
  hentai: 12,
  'adult cast': 50,
  anthropomorphic: 51,
  cgdct: 52,
  childcare: 53,
  'combat sports': 54,
  delinquents: 55,
  detective: 39,
  educational: 56,
  'gag humor': 57,
  historical: 13,
  idols: 58,
  isekai: 44,
  iyashikei: 63,
  'love polygon': 64,
  'magical sex shift': 65,
  'mahou shoujo': 66,
  'martial arts': 17,
  mecha: 18,
  medical: 67,
  military: 38,
  music: 19,
  mythology: 6,
  'organized crime': 68,
  'otaku culture': 69,
  parody: 20,
  performing: 70,
  pets: 71,
  psychological: 40,
  racing: 3,
  reincarnation: 72,
  'reverse harem': 73,
  'romantic subtext': 74,
  samurai: 21,
  school: 23,
  showbiz: 75,
  space: 29,
  'strategy game': 11,
  'super power': 31,
  survival: 76,
  'team sports': 77,
  'time travel': 78,
  vampire: 32,
  'video game': 79,
  'visual arts': 80,
  workplace: 48,
}

/**
 * Resolve a genre input (name string OR numeric ID string) to a MAL genre ID.
 * Returns null if the genre is not recognised.
 *
 * Examples:
 *   resolveGenreId('action') → 1
 *   resolveGenreId('1')      → 1
 *   resolveGenreId('sci-fi') → 24
 */
export function resolveGenreId(input: string): number | null {
  const trimmed = input.trim().toLowerCase()

  // Numeric ID — validate it's a positive integer
  if (/^\d+$/.test(trimmed)) {
    const id = parseInt(trimmed, 10)
    return id > 0 ? id : null
  }

  // Name lookup
  return MAL_GENRES[trimmed] ?? null
}

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

// ── Cache TTLs ───────────────────────────────────────────────────────────────
// MAL metadata cache: permanent (in-memory for process lifetime, Supabase persists forever)
// Episode list cache: 20 minutes (TTL in milliseconds)
export const EPISODE_CACHE_TTL_MS = 20 * 60 * 1000
