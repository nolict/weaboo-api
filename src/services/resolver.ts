import { Logger } from '../utils/logger'

import { resolveFiledon } from './resolvers/filedon'
import { resolveMega } from './resolvers/mega'
import { resolveMp4upload } from './resolvers/mp4upload'
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
 * - mp4upload.com → resolveMp4upload
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

  // ── Mp4upload ─────────────────────────────────────────────────────────────────
  if (hostname === 'www.mp4upload.com' || hostname === 'mp4upload.com') {
    return await resolveMp4upload(embedUrl)
  }

  // ── No resolver available ────────────────────────────────────────────────────
  Logger.debug(`  ℹ️  No resolver for host: ${hostname}`)
  return null
}
