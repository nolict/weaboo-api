import axios from 'axios'

import { Logger } from './logger'

const DEFAULT_TIMEOUT_MS = 10000
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])
const MAX_RETRIES = 3

export async function fetchHTML(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  let lastError: Error = new Error('Unknown error')

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Exponential backoff: 0ms, 500ms, 1000ms
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500 * attempt))
      Logger.debug(`🔄 fetchHTML retry ${attempt}/${MAX_RETRIES - 1}: ${url}`)
    }

    try {
      const response = await axios.get(url, {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      })
      return response.data
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const code = error.code ?? ''
        const status = error.response?.status

        // Retry on transient network errors
        if (RETRYABLE_CODES.has(code)) {
          lastError = new Error(`HTTP error! status: unknown - ${error.message}`)
          continue
        }

        // Retry on 5xx server errors (not 4xx — those are permanent)
        if (status !== undefined && status >= 500) {
          lastError = new Error(`HTTP error! status: ${status} - ${error.message}`)
          continue
        }

        if (error.code === 'ECONNABORTED') {
          throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`)
        }
        throw new Error(`HTTP error! status: ${status ?? 'unknown'} - ${error.message}`)
      }
      throw new Error(
        `Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  throw lastError
}
