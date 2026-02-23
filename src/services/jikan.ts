import axios from 'axios'

import { JIKAN_BASE_URL, TITLE_SIMILARITY_THRESHOLD } from '../config/constants'
import type {
  JikanAnime,
  JikanAnimeFull,
  JikanFullResponse,
  JikanSearchResponse,
} from '../types/anime'
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
 * buildJikanQueries — Produces an ordered list of search queries to try
 * against Jikan for a given raw title. More specific queries come first.
 *
 * Strategy (in order):
 *  1. Raw cleaned title as-is      → "Jigokuraku Season 2"   (most natural for Jikan)
 *  2. Pre-season/cour base title   → "Jigokuraku"             (base series name only)
 *  3. normaliseSeason form         → "Jigokuraku part 2"      (canonical, last resort)
 *
 * Duplicates are removed so we don't hammer Jikan with the same query twice.
 */
function buildJikanQueries(rawTitle: string): string[] {
  const queries: string[] = []
  const seen = new Set<string>()

  const add = (q: string): void => {
    const trimmed = q.trim()
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed)
      queries.push(trimmed)
    }
  }

  // 1. Raw title (cleaned of "Sub Indo" etc but season intact)
  add(rawTitle)

  // 2. Base title — strip everything from "Season/Cour/Part/S\d" onward
  //    e.g. "Jigokuraku Season 2 Sub Indo" → "Jigokuraku"
  const baseTitle = rawTitle
    .replace(/\s*(season|cour|part|s)\s*\d+.*/gi, '')
    .replace(/\s*\d+(st|nd|rd|th)\s*season.*/gi, '')
    .trim()
  add(baseTitle)

  // 3. normaliseSeason form — canonical "part N" wording
  add(AnimeNormalizer.normaliseSeason(rawTitle))

  return queries
}

/**
 * scoreCandidate — Computes the best similarity score between a query and
 * all Jikan title variants (romaji, english, japanese). Both sides are
 * normalised with normaliseSeason before comparison so season suffixes
 * in different formats don't penalise the score.
 */
function scoreCandidate(normalisedQuery: string, candidate: JikanAnime): number {
  const variants = [candidate.title, candidate.title_english, candidate.title_japanese].filter(
    (t): t is string => t !== null && t.length > 0
  )

  // Normalise query for slug-style prefix comparison
  const slugQuery = normalisedQuery
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  let maxSim = 0
  for (const variant of variants) {
    const normVariant = AnimeNormalizer.normaliseSeason(variant)
    const sim = AnimeNormalizer.calculateSimilarity(normalisedQuery, normVariant)

    // Prefix match: query is a prefix of variant or vice-versa
    // e.g. "si-vis" is a prefix of "si-vis-the-sound-of-heroes" → boost to 0.92
    // Guard: query must be ≥5 chars to avoid short generic words ("one", "two")
    // falsely matching long titles ("one piece", etc.)
    const slugVariant = normVariant
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const isPrefixMatch =
      slugQuery.length >= 5 &&
      (slugVariant.startsWith(slugQuery + '-') ||
        slugQuery.startsWith(slugVariant + '-') ||
        slugVariant === slugQuery)

    const finalSim = isPrefixMatch ? Math.max(sim, 0.92) : sim
    if (finalSim > maxSim) maxSim = finalSim
  }
  return maxSim
}

/**
 * searchByTitle — Queries Jikan with multiple query strategies, then ranks
 * candidates by fuzzy-similarity score. Returns the best match above the
 * TITLE_SIMILARITY_THRESHOLD, or null if nothing qualifies.
 *
 * Multi-query strategy prevents failures like:
 *   "Jigokuraku part 2" → 0 Jikan hits  (Jikan doesn't index "part 2" form)
 *   "Jigokuraku Season 2" → ✅ correct hit
 *   "Jigokuraku" → ✅ correct hit (base series, season validated via metadata)
 *
 * @param scrapedYear - Optional year from provider detail page. Used to
 *   tiebreak when multiple candidates share the same top score (e.g. two
 *   entries both named "Monster" — one Music 2025, one TV 2004). The
 *   candidate whose year matches scrapedYear wins the tie.
 */
export async function searchByTitle(
  rawTitle: string,
  scrapedYear: number | null = null
): Promise<JikanAnime | null> {
  try {
    const queries = buildJikanQueries(rawTitle)
    // normaliseSeason form of the raw title — used for scoring regardless of which query found hits
    const normalisedRaw = AnimeNormalizer.normaliseSeason(rawTitle)

    let bestMatch: JikanAnime | null = null
    let bestScore = 0
    // Track whether bestMatch already has a year match — used for tiebreaking
    let bestHasYearMatch = false

    for (const query of queries) {
      const candidates = await searchRaw(query)

      if (candidates.length === 0) {
        Logger.debug(`Jikan returned 0 results for: "${query}"`)
        continue
      }

      for (const candidate of candidates) {
        // Score using the normaliseSeason form of raw title so "Season 2" ↔ "part 2" etc. compare fairly
        const score = scoreCandidate(normalisedRaw, candidate)

        Logger.debug(
          `  [q="${query}"] Candidate: "${candidate.title}" (mal_id: ${candidate.mal_id}) → score: ${score.toFixed(3)}`
        )

        // Year match tiebreaker: when scrapedYear is known, prefer the candidate
        // whose year matches over one that doesn't — even at equal score.
        // e.g. "Monster" query returns both "Monster (Music, 2025)" and "Monster (TV, 2004)".
        // With scrapedYear=2004, the TV 2004 entry wins the tie.
        const candidateYearMatch =
          scrapedYear !== null &&
          candidate.year !== null &&
          Math.abs(candidate.year - scrapedYear) <= 1

        const isBetter =
          score > bestScore ||
          // Tiebreak: same score but this candidate has a year match while current best doesn't
          (score === bestScore && candidateYearMatch && !bestHasYearMatch)

        if (isBetter) {
          bestScore = score
          bestMatch = candidate
          bestHasYearMatch = candidateYearMatch
        }
      }

      // Early exit — no point trying more queries if we already have a strong match
      // AND the year tiebreak is already resolved (year match found or scrapedYear unknown)
      if (bestScore >= TITLE_SIMILARITY_THRESHOLD && (scrapedYear === null || bestHasYearMatch)) {
        break
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
 * getAnimeFullById — Fetch the full MAL entry (with synopsis, studios, genres,
 * trailer, rating, score, etc.) via the /anime/:id/full endpoint.
 *
 * This is the "rich" variant of getAnimeById used for the detail response.
 * Permanent cache is managed in-memory by the caller (AnimeController).
 */
export async function getAnimeFullById(malId: number): Promise<JikanAnimeFull | null> {
  try {
    await jikanThrottle()

    const url = `${JIKAN_BASE_URL}/anime/${malId}/full`
    Logger.debug(`🔍 Jikan fetch full by ID: ${malId}`)

    const response = await axios.get<JikanFullResponse>(url, { timeout: 10_000 })
    return response.data.data
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.warning(`⚠️  Jikan getFullById failed for mal_id ${malId}: ${msg}`)
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
