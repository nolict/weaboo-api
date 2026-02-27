import {
  findMalMetadata,
  findMappingByMalId,
  findMappingBySlug,
  upsertMalMetadata,
} from '../lib/supabase'
import { getEpisodeList } from '../services/episodes'
import { getAnimeFullById } from '../services/jikan'
import { resolveMapping, resolveMappingByMalId } from '../services/mapping'
import type { AnimeDetailResponse, MappingApiResponse } from '../types/anime'
import { Logger } from '../utils/logger'

// ── Allowed provider values ───────────────────────────────────────────────────
const VALID_PROVIDERS = ['samehadaku', 'animasu', 'nontonanimeid'] as const
type ProviderName = (typeof VALID_PROVIDERS)[number]

function isValidProvider(value: string): value is ProviderName {
  return (VALID_PROVIDERS as readonly string[]).includes(value)
}

// ── Controller ────────────────────────────────────────────────────────────────

export class AnimeController {
  /**
   * GET /api/v1/anime/:slug?provider=[samehadaku|animasu]
   *
   * Full flow:
   *  1. Validate `provider` query param.
   *  2. Look up Supabase for the incoming slug (mapping cache hit → skip enrichment).
   *  3. On cache miss → enter Enrichment Phase (with Request Lock).
   *  4. Fetch MAL full metadata (permanent in-memory cache keyed by mal_id).
   *  5. Fetch episode lists from both providers concurrently (20-min TTL cache).
   *  6. Return combined response: { mapping, mal, episodes }.
   *
   * The `cached` flag in the response reflects the mapping cache status only
   * (Supabase hit vs freshly enriched). MAL metadata and episode caching are
   * transparent implementation details.
   */
  async getAnime(slug: string, rawProvider: string | null): Promise<Response> {
    // ── Validate provider param ───────────────────────────────────────────────
    if (rawProvider === null || rawProvider === '') {
      return this.errorResponse(
        400,
        'Missing query parameter: provider=[samehadaku|animasu|nontonanimeid]'
      )
    }

    if (!isValidProvider(rawProvider)) {
      return this.errorResponse(
        400,
        `Invalid provider "${rawProvider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`
      )
    }

    const provider: ProviderName = rawProvider

    // ── Validate slug ─────────────────────────────────────────────────────────
    const cleanSlug = slug.trim().toLowerCase()
    if (cleanSlug === '') {
      return this.errorResponse(400, 'Slug cannot be empty')
    }

    Logger.info(`📥 GET /anime/${cleanSlug}?provider=${provider}`)

    try {
      // ── Step 1: Resolve mapping (Supabase cache or fresh enrichment) ─────────
      let mappingCached = false
      let mapping = await findMappingBySlug(cleanSlug, provider)

      if (mapping !== null) {
        Logger.success(`⚡ Mapping cache hit: ${provider}/${cleanSlug} → mal_id=${mapping.mal_id}`)
        mappingCached = true
      } else {
        Logger.info(`🔄 Cache miss for ${provider}/${cleanSlug} — starting enrichment`)
        mapping = await resolveMapping(cleanSlug, provider)

        if (mapping === null) {
          return this.errorResponse(
            404,
            `Could not resolve mapping for ${provider}/${cleanSlug}. ` +
              `The anime may not exist on this provider or MAL could not be identified.`
          )
        }
      }

      // ── Step 2: MAL full metadata (Supabase cache → Jikan fallback) ────────────
      // Supabase is the permanent store — no in-memory layer needed.
      // On cache miss, fetch from Jikan and persist to Supabase (fire-and-forget).
      Logger.debug(`🗄️  Checking Supabase MAL metadata for mal_id=${mapping.mal_id}`)
      let malMeta = await findMalMetadata(mapping.mal_id)

      if (malMeta !== null) {
        Logger.debug(`⚡ MAL metadata cache hit (Supabase) for mal_id=${mapping.mal_id}`)
      } else {
        Logger.debug(
          `🌐 Cache miss — fetching MAL metadata from Jikan for mal_id=${mapping.mal_id}`
        )
        malMeta = await getAnimeFullById(mapping.mal_id)

        if (malMeta !== null) {
          upsertMalMetadata(malMeta).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            Logger.warning(`⚠️  Failed to persist MAL metadata to Supabase: ${msg}`)
          })
          Logger.debug(`📌 MAL metadata saved to Supabase for mal_id=${mapping.mal_id}`)
        } else {
          Logger.warning(`⚠️  MAL full metadata unavailable for mal_id=${mapping.mal_id}`)
        }
      }

      // ── Step 3: Episode lists (20-minute TTL cache, both providers concurrent) ─
      Logger.debug(
        `📺 Fetching episodes — animasu: ${mapping.slug_animasu ?? 'n/a'}, ` +
          `samehadaku: ${mapping.slug_samehadaku ?? 'n/a'}, ` +
          `nontonanimeid: ${mapping.slug_nontonanimeid ?? 'n/a'}`
      )
      const episodes = await getEpisodeList(
        mapping.slug_animasu,
        mapping.slug_samehadaku,
        mapping.slug_nontonanimeid
      )

      // ── Step 4: Compose response ──────────────────────────────────────────────
      const detail: AnimeDetailResponse = {
        mapping,
        mal: malMeta,
        episodes,
      }

      return this.successResponse(detail, mappingCached)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      Logger.error(`❌ AnimeController error for ${provider}/${cleanSlug}:`, error)
      return this.errorResponse(500, msg)
    }
  }

  /**
   * GET /api/v1/anime/mal/:malId
   *
   * Fetch anime detail by MAL ID — identical response shape as getAnime().
   *
   * Flow:
   *  1. Check Supabase for an existing mapping by mal_id (fast path).
   *  2. On cache miss → resolveMappingByMalId() which fetches MAL title from
   *     Jikan then searches both providers to discover slugs.
   *  3. Fetch MAL full metadata + episode lists — same as slug-based flow.
   */
  async getAnimeByMalId(rawMalId: string): Promise<Response> {
    const malId = parseInt(rawMalId, 10)
    if (isNaN(malId) || malId <= 0) {
      return this.errorResponse(400, `Invalid MAL ID "${rawMalId}" — must be a positive integer.`)
    }

    Logger.info(`📥 GET /anime/mal/${malId}`)

    try {
      // ── Step 1: Resolve mapping (Supabase cache or fresh enrichment) ─────────
      let mappingCached = false
      let mapping = await findMappingByMalId(malId)

      if (mapping !== null) {
        Logger.success(`⚡ Mapping cache hit: mal_id=${malId} → "${mapping.title_main}"`)
        mappingCached = true
      } else {
        Logger.info(`🔄 Cache miss for mal_id=${malId} — starting enrichment`)
        mapping = await resolveMappingByMalId(malId)

        if (mapping === null) {
          return this.errorResponse(
            404,
            `Could not resolve mapping for mal_id=${malId}. ` +
              `The anime may not exist on MAL or could not be found on any provider.`
          )
        }
      }

      // ── Step 2: MAL full metadata ─────────────────────────────────────────────
      Logger.debug(`🗄️  Checking Supabase MAL metadata for mal_id=${malId}`)
      let malMeta = await findMalMetadata(malId)

      if (malMeta !== null) {
        Logger.debug(`⚡ MAL metadata cache hit (Supabase) for mal_id=${malId}`)
      } else {
        Logger.debug(`🌐 Cache miss — fetching MAL metadata from Jikan for mal_id=${malId}`)
        malMeta = await getAnimeFullById(malId)

        if (malMeta !== null) {
          upsertMalMetadata(malMeta).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            Logger.warning(`⚠️  Failed to persist MAL metadata to Supabase: ${msg}`)
          })
          Logger.debug(`📌 MAL metadata saved to Supabase for mal_id=${malId}`)
        } else {
          Logger.warning(`⚠️  MAL full metadata unavailable for mal_id=${malId}`)
        }
      }

      // ── Step 3: Episode lists ─────────────────────────────────────────────────
      Logger.debug(
        `📺 Fetching episodes — animasu: ${mapping.slug_animasu ?? 'n/a'}, ` +
          `samehadaku: ${mapping.slug_samehadaku ?? 'n/a'}, ` +
          `nontonanimeid: ${mapping.slug_nontonanimeid ?? 'n/a'}`
      )
      const episodes = await getEpisodeList(
        mapping.slug_animasu,
        mapping.slug_samehadaku,
        mapping.slug_nontonanimeid
      )

      // ── Step 4: Compose response ──────────────────────────────────────────────
      const detail: AnimeDetailResponse = { mapping, mal: malMeta, episodes }
      return this.successResponse(detail, mappingCached)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      Logger.error(`❌ AnimeController error for mal_id=${malId}:`, error)
      return this.errorResponse(500, msg)
    }
  }

  // ── Private response builders ─────────────────────────────────────────────────

  private successResponse(data: AnimeDetailResponse, cached: boolean): Response {
    const body: MappingApiResponse = { success: true, cached, data }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private errorResponse(status: number, message: string): Response {
    const body: MappingApiResponse = {
      success: false,
      cached: false,
      data: null,
      error: message,
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
