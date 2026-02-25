import { Logger } from '../utils/logger'

import { resolveFiledon } from './resolvers/filedon'
import { resolveMega } from './resolvers/mega'
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
 * - mega.nz → resolveMega
 * - filedon.co → resolveFiledon
 *
 * Providers NOT supported (CDN requires Referer header — not usable by clients directly):
 * - mp4upload.com — CDN cek Referer: https://www.mp4upload.com/
 * - yourupload.com — CDN cek Referer: https://www.yourupload.com/
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

  // ── Mega.nz ──────────────────────────────────────────────────────────────────
  if (hostname === 'mega.nz' || hostname.endsWith('.mega.nz')) {
    return await resolveMega(embedUrl)
  }

  // ── Filedon ──────────────────────────────────────────────────────────────────
  if (hostname === 'filedon.co' || hostname.endsWith('.filedon.co')) {
    return await resolveFiledon(embedUrl)
  }

  // ── No resolver available ────────────────────────────────────────────────────
  Logger.debug(`  ℹ️  No resolver for host: ${hostname}`)
  return null
}
