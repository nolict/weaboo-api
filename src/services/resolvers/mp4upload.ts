import axios from 'axios'

import { Logger } from '../../utils/logger'

/**
 * resolveMp4upload — Resolves a mp4upload.com embed URL to a direct MP4 URL.
 *
 * URL format: https://www.mp4upload.com/embed-{id}.html
 *
 * Flow:
 *   1. Fetch embed page via axios (Bun native fetch also works)
 *   2. Extract video src from `player.src({ type: "video/mp4", src: "..." })` pattern
 *   3. Return direct CDN MP4 URL (hosted on a{N}.mp4upload.com)
 *
 * Note: The resolved URL is a direct progressive MP4 download that supports
 * HTTP Range requests (seekable). No encryption or packing involved.
 *
 * @param embedUrl  Full embed URL, e.g. "https://www.mp4upload.com/embed-vmr3rjexl9cp.html"
 * @returns         Direct CDN MP4 URL, or null on failure
 */
export async function resolveMp4upload(embedUrl: string): Promise<string | null> {
  Logger.debug(`🔍 Resolving mp4upload: ${embedUrl}`)

  try {
    // ── Step 1: Fetch embed page ──────────────────────────────────────────────
    const response = await axios.get<string>(embedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: 15000,
      maxRedirects: 5,
      decompress: true,
    })

    const html = response.data

    // ── Step 2: Extract direct MP4 URL ───────────────────────────────────────
    // The embed page contains a videojs player.src() call like:
    //   player.src({ type: "video/mp4", src: "https://a4.mp4upload.com:183/d/.../video.mp4" });
    const srcMatch = /player\.src\s*\(\s*\{[^}]*src\s*:\s*["']([^"']+)["']/.exec(html)

    if (srcMatch === null) {
      Logger.warning('⚠️  mp4upload: could not find player.src() in embed page')
      return null
    }

    const cdnUrl = srcMatch[1]

    if (cdnUrl.length === 0) {
      Logger.warning('⚠️  mp4upload: empty src URL extracted')
      return null
    }

    Logger.debug(`  ✅ mp4upload resolved: ${cdnUrl.slice(0, 80)}...`)
    return cdnUrl
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warning(`⚠️  mp4upload resolver error: ${msg}`)
    return null
  }
}
