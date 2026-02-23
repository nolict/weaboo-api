import { resolveGenreId } from '../config/constants'
import { searchByGenre } from '../services/jikan'
import type { GenreSearchResponse } from '../types/anime'
import { Logger } from '../utils/logger'

export class SearchController {
  /**
   * GET /api/v1/search?genre=<name|id>&page=<n>
   *
   * Search anime by genre using Jikan MAL data.
   * - genre: genre name (e.g. "action") OR MAL genre ID (e.g. "1")
   * - page: page number, defaults to 1, 10 results per page
   *
   * Response: { success, genre_id, page, has_next_page, count, data[] }
   */
  async searchByGenre(rawGenre: string | null, rawPage: string | null): Promise<Response> {
    // ── Validate genre param ──────────────────────────────────────────────────
    if (rawGenre === null || rawGenre.trim() === '') {
      return this.errorResponse(400, 'Missing query parameter: genre=<name|id>')
    }

    const genreId = resolveGenreId(rawGenre.trim())
    if (genreId === null) {
      return this.errorResponse(
        400,
        `Unknown genre "${rawGenre}". Use a MAL genre name (e.g. "action", "romance") or numeric ID.`
      )
    }

    // ── Validate page param ───────────────────────────────────────────────────
    const page = rawPage !== null && rawPage !== '' ? parseInt(rawPage, 10) : 1
    if (isNaN(page) || page < 1) {
      return this.errorResponse(400, 'Invalid page parameter — must be a positive integer.')
    }

    Logger.info(`📥 GET /search?genre=${rawGenre} (id=${genreId}) page=${page}`)

    try {
      const { items, hasNextPage } = await searchByGenre(genreId, page)

      const body: GenreSearchResponse = {
        success: true,
        genre_id: genreId,
        page,
        has_next_page: hasNextPage,
        count: items.length,
        data: items,
      }

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      Logger.error(`❌ SearchController genre error (genre_id=${genreId}, page=${page}):`, error)
      return this.errorResponse(500, msg)
    }
  }

  private errorResponse(status: number, message: string): Response {
    return new Response(JSON.stringify({ success: false, error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
