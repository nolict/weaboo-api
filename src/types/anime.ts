// ── Core scraping types ──────────────────────────────────────────────────────

export interface AnimeItem {
  name: string
  cover: string
  slugs: string
  provider: string
}

export interface ProviderResponse {
  success: boolean
  data: AnimeItem[]
  error?: string
}

export interface NormalizedAnime extends AnimeItem {
  sources: string[]
}

// ── Provider detail-page scrape result ───────────────────────────────────────
// Richer metadata extracted when looking up a single anime page
export interface AnimeDetailScrape {
  title: string // Full H1 title from the detail page
  coverUrl: string // Absolute URL to poster image
  year: number | null
  totalEpisodes: number | null
  slug: string // URL slug for this provider
  provider: string
}

// ── Perceptual hash ───────────────────────────────────────────────────────────
// 256-bit blockhash encoded as a 64-character hex string
export type PHash = string

// ── Jikan / MyAnimeList types ─────────────────────────────────────────────────

export interface JikanAnime {
  mal_id: number
  title: string
  title_english: string | null
  title_japanese: string | null
  episodes: number | null
  year: number | null
  images: {
    jpg: { image_url: string; large_image_url: string }
  }
}

export interface JikanSearchResponse {
  data: JikanAnime[]
  pagination: { has_next_page: boolean; items: { count: number; total: number } }
}

// ── Supabase / Database mapping record ───────────────────────────────────────

export interface AnimeMapping {
  id: string
  mal_id: number
  title_main: string
  slug_samehadaku: string | null
  slug_animasu: string | null
  phash_v1: PHash | null
  release_year: number | null
  total_episodes: number | null
  last_sync: string
}

// ── API response shapes ───────────────────────────────────────────────────────

export interface MappingApiResponse {
  success: boolean
  cached: boolean // true = returned from Supabase, false = freshly enriched
  data: AnimeMapping | null
  error?: string
}

// ── Multi-factor match result (internal) ─────────────────────────────────────

export type MatchMethod = 'phash' | 'jikan_fuzzy' | 'jikan_exact' | 'none'

export interface MatchResult {
  method: MatchMethod
  malId: number | null
  titleMain: string | null
  confidence: number // 0–1
  jikanAnime: JikanAnime | null
}
