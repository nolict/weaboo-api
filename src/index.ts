import { API_VERSION, PORT } from './config/constants'
import { AnimeController } from './controllers/anime'
import { HomeController } from './controllers/home'
import { SearchController } from './controllers/search'
import { loggerMiddleware } from './middleware/logger'
import { Logger } from './utils/logger'

const homeController = new HomeController()
const animeController = new AnimeController()
const searchController = new SearchController()

// ── Route matchers ────────────────────────────────────────────────────────────
const ANIME_ROUTE_RE = new RegExp(`^/api/${API_VERSION}/anime/([^/]+)$`)
const ANIME_BY_MAL_RE = new RegExp(`^/api/${API_VERSION}/anime/mal/(\\d+)$`)

const server = Bun.serve({
  port: PORT,
  // Enrichment pipeline (scrape + pHash + Jikan + cross-provider) can take
  // up to ~30s on cold start. Default Bun idleTimeout is 10s — raise it.
  idleTimeout: 60,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    return await loggerMiddleware(req, async () => {
      // GET /api/v1/home — aggregate scraper
      if (path === `/api/${API_VERSION}/home`) {
        return await homeController.getHome()
      }

      // GET /api/v1/search?genre=<name|id>&page=<n>
      if (path === `/api/${API_VERSION}/search`) {
        return await searchController.searchByGenre(
          url.searchParams.get('genre'),
          url.searchParams.get('page')
        )
      }

      // GET /api/v1/anime/mal/:malId — fetch by MAL ID (must come BEFORE :slug)
      const malMatch = ANIME_BY_MAL_RE.exec(path)
      if (malMatch !== null) {
        return await animeController.getAnimeByMalId(malMatch[1])
      }

      // GET /api/v1/anime/:slug?provider=[samehadaku|animasu]
      const animeMatch = ANIME_ROUTE_RE.exec(path)
      if (animeMatch !== null) {
        const slug = decodeURIComponent(animeMatch[1])
        const provider = url.searchParams.get('provider')
        return await animeController.getAnime(slug, provider)
      }

      // GET / or /health — service info
      if (path === '/' || path === '/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            service: 'weaboo-api',
            version: API_VERSION,
            endpoints: {
              home: `/api/${API_VERSION}/home`,
              search: `/api/${API_VERSION}/search?genre=<name|id>&page=<n>`,
              anime: `/api/${API_VERSION}/anime/:slug?provider=[samehadaku|animasu]`,
              animeByMalId: `/api/${API_VERSION}/anime/mal/:malId`,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      // 404 fallthrough
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Not Found',
          message: `Endpoint ${path} not found`,
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })
  },
})

Logger.success(`🚀 Weaboo API server running on http://localhost:${server.port}`)
Logger.info(`📍 Home endpoint:  http://localhost:${server.port}/api/${API_VERSION}/home`)
Logger.info(
  `📍 Anime endpoint: http://localhost:${server.port}/api/${API_VERSION}/anime/:slug?provider=samehadaku`
)
Logger.info(`💚 Health check:   http://localhost:${server.port}/health`)
