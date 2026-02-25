import axios from 'axios'

import { Logger } from '../../utils/logger'

/**
 * resolveFiledon — Resolves a filedon.co embed URL to a direct signed CDN URL.
 *
 * URL format: https://filedon.co/embed/{slug}
 *
 * Flow:
 *   1. Fetch embed page (Inertia.js SPA — data embedded in `data-page` attribute)
 *   2. Parse `data-page` JSON → extract `props.url`
 *   3. Return signed Cloudflare R2 URL (direct MP4, supports HTTP Range / seeking)
 *
 * Note: The resolved URL has ~1 hour expiry (R2 signed URL, max-age=3600).
 * File is progressive MP4 (no HLS), but seekable via HTTP Range requests.
 *
 * @param embedUrl  Full embed URL, e.g. "https://filedon.co/embed/zCHQCvTT7X"
 * @returns         Signed R2 CDN URL, or null on failure
 */
export async function resolveFiledon(embedUrl: string): Promise<string | null> {
  Logger.debug(`🔍 Resolving filedon: ${embedUrl}`)

  try {
    // ── Step 1: Fetch embed page ──────────────────────────────────────────────
    const response = await axios.get<string>(embedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 15000,
      maxRedirects: 5,
    })

    const html = response.data

    // ── Step 2: Parse Inertia.js `data-page` attribute ────────────────────────
    // Format: <div id="app" data-page="{...JSON...}">
    // JSON is HTML-entity encoded (e.g. &quot; → ")
    const match = /data-page="([^"]*)"/.exec(html)
    if (match === null) {
      Logger.warning('⚠️  filedon: data-page attribute not found')
      return null
    }

    // Decode HTML entities then parse JSON
    const raw = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#039;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')

    let pageData: FiledonPageData
    try {
      pageData = JSON.parse(raw) as FiledonPageData
    } catch {
      Logger.warning('⚠️  filedon: failed to parse data-page JSON')
      return null
    }

    // ── Step 3: Extract signed CDN URL from props ─────────────────────────────
    const cdnUrl = pageData?.props?.url
    if (typeof cdnUrl !== 'string' || cdnUrl.length === 0) {
      Logger.warning('⚠️  filedon: no url in props (file may require subscription or be private)')
      return null
    }

    Logger.debug(`  ✅ filedon resolved: ${cdnUrl.slice(0, 80)}...`)
    return cdnUrl
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warning(`⚠️  filedon resolver error: ${msg}`)
    return null
  }
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface FiledonPageData {
  component: string
  props: {
    url: string | null
    files: {
      id: number
      name: string
      mime_type: string
      size: number
      is_subscription: boolean
      status: string
    } | null
    vast_url: string | null
    image_url: string | null
    slug: string
  }
}
