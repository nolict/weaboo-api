import axios from 'axios'

import { Logger } from '../../utils/logger'

/**
 * resolveYourupload — Resolves a yourupload.com embed URL to a direct CDN video URL.
 *
 * URL format: https://www.yourupload.com/embed/{id}
 *
 * Flow:
 *   1. Fetch embed page via axios
 *   2. Extract video URL from `file: 'https://vidcache.net:...'` inside jwplayerOptions
 *   3. Return CDN URL — vidcache.net redirects (302) to final signed CDN URL with CORS *
 *
 * Note: vidcache.net CDN has `Access-Control-Allow-Origin: *` so no Referer needed.
 * The CDN URL redirects to a signed URL (s{N}.vidcache.net:8166/play/...) which is
 * the actual progressive MP4, supporting HTTP Range requests (seekable).
 *
 * @param embedUrl  Full embed URL, e.g. "https://www.yourupload.com/embed/8Lm2VnIghEpV"
 * @returns         CDN video URL, or null on failure
 */
export async function resolveYourupload(embedUrl: string): Promise<string | null> {
  Logger.debug(`🔍 Resolving yourupload: ${embedUrl}`)

  try {
    // ── Step 1: Fetch embed page ──────────────────────────────────────────────
    const response = await axios.get<string>(embedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        Referer: 'https://www.yourupload.com/',
      },
      timeout: 15000,
      maxRedirects: 5,
    })

    const html = response.data

    // ── Step 2: Extract CDN URL from jwplayerOptions ──────────────────────────
    // The embed page contains a JWPlayer setup with:
    //   var jwplayerOptions = {
    //     file: 'https://vidcache.net:8161/a20260225.../video.mp4',
    //     ...
    //   }
    const fileMatch = /file\s*:\s*['"]([^'"]+)['"]/i.exec(html)

    if (fileMatch === null) {
      Logger.warning('⚠️  yourupload: could not find file URL in jwplayerOptions')
      return null
    }

    const cdnUrl = fileMatch[1]

    if (cdnUrl.length === 0) {
      Logger.warning('⚠️  yourupload: empty file URL extracted')
      return null
    }

    Logger.debug(`  ✅ yourupload resolved: ${cdnUrl.slice(0, 80)}...`)
    return cdnUrl
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warning(`⚠️  yourupload resolver error: ${msg}`)
    return null
  }
}
