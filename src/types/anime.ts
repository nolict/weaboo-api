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
  providerSlugs: Record<string, string> // provider → original slug from that provider
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

// ── Jikan full metadata (from /anime/:id/full endpoint) ──────────────────────

export interface JikanGenre {
  mal_id: number
  name: string
}

export interface JikanStudio {
  mal_id: number
  name: string
}

export interface JikanAnimeFull {
  mal_id: number
  title: string
  title_english: string | null
  title_japanese: string | null
  synopsis: string | null
  type: string | null // TV, Movie, OVA, ONA, Special, Music
  episodes: number | null
  status: string | null // Airing, Finished Airing, Not yet aired
  duration: string | null // e.g. "24 min per ep"
  score: number | null
  rank: number | null
  year: number | null
  season: string | null // spring, summer, fall, winter
  genres: JikanGenre[]
  studios: JikanStudio[]
  images: {
    jpg: { image_url: string; large_image_url: string }
  }
}

export interface JikanFullResponse {
  data: JikanAnimeFull
}

// ── Episode types ─────────────────────────────────────────────────────────────

/**
 * Represents a single episode entry from a provider.
 * For multi-episode cards (e.g. "Episode 115-120"), episodeStart !== episodeEnd.
 */
export interface EpisodeEntry {
  label: string // Raw label from provider, e.g. "Episode 7" or "Episode 115-120"
  episodeStart: number // First (or only) episode number
  episodeEnd: number // Last episode number (same as episodeStart for single episodes)
  url: string // Full URL to watch page
}

export interface ProviderEpisodeList {
  provider: string
  episodes: EpisodeEntry[]
  cachedAt: number // timestamp for TTL tracking
}

export interface EpisodeList {
  animasu: EpisodeEntry[] | null
  samehadaku: EpisodeEntry[] | null
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

export interface AnimeDetailResponse {
  mapping: AnimeMapping
  mal: JikanAnimeFull | null
  episodes: EpisodeList
}

export interface MappingApiResponse {
  success: boolean
  cached: boolean // true = returned from Supabase, false = freshly enriched
  data: AnimeDetailResponse | null
  error?: string
}

// ── Genre search response shapes ─────────────────────────────────────────────

/** Single anime item returned by genre search */
export interface GenreSearchItem {
  mal_id: number
  name: string
  cover: string
}

export interface GenreSearchResponse {
  success: boolean
  genre_id: number
  page: number
  has_next_page: boolean
  count: number
  data: GenreSearchItem[]
}

// ── Streaming server types ────────────────────────────────────────────────────

/**
 * A single streaming server/mirror entry.
 * - provider: server name, e.g. "Vidhidepro 720p", "Mega 1080p"
 * - url:      embed URL (iframe src)
 * - resolution: quality string extracted from label, e.g. "720p", "480p", null if unknown
 */
export interface StreamingServer {
  provider: string
  url: string
  resolution: string | null
}

export interface StreamingList {
  animasu: StreamingServer[] | null
  samehadaku: StreamingServer[] | null
}

export interface StreamingResponse {
  success: boolean
  mal_id: number
  episode: number
  data: StreamingList | null
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
