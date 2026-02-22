import { Logger } from '../utils/logger'

export async function loggerMiddleware(
  request: Request,
  handler: () => Promise<Response>
): Promise<Response> {
  const startTime = performance.now()
  const { method, url } = request
  const path = new URL(url).pathname

  Logger.info(`➡️  ${method} ${path}`)

  const response = await handler()

  const duration = ((performance.now() - startTime) / 1000).toFixed(3)
  const status = response.status

  if (status >= 200 && status < 300) {
    Logger.success(`⬅️  ${method} ${path} - ${status} (${duration}s)`)
  } else if (status >= 400) {
    Logger.error(`⬅️  ${method} ${path} - ${status} (${duration}s)`)
  } else {
    Logger.info(`⬅️  ${method} ${path} - ${status} (${duration}s)`)
  }

  return response
}
