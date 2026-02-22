import { AnimeAggregator } from '../services/aggregator'
import { Logger } from '../utils/logger'

export class HomeController {
  private readonly aggregator = new AnimeAggregator()

  async getHome(): Promise<Response> {
    try {
      const startTime = performance.now()
      const data = await this.aggregator.aggregateHome()
      const duration = ((performance.now() - startTime) / 1000).toFixed(2)

      Logger.success(`✅ Request completed in ${duration}s`)

      return new Response(
        JSON.stringify({
          success: true,
          count: data.length,
          duration: `${duration}s`,
          data,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Response-Time': `${duration}s`,
          },
        }
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      Logger.error('❌ Request failed', error)

      return new Response(
        JSON.stringify({
          success: false,
          error: errorMessage,
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }
  }
}
