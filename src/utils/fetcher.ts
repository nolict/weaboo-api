import axios from 'axios'

const DEFAULT_TIMEOUT_MS = 10000

export async function fetchHTML(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
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
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`)
      }
      throw new Error(
        `HTTP error! status: ${error.response?.status ?? 'unknown'} - ${error.message}`
      )
    }
    throw new Error(
      `Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}
