import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { hammingDistance } from '../services/image'
import type { AnimeMapping, JikanAnimeFull } from '../types/anime'

// ── Singleton Supabase client ────────────────────────────────────────────────
// Credentials are injected via environment variables — never hard-coded.
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (supabaseUrl === undefined || supabaseUrl === '') {
  throw new Error('Missing environment variable: SUPABASE_URL')
}
if (supabaseKey === undefined || supabaseKey === '') {
  throw new Error('Missing environment variable: SUPABASE_SERVICE_ROLE_KEY')
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
})

// ── Table name constants — single source of truth ────────────────────────────
const TABLE = 'anime_mappings'
const MAL_TABLE = 'mal_metadata'

// ── Query helpers ────────────────────────────────────────────────────────────

/**
 * Look up an existing mapping by a provider slug.
 * Returns null when no record exists.
 */
export async function findMappingBySlug(
  slug: string,
  provider: 'samehadaku' | 'animasu' | 'nontonanimeid'
): Promise<AnimeMapping | null> {
  const column =
    provider === 'samehadaku'
      ? 'slug_samehadaku'
      : provider === 'nontonanimeid'
        ? 'slug_nontonanimeid'
        : 'slug_animasu'

  const { data, error } = await supabase.from(TABLE).select('*').eq(column, slug).maybeSingle()

  if (error !== null) throw new Error(`Supabase lookup failed: ${error.message}`)
  return data as AnimeMapping | null
}

/**
 * Look up an existing mapping by MAL ID.
 * Returns null when no record exists.
 */
export async function findMappingByMalId(malId: number): Promise<AnimeMapping | null> {
  const { data, error } = await supabase.from(TABLE).select('*').eq('mal_id', malId).maybeSingle()

  if (error !== null) throw new Error(`Supabase lookup by mal_id failed: ${error.message}`)
  return data as AnimeMapping | null
}

/**
 * Find a record whose stored pHash is within `threshold` Hamming-distance
 * bits of the candidate hash. Uses the PostgreSQL `find_mapping_by_phash`
 * function defined in docs/migration.sql.
 *
 * Returns null gracefully if the RPC function does not exist yet (e.g.
 * migration has not been run), so the pipeline falls through to Jikan.
 */
export async function findMappingByPHash(
  candidateHash: string,
  threshold: number
): Promise<AnimeMapping | null> {
  const { data, error } = await supabase.rpc('find_mapping_by_phash', {
    p_hash: candidateHash,
    p_threshold: threshold,
  })

  if (error !== null) {
    // If the RPC doesn't exist yet, treat as no match rather than crashing
    if (error.message.includes('Could not find the function')) {
      return null
    }
    throw new Error(`Supabase pHash lookup failed: ${error.message}`)
  }

  if (data === null || (Array.isArray(data) && data.length === 0)) return null

  const result = (Array.isArray(data) ? data[0] : data) as AnimeMapping

  // ── JS-side verification ────────────────────────────────────────────────
  // Double-check the Hamming distance in JS to guard against SQL function
  // bugs or stale cached query plans returning wrong results.
  if (result.phash_v1 !== null) {
    const jsDist = hammingDistance(candidateHash, result.phash_v1)
    if (jsDist < 0 || jsDist >= threshold) {
      return null
    }
  }

  return result
}

/**
 * findMalMetadata — Fetch cached MAL full metadata from Supabase by mal_id.
 * Returns null if no record exists yet (cache miss → caller fetches from Jikan).
 */
export async function findMalMetadata(malId: number): Promise<JikanAnimeFull | null> {
  const { data, error } = await supabase
    .from(MAL_TABLE)
    .select('*')
    .eq('mal_id', malId)
    .maybeSingle()

  if (error !== null) throw new Error(`Supabase mal_metadata lookup failed: ${error.message}`)
  if (data === null) return null

  // Re-map DB row → JikanAnimeFull shape
  const row = data as Record<string, unknown>
  return {
    mal_id: row.mal_id as number,
    title: row.title as string,
    title_english: (row.title_english as string | null) ?? null,
    title_japanese: (row.title_japanese as string | null) ?? null,
    synopsis: (row.synopsis as string | null) ?? null,
    type: (row.type as string | null) ?? null,
    episodes: (row.episodes as number | null) ?? null,
    status: (row.status as string | null) ?? null,
    duration: (row.duration as string | null) ?? null,
    score: (row.score as number | null) ?? null,
    rank: (row.rank as number | null) ?? null,
    year: (row.release_year as number | null) ?? null,
    season: (row.season as string | null) ?? null,
    genres: (row.genres as Array<{ mal_id: number; name: string }>) ?? [],
    studios: (row.studios as Array<{ mal_id: number; name: string }>) ?? [],
    images: {
      jpg: {
        image_url: (row.image_url as string) ?? '',
        large_image_url: (row.large_image_url as string) ?? '',
      },
    },
  }
}

/**
 * upsertMalMetadata — Persist full MAL metadata to Supabase via the
 * upsert_mal_metadata RPC. Always overwrites — MAL data is authoritative.
 */
export async function upsertMalMetadata(mal: JikanAnimeFull): Promise<void> {
  const { error } = await supabase.rpc('upsert_mal_metadata', {
    p_mal_id: mal.mal_id,
    p_title: mal.title,
    p_title_english: mal.title_english ?? null,
    p_title_japanese: mal.title_japanese ?? null,
    p_synopsis: mal.synopsis ?? null,
    p_type: mal.type ?? null,
    p_episodes: mal.episodes ?? null,
    p_status: mal.status ?? null,
    p_duration: mal.duration ?? null,
    p_score: mal.score ?? null,
    p_rank: mal.rank ?? null,
    p_release_year: mal.year ?? null,
    p_season: mal.season ?? null,
    p_genres: mal.genres,
    p_studios: mal.studios,
    p_image_url: mal.images.jpg.image_url ?? null,
    p_large_image_url: mal.images.jpg.large_image_url ?? null,
  })

  if (error !== null) throw new Error(`Supabase upsert_mal_metadata failed: ${error.message}`)
}

/**
 * Upsert a mapping record.  Fields that are undefined/null are preserved in
 * existing rows (via the SQL COALESCE logic in upsert_anime_mapping).
 */
export async function upsertMapping(payload: {
  malId: number
  titleMain: string
  slugSamehadaku?: string | null
  slugAnimasu?: string | null
  slugNontonanimeid?: string | null
  phashV1?: string | null
  releaseYear?: number | null
  totalEpisodes?: number | null
}): Promise<AnimeMapping> {
  const { data, error } = await supabase.rpc('upsert_anime_mapping', {
    p_mal_id: payload.malId,
    p_title_main: payload.titleMain,
    p_slug_samehadaku: payload.slugSamehadaku ?? null,
    p_slug_animasu: payload.slugAnimasu ?? null,
    p_slug_nontonanimeid: payload.slugNontonanimeid ?? null,
    p_phash_v1: payload.phashV1 ?? null,
    p_release_year: payload.releaseYear ?? null,
    p_total_episodes: payload.totalEpisodes ?? null,
  })

  if (error !== null) throw new Error(`Supabase upsert failed: ${error.message}`)
  return data as AnimeMapping
}
