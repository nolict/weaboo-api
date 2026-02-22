import { PORT, API_VERSION } from './config/constants'
import { HomeController } from './controllers/home'
import { loggerMiddleware } from './middleware/logger'
import { Logger } from './utils/logger'

const homeController = new HomeController()

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    return await loggerMiddleware(req, async () => {
      if (path === `/api/${API_VERSION}/home`) {
        return await homeController.getHome()
      }

      if (path === '/' || path === '/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            service: 'weaboo-api',
            version: API_VERSION,
            endpoints: {
              home: `/api/${API_VERSION}/home`,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

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
Logger.info(`📍 Main endpoint: http://localhost:${server.port}/api/${API_VERSION}/home`)
Logger.info(`💚 Health check: http://localhost:${server.port}/health`)
