import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { hammingDistance } from '../services/image'
import type { AnimeMapping } from '../types/anime'

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

// ── Table name constant — single source of truth ────────────────────────────
const TABLE = 'anime_mappings'

// ── Query helpers ────────────────────────────────────────────────────────────

/**
 * Look up an existing mapping by a provider slug.
 * Returns null when no record exists.
 */
export async function findMappingBySlug(
  slug: string,
  provider: 'samehadaku' | 'animasu'
): Promise<AnimeMapping | null> {
  const column = provider === 'samehadaku' ? 'slug_samehadaku' : 'slug_animasu'

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
 * Upsert a mapping record.  Fields that are undefined/null are preserved in
 * existing rows (via the SQL COALESCE logic in upsert_anime_mapping).
 */
export async function upsertMapping(payload: {
  malId: number
  titleMain: string
  slugSamehadaku?: string | null
  slugAnimasu?: string | null
  phashV1?: string | null
  releaseYear?: number | null
  totalEpisodes?: number | null
}): Promise<AnimeMapping> {
  const { data, error } = await supabase.rpc('upsert_anime_mapping', {
    p_mal_id: payload.malId,
    p_title_main: payload.titleMain,
    p_slug_samehadaku: payload.slugSamehadaku ?? null,
    p_slug_animasu: payload.slugAnimasu ?? null,
    p_phash_v1: payload.phashV1 ?? null,
    p_release_year: payload.releaseYear ?? null,
    p_total_episodes: payload.totalEpisodes ?? null,
  })

  if (error !== null) throw new Error(`Supabase upsert failed: ${error.message}`)
  return data as AnimeMapping
}
