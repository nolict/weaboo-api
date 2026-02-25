import axios from 'axios'
import * as cheerio from 'cheerio'

import { PROVIDERS } from '../config/constants'
import type { StreamingServer } from '../types/anime'
import { fetchHTML } from '../utils/fetcher'
import { Logger } from '../utils/logger'

import { resolveEmbedUrl } from './resolver'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * extractResolution — Pull quality string from a server label.
 * e.g. "720p [1]" → "720p", "Wibufile 480p" → "480p", "Blogspot 360p" → "360p"
 */
function extractResolution(label: string): string | null {
  const m = /(\d{3,4}p)/i.exec(label)
  return m !== null ? m[1].toLowerCase() : null
}

/**
 * extractServerName — Derive a clean provider/server name from a label.
 *
 * Animasu label format: "480p [1]" → extract host from URL, e.g. "Blogger", "Vidhidepro", "Mega"
 * Samehadaku label format: "Blogspot 360p", "Wibufile 480p", "Mega 1080p"
 */
function serverNameFromUrl(embedUrl: string): string {
  try {
    const { hostname } = new URL(embedUrl)
    // Normalise common CDN/embed hosts
    if (hostname.includes('blogger.com') || hostname.includes('blogspot.com')) return 'Blogger'
    if (hostname.includes('vidhidepro')) return 'Vidhidepro'
    if (hostname.includes('mega.nz')) return 'Mega'
    if (hostname.includes('archive.org')) return 'Archive'
    if (hostname.includes('uservideo')) return 'Uservideo'
    if (hostname.includes('short.icu') || hostname.includes('short.ink')) return 'Shortlink'
    // Generic: capitalise first label of hostname (strip www/cdn prefixes)
    const parts = hostname.replace(/^(www|cdn|v\d+)\./, '').split('.')
    const name = parts[0] ?? hostname
    return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    return 'Unknown'
  }
}

// ── Animasu scraper ───────────────────────────────────────────────────────────

/**
 * scrapeAnimasuStreaming — Scrapes streaming servers from an Animasu episode page.
 *
 * DOM: select.mirror > option[value=base64_iframe_html][data-index]
 *   - value: base64-encoded full <iframe> HTML
 *   - text:  label like "480p [1]", "720p [2]"
 *   - first option (no value) is placeholder — skipped
 *
 * Decoding: Buffer.from(value, 'base64').toString('utf8') → extract src="..." from iframe
 */
async function scrapeAnimasuStreaming(
  slug: string,
  episode: number
): Promise<StreamingServer[] | null> {
  const episodeUrl = `${PROVIDERS.ANIMASU.baseUrl}/nonton-${slug}-episode-${episode}/`
  Logger.debug(`📡 Scraping Animasu streaming: ${episodeUrl}`)

  try {
    const res = await fetch(episodeUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xhtml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
        Referer: PROVIDERS.ANIMASU.baseUrl + '/',
      },
    })

    if (!res.ok) {
      Logger.warning(`⚠️  Animasu episode page returned ${res.status}: ${episodeUrl}`)
      return null
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    const servers: StreamingServer[] = []

    $('select.mirror option').each((_i, el) => {
      const b64 = $(el).attr('value') ?? ''
      if (b64.length === 0) return // skip placeholder

      const label = $(el).text().trim()

      let iframeHtml: string
      try {
        iframeHtml = Buffer.from(b64, 'base64').toString('utf8')
      } catch {
        return
      }

      // Extract src attribute from the decoded iframe HTML
      const srcMatch = /src=["']([^"']+)["']/.exec(iframeHtml)
      if (srcMatch === null) return

      const embedUrl = srcMatch[1].trim()
      if (embedUrl.length === 0) return

      const resolution = extractResolution(label)
      // Server name: derive from URL (more reliable than Animasu's generic labels)
      const serverName = serverNameFromUrl(embedUrl)
      // Compose provider label: "Vidhidepro 720p" or just "Vidhidepro"
      const providerLabel = resolution !== null ? `${serverName} ${resolution}` : serverName

      servers.push({ provider: providerLabel, url: embedUrl, url_resolved: null, resolution })
    })

    // ── Resolve embed URLs concurrently ────────────────────────────────────────
    await Promise.all(
      servers.map(async (server) => {
        server.url_resolved = await resolveEmbedUrl(server.url)
      })
    )

    Logger.debug(`  ✅ Animasu: found ${servers.length} streaming servers`)
    return servers.length > 0 ? servers : null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warning(`⚠️  Animasu streaming scrape failed: ${msg}`)
    return null
  }
}

// ── Samehadaku scraper ────────────────────────────────────────────────────────

/**
 * scrapeShkPlayerOptions — Gets player options from the Samehadaku episode page.
 *
 * DOM: div.east_player_option[data-post][data-nume][data-type] — text = server label
 * Also extracts nonce from inline script for the AJAX call.
 */
interface ShkPlayerOption {
  post: string
  nume: string
  type: string
  label: string
}

interface ShkPageData {
  options: ShkPlayerOption[]
  episodeUrl: string
}

async function fetchShkPageData(slug: string, episode: number): Promise<ShkPageData | null> {
  const episodeUrl = `${PROVIDERS.SAMEHADAKU.baseUrl}/${slug}-episode-${episode}/`
  Logger.debug(`📡 Fetching Samehadaku episode page: ${episodeUrl}`)

  try {
    const html = await fetchHTML(episodeUrl, 30000)
    const $ = cheerio.load(html)

    const options: ShkPlayerOption[] = []
    $('.east_player_option').each((_i, el) => {
      const post = $(el).attr('data-post') ?? ''
      const nume = $(el).attr('data-nume') ?? ''
      const type = $(el).attr('data-type') ?? ''
      const label = $(el).text().trim()
      if (post !== '' && nume !== '') {
        options.push({ post, nume, type, label })
      }
    })

    Logger.debug(`  Samehadaku: options=${options.length}`)
    return { options, episodeUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warning(`⚠️  Samehadaku episode page fetch failed: ${msg}`)
    return null
  }
}

/**
 * fetchShkEmbedUrl — POSTs to Samehadaku's WordPress AJAX endpoint to get the
 * embed URL for a specific player option.
 *
 * Key findings from reference implementation (akbaraditamasp/animbus):
 * - action = 'player_ajax' (NOT 'east_player')
 * - Body must be multipart FormData (NOT URLSearchParams)
 * - No nonce required
 * - Response is raw HTML containing an <iframe src="...">
 */
async function fetchShkEmbedUrl(
  option: ShkPlayerOption,
  episodeUrl: string
): Promise<string | null> {
  const ajaxUrl = `${PROVIDERS.SAMEHADAKU.baseUrl}/wp-admin/admin-ajax.php`

  const form = new FormData()
  form.append('action', 'player_ajax')
  form.append('post', option.post)
  form.append('nume', option.nume)
  form.append('type', option.type)

  try {
    const resp = await axios.post<string>(ajaxUrl, form, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: episodeUrl,
        Origin: PROVIDERS.SAMEHADAKU.baseUrl,
        // Must match the UA used by fetchHTML — CF allows this UA for both GET and POST
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000,
    })

    const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)

    // Extract src from iframe in response HTML
    const srcMatch = /src=["']([^"']+)["']/.exec(raw)
    if (srcMatch !== null) return srcMatch[1].trim()

    // Fallback: plain URL string
    if (raw.startsWith('http')) return raw.trim()

    return null
  } catch {
    return null
  }
}

/**
 * scrapeSamehadakuStreaming — Fetches all streaming servers for a Samehadaku episode.
 *
 * Flow:
 *  1. Fetch episode page → extract player options + nonce
 *  2. For each option, POST to AJAX endpoint → get embed URL
 *  3. Return list of StreamingServer entries
 */
async function scrapeSamehadakuStreaming(
  slug: string,
  episode: number
): Promise<StreamingServer[] | null> {
  const pageData = await fetchShkPageData(slug, episode)
  if (pageData === null || pageData.options.length === 0) return null

  const { options, episodeUrl } = pageData

  // Fetch embed URLs concurrently (with Promise.allSettled so one failure doesn't kill all)
  const results = await Promise.allSettled(
    options.map(async (opt) => {
      const embedUrl = await fetchShkEmbedUrl(opt, episodeUrl)
      return { opt, embedUrl }
    })
  )

  const servers: StreamingServer[] = []

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const { opt, embedUrl } = result.value
    if (embedUrl === null || embedUrl.length === 0) continue

    const resolution = extractResolution(opt.label)
    // Samehadaku labels already contain server name + quality: "Wibufile 720p"
    // Strip trailing quality portion to get pure server name, then reconstruct
    const serverBase = opt.label.replace(/\s*\d{3,4}p\s*$/i, '').trim()
    const providerLabel = serverBase.length > 0 ? opt.label : serverNameFromUrl(embedUrl)

    servers.push({ provider: providerLabel, url: embedUrl, url_resolved: null, resolution })
  }

  // ── Resolve embed URLs concurrently ──────────────────────────────────────────
  await Promise.all(
    servers.map(async (server) => {
      server.url_resolved = await resolveEmbedUrl(server.url)
    })
  )

  Logger.debug(`  ✅ Samehadaku: found ${servers.length} streaming servers`)
  return servers.length > 0 ? servers : null
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * getStreamingLinks — Fetches streaming embed links from both providers concurrently.
 *
 * @param slugAnimasu    - Animasu slug from the mapping (null if not available)
 * @param slugSamehadaku - Samehadaku slug from the mapping (null if not available)
 * @param episode        - Episode number to fetch
 */
export async function getStreamingLinks(
  slugAnimasu: string | null,
  slugSamehadaku: string | null,
  episode: number
): Promise<{ animasu: StreamingServer[] | null; samehadaku: StreamingServer[] | null }> {
  const [animasuResult, samehadakuResult] = await Promise.all([
    slugAnimasu !== null ? scrapeAnimasuStreaming(slugAnimasu, episode) : Promise.resolve(null),
    slugSamehadaku !== null
      ? scrapeSamehadakuStreaming(slugSamehadaku, episode)
      : Promise.resolve(null),
  ])

  return {
    animasu: animasuResult,
    samehadaku: samehadakuResult,
  }
}
