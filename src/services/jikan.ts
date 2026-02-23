import axios from 'axios'

import { JIKAN_BASE_URL, TITLE_SIMILARITY_THRESHOLD } from '../config/constants'
import type { JikanAnime, JikanSearchResponse } from '../types/anime'
import { Logger } from '../utils/logger'
import { AnimeNormalizer } from '../utils/normalizer'

// ── Jikan rate-limit guard ───────────────────────────────────────────────────
// Jikan enforces ~3 req/s. We serialise requests with a simple async queue
// and a minimum inter-request delay of 400 ms to stay safely under the limit.
let lastRequestTime = 0
const JIKAN_RATE_LIMIT_MS = 400

async function jikanThrottle(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < JIKAN_RATE_LIMIT_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, JIKAN_RATE_LIMIT_MS - elapsed))
  }
  lastRequestTime = Date.now()
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Raw Jikan search — returns up to `limit` anime matching `query`.
 */
async function searchRaw(query: string, limit: number = 5): Promise<JikanAnime[]> {
  await jikanThrottle()

  const url = `${JIKAN_BASE_URL}/anime`
  Logger.debug(`🔍 Jikan search: "${query}"`)

  const response = await axios.get<JikanSearchResponse>(url, {
    params: { q: query, limit, sfw: false },
    timeout: 10_000,
  })

  return response.data.data
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * searchByTitle — Queries Jikan for a title, then ranks candidates by
 * combined fuzzy-similarity score. Returns the best match above the
 * TITLE_SIMILARITY_THRESHOLD, or null if nothing qualifies.
 *
 * Smart normalisation is applied before comparison so that e.g.
 *   "Sakamoto Days Cour 2"  matches  "Sakamoto Days Part 2"
 */
export async function searchByTitle(rawTitle: string): Promise<JikanAnime | null> {
  try {
    // Normalise query title before sending to Jikan
    const normalisedQuery = AnimeNormalizer.normaliseSeason(rawTitle)
    const candidates = await searchRaw(normalisedQuery)

    if (candidates.length === 0) {
      Logger.debug(`Jikan returned 0 results for: "${normalisedQuery}"`)
      return null
    }

    let bestMatch: JikanAnime | null = null
    let bestScore = 0

    for (const candidate of candidates) {
      // Collect all title variants Jikan provides
      const variants = [candidate.title, candidate.title_english, candidate.title_japanese].filter(
        (t): t is string => t !== null && t.length > 0
      )

      // Score = max similarity across all title variants
      let maxSimilarity = 0
      for (const variant of variants) {
        const normVariant = AnimeNormalizer.normaliseSeason(variant)
        const sim = AnimeNormalizer.calculateSimilarity(normalisedQuery, normVariant)
        if (sim > maxSimilarity) maxSimilarity = sim
      }

      Logger.debug(
        `  Candidate: "${candidate.title}" (mal_id: ${candidate.mal_id}) → score: ${maxSimilarity.toFixed(3)}`
      )

      if (maxSimilarity > bestScore) {
        bestScore = maxSimilarity
        bestMatch = candidate
      }
    }

    if (bestScore < TITLE_SIMILARITY_THRESHOLD) {
      Logger.debug(
        `No Jikan match above threshold (${TITLE_SIMILARITY_THRESHOLD}) for: "${rawTitle}"`
      )
      return null
    }

    Logger.success(
      `✅ Jikan match: "${bestMatch?.title}" (mal_id: ${bestMatch?.mal_id}, score: ${bestScore.toFixed(3)})`
    )
    return bestMatch
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.warning(`⚠️  Jikan search failed for "${rawTitle}": ${msg}`)
    return null
  }
}

/**
 * getAnimeById — Fetch a single MAL entry by ID.
 * Used to refresh metadata after a MAL ID is already known.
 */
export async function getAnimeById(malId: number): Promise<JikanAnime | null> {
  try {
    await jikanThrottle()

    const url = `${JIKAN_BASE_URL}/anime/${malId}`
    Logger.debug(`🔍 Jikan fetch by ID: ${malId}`)

    const response = await axios.get<{ data: JikanAnime }>(url, { timeout: 10_000 })
    return response.data.data
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.warning(`⚠️  Jikan getById failed for mal_id ${malId}: ${msg}`)
    return null
  }
}

/**
 * validateMetadataMatch — Confirms a Jikan candidate actually matches
 * a scraped anime by cross-checking year and episode count.
 *
 * Episode tolerance handles the common case where one provider is 1–2
 * episodes ahead of the other (e.g. simulcast vs. delayed upload):
 *
 *   Provider A says 12 episodes → Jikan says 13 → diff = 1 → PASS
 *   Provider A says 12 episodes → Jikan says  1 → diff = 11 → FAIL
 *
 * If either value is null (still-airing / unknown), we give benefit of doubt.
 */
export function validateMetadataMatch(
  jikanAnime: JikanAnime,
  scraped: { year: number | null; totalEpisodes: number | null },
  episodeTolerance: number
): boolean {
  // Year check (skip if either is unknown)
  if (jikanAnime.year !== null && scraped.year !== null) {
    if (Math.abs(jikanAnime.year - scraped.year) > 1) {
      Logger.debug(`Metadata mismatch — year: Jikan=${jikanAnime.year}, scraped=${scraped.year}`)
      return false
    }
  }

  // Episode count check (skip if either is unknown / still-airing)
  if (jikanAnime.episodes !== null && scraped.totalEpisodes !== null) {
    if (Math.abs(jikanAnime.episodes - scraped.totalEpisodes) > episodeTolerance) {
      Logger.debug(
        `Metadata mismatch — episodes: Jikan=${jikanAnime.episodes}, scraped=${scraped.totalEpisodes}`
      )
      return false
    }
  }

  return true
}
