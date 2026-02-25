import { Logger } from '../utils/logger'

import { resolveVidhidepro } from './resolvers/vidhidepro'

/**
 * resolveEmbedUrl — Dispatches an embed URL to the correct resolver based on hostname.
 *
 * Returns the direct video/m3u8 URL, or null if:
 * - No resolver is available for this provider
 * - Resolver failed or timed out
 *
 * Supported providers:
 * - vidhidepro.com / vidhidefast.com / callistanise.com → resolveVidhidepro
 */
export async function resolveEmbedUrl(embedUrl: string): Promise<string | null> {
  let hostname: string
  try {
    hostname = new URL(embedUrl).hostname.toLowerCase()
  } catch {
    Logger.warning(`⚠️  resolveEmbedUrl: invalid URL "${embedUrl}"`)
    return null
  }

  // ── Vidhidepro family ────────────────────────────────────────────────────────
  if (
    hostname.includes('vidhidepro') ||
    hostname.includes('vidhidefast') ||
    hostname.includes('callistanise')
  ) {
    return await resolveVidhidepro(embedUrl)
  }

  // ── No resolver available ────────────────────────────────────────────────────
  Logger.debug(`  ℹ️  No resolver for host: ${hostname}`)
  return null
}
