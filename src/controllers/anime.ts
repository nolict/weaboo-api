import { findMappingBySlug } from '../lib/supabase'
import { resolveMapping } from '../services/mapping'
import type { MappingApiResponse } from '../types/anime'
import { Logger } from '../utils/logger'

// ── Allowed provider values ───────────────────────────────────────────────────
const VALID_PROVIDERS = ['samehadaku', 'animasu'] as const
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
   *  2. Look up Supabase for the incoming slug (cache hit → return immediately).
   *  3. On cache miss → enter Enrichment Phase (with Request Lock to prevent
   *     duplicate concurrent scrapes for the same slug).
   *  4. Return the full "Triangle Mapping" or a structured error.
   *
   * Episode tolerance is handled transparently inside MappingService:
   * if one provider is 1–2 eps ahead, the system still confirms the match
   * and notes the discrepancy via `total_episodes` from Jikan (authoritative).
   */
  async getAnime(slug: string, rawProvider: string | null): Promise<Response> {
    // ── Validate provider param ─────────────────────────────────────────────
    if (rawProvider === null || rawProvider === '') {
      return this.errorResponse(400, 'Missing query parameter: provider=[samehadaku|animasu]')
    }

    if (!isValidProvider(rawProvider)) {
      return this.errorResponse(
        400,
        `Invalid provider "${rawProvider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`
      )
    }

    const provider: ProviderName = rawProvider

    // ── Validate slug ───────────────────────────────────────────────────────
    const cleanSlug = slug.trim().toLowerCase()
    if (cleanSlug === '') {
      return this.errorResponse(400, 'Slug cannot be empty')
    }

    Logger.info(`📥 GET /anime/${cleanSlug}?provider=${provider}`)

    try {
      // ── Step 1: Check Supabase cache ──────────────────────────────────────
      const cached = await findMappingBySlug(cleanSlug, provider)

      if (cached !== null) {
        Logger.success(`⚡ Cache hit: ${provider}/${cleanSlug} → mal_id=${cached.mal_id}`)
        return this.successResponse(cached, true)
      }

      Logger.info(`🔄 Cache miss for ${provider}/${cleanSlug} — starting enrichment`)

      // ── Step 2: Enrichment Phase (with Request Lock) ──────────────────────
      const mapping = await resolveMapping(cleanSlug, provider)

      if (mapping === null) {
        return this.errorResponse(
          404,
          `Could not resolve mapping for ${provider}/${cleanSlug}. ` +
            `The anime may not exist on this provider or MAL could not be identified.`
        )
      }

      return this.successResponse(mapping, false)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      Logger.error(`❌ AnimeController error for ${provider}/${cleanSlug}:`, error)
      return this.errorResponse(500, msg)
    }
  }

  // ── Private response builders ───────────────────────────────────────────────

  private successResponse(data: MappingApiResponse['data'], cached: boolean): Response {
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
