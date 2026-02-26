import { CF_WORKERS_BASE_URL, HF_FILE_SALT } from '../config/constants'

/**
 * Build a Cloudflare Workers stream proxy URL for a specific video.
 *
 * URL pattern:
 *   GET {CF_WORKERS_BASE_URL}/proxy?url=<encoded_url>
 *
 * The CF Worker will proxy/stream the given url_resolved directly,
 * handling Range headers for seekable video and rewriting HLS segment URLs.
 *
 * When video is archived in HuggingFace, pass the HF direct URL instead —
 * the stream field will automatically reflect this after HF archival.
 *
 * Returns null if CF_WORKERS_BASE_URL is not configured (env var missing).
 */
export function buildStreamUrl(resolvedUrl: string): string | null {
  if (CF_WORKERS_BASE_URL === '') return null

  const base = CF_WORKERS_BASE_URL.replace(/\/$/, '')
  return `${base}/proxy?url=${encodeURIComponent(resolvedUrl)}`
}

/**
 * Trigger the HuggingFace Space webhook fire-and-forget.
 * Sends a POST request to HF_SPACE_WEBHOOK_URL/trigger with the queue entry details.
 * Errors are swallowed — this must never block or crash the streaming response.
 */
export function triggerHfSpaceWebhook(
  webhookUrl: string,
  payload: {
    mal_id: number
    episode: number
    provider: string
    video_url: string
    resolution: string | null
  }
): void {
  if (webhookUrl === '') return

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (HF_FILE_SALT !== '') {
    headers.Authorization = `Bearer ${HF_FILE_SALT}`
  }

  // Fire-and-forget: do not await, do not throw
  fetch(`${webhookUrl.replace(/\/$/, '')}/trigger`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    // Short timeout so a dead Space doesn't hang the process
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    // Intentionally silent — HF Space may be sleeping (cold start)
  })
}
