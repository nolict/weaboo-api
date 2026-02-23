import { PORT, API_VERSION } from './config/constants'
import { AnimeController } from './controllers/anime'
import { HomeController } from './controllers/home'
import { loggerMiddleware } from './middleware/logger'
import { Logger } from './utils/logger'

const homeController = new HomeController()
const animeController = new AnimeController()

// ── Route matcher for /api/v1/anime/:slug ────────────────────────────────────
const ANIME_ROUTE_RE = new RegExp(`^/api/${API_VERSION}/anime/([^/]+)$`)

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
              anime: `/api/${API_VERSION}/anime/:slug?provider=[samehadaku|animasu]`,
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
