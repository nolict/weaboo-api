import { findMappingByMalId } from '../lib/supabase'
import { getStreamingLinks } from '../services/streaming'
import type { StreamingResponse, StreamingServer } from '../types/anime'
import { Logger } from '../utils/logger'

export class StreamingController {
  /**
   * GET /api/v1/streaming/:malId/:episode
   *
   * Returns embed streaming links from both providers for a specific episode.
   *
   * Prerequisites:
   *  - The anime must already be mapped (i.e. user has fetched /api/v1/anime/:slug
   *    or /api/v1/anime/mal/:malId at least once so the Supabase mapping exists).
   *  - Episode number must be a positive integer.
   *
   * Flow:
   *  1. Validate malId + episode params.
   *  2. Look up Supabase mapping by mal_id to get provider slugs.
   *  3. Scrape streaming servers from both providers concurrently.
   *  4. Return { animasu: [...], samehadaku: [...] } — each provider null if
   *     no slug exists for it or scraping fails.
   */
  async getStreaming(rawMalId: string, rawEpisode: string): Promise<Response> {
    // ── Validate params ────────────────────────────────────────────────────────
    const malId = parseInt(rawMalId, 10)
    if (isNaN(malId) || malId <= 0) {
      return this.errorResponse(
        400,
        malId,
        0,
        `Invalid MAL ID "${rawMalId}" — must be a positive integer.`
      )
    }

    const episode = parseInt(rawEpisode, 10)
    if (isNaN(episode) || episode <= 0) {
      return this.errorResponse(
        400,
        malId,
        0,
        `Invalid episode "${rawEpisode}" — must be a positive integer.`
      )
    }

    Logger.info(`📥 GET /streaming/${malId}/${episode}`)

    try {
      // ── Step 1: Resolve slugs from Supabase mapping ────────────────────────
      const mapping = await findMappingByMalId(malId)

      if (mapping === null) {
        return this.errorResponse(
          404,
          malId,
          episode,
          `No mapping found for mal_id=${malId}. ` +
            `Please fetch /api/v1/anime/mal/${malId} first to create the mapping.`
        )
      }

      Logger.debug(
        `🗺️  Mapping found: animasu=${mapping.slug_animasu ?? 'n/a'}, ` +
          `samehadaku=${mapping.slug_samehadaku ?? 'n/a'}, ` +
          `nontonanimeid=${mapping.slug_nontonanimeid ?? 'n/a'}`
      )

      // ── Step 2: Scrape streaming links from all providers ──────────────────
      const streamingData = await getStreamingLinks(
        mapping.slug_animasu,
        mapping.slug_samehadaku,
        mapping.slug_nontonanimeid,
        episode,
        malId
      )

      return this.successResponse(malId, episode, streamingData)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      Logger.error(`❌ StreamingController error for mal_id=${malId} ep=${episode}:`, error)
      return this.errorResponse(500, malId, episode, msg)
    }
  }

  // ── Private response builders ──────────────────────────────────────────────

  private successResponse(
    malId: number,
    episode: number,
    data: {
      animasu: StreamingServer[] | null
      samehadaku: StreamingServer[] | null
      nontonanimeid: StreamingServer[] | null
    }
  ): Response {
    const body: StreamingResponse = {
      success: true,
      mal_id: malId,
      episode,
      data,
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private errorResponse(status: number, malId: number, episode: number, message: string): Response {
    const body: StreamingResponse = {
      success: false,
      mal_id: malId,
      episode,
      data: null,
      error: message,
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
