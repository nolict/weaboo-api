import axios from 'axios'
import * as cheerio from 'cheerio'

import { PROVIDERS, HF_SPACE_WEBHOOK_URL, EPISODE_CACHE_TTL_MS } from '../config/constants'
import { findVideoStore, enqueueVideo, findVideoQueueEntry } from '../lib/videoQueue'
import type { StreamingServer } from '../types/anime'
import { fetchHTML } from '../utils/fetcher'
import { Logger } from '../utils/logger'

import { buildStreamUrl, triggerHfSpaceWebhook } from './cfWorkers'
import { getEpisodeUrl } from './episodes'
import { resolveEmbedUrl } from './resolver'

// ── Streaming cache ───────────────────────────────────────────────────────────

interface StreamingCacheEntry {
  // Raw scraped servers — cached 20 min, HF store always checked fresh per-request
  animasu: StreamingServer[] | null
  samehadaku: StreamingServer[] | null
  nontonanimeid: StreamingServer[] | null
  expiresAt: number
}

/**
 * Two-tier streaming cache:
 * - Key: `${malId}:${episode}`
 * - TTL: EPISODE_CACHE_TTL_MS (20 min) for raw scrape results (embed URLs + url_resolved)
 * - HF store always checked fresh per-request (Supabase ~20ms) — no permanent TTL needed
 * - url_resolved updates automatically to HF URL once video_store has the entry
 */
const streamingCache = new Map<string, StreamingCacheEntry>()

/**
 * Invalidate the streaming cache for a specific malId+episode.
 * Called when HuggingFace upload completes so the next fetch
 * immediately reflects the new HF url_resolved.
 */
export function invalidateStreamingCache(malId: number, episode: number): void {
  const cacheKey = `${malId}:${episode}`
  const deleted = streamingCache.delete(cacheKey)
  if (deleted) {
    Logger.debug(`  🗑️  Streaming cache invalidated: ${cacheKey}`)
  }
}

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
  // First try to get the real episode URL from the episode list (DOM-scraped, always correct).
  // The stored slug_animasu may be a canonical/shortened form (e.g. "mf-ghost-s3") that
  // doesn't match Animasu's actual URL slug (e.g. "mf-ghost-season-3").
  // Falling back to the constructed URL ensures streaming works even when the DB slug differs.
  const realUrl = await getEpisodeUrl(slug, PROVIDERS.ANIMASU.name, episode)
  const episodeUrl = realUrl ?? `${PROVIDERS.ANIMASU.baseUrl}/nonton-${slug}-episode-${episode}/`
  if (realUrl !== null) {
    Logger.debug(`📡 Scraping Animasu streaming (URL from episode list): ${episodeUrl}`)
  } else {
    Logger.debug(`📡 Scraping Animasu streaming (constructed URL): ${episodeUrl}`)
  }

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

      servers.push({
        provider: providerLabel,
        url: embedUrl,
        url_resolved: null,
        resolution,
        stream: null,
      })
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

// ── NontonAnimeid scraper ─────────────────────────────────────────────────────

/**
 * NontonAnimeid player option from the episode page.
 * DOM: ul.tabs1.player > li[data-post][data-type][data-nume] > span (label)
 */
interface NaidPlayerOption {
  post: string
  type: string
  nume: string
  label: string
}

interface NaidPageData {
  options: NaidPlayerOption[]
  episodeUrl: string
  nonce: string
}

/**
 * fetchNaidPageData — Fetches the NontonAnimeid episode page and extracts:
 * - player options (data-post, data-type, data-nume, label)
 * - nonce from the base64-encoded inline script `var kotakajax = {...}`
 */
async function fetchNaidPageData(slug: string, episode: number): Promise<NaidPageData | null> {
  // First try to get real URL from episode cache (correct slug)
  const realUrl = await getEpisodeUrl(slug, PROVIDERS.NONTONANIMEID.name, episode)
  const episodeUrl = realUrl ?? `${PROVIDERS.NONTONANIMEID.baseUrl}/${slug}-episode-${episode}/`

  if (realUrl !== null) {
    Logger.debug(`📡 Fetching NontonAnimeid episode (URL from episode list): ${episodeUrl}`)
  } else {
    Logger.debug(`📡 Fetching NontonAnimeid episode (constructed URL): ${episodeUrl}`)
  }

  try {
    const res = await fetch(episodeUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    })

    if (!res.ok) {
      Logger.warning(`⚠️  NontonAnimeid episode page returned ${res.status}: ${episodeUrl}`)
      return null
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Extract nonce from inline base64-encoded script:
    // <script id="ajax_video-js-extra" src="data:text/javascript;base64,...">
    // Decoded content: var kotakajax={"url":"...","nonce":"XXXX","..."}
    const b64Match = html.match(
      /ajax_video-js-extra"[^>]*src="data:text\/javascript;base64,([^"]+)"/
    )
    let nonce = ''
    if (b64Match !== null) {
      try {
        const decoded = Buffer.from(b64Match[1], 'base64').toString('utf8')
        const nonceMatch = /"nonce"\s*:\s*"([^"]+)"/.exec(decoded)
        nonce = nonceMatch?.[1] ?? ''
      } catch {
        // nonce stays empty
      }
    }

    if (nonce === '') {
      Logger.warning(`⚠️  NontonAnimeid: could not extract nonce from ${episodeUrl}`)
      return null
    }

    // Parse player options: ul.tabs1.player > li[data-post][data-type][data-nume]
    const options: NaidPlayerOption[] = []
    $('ul.tabs1.player li[data-post][data-type][data-nume]').each((_i, el) => {
      const post = $(el).attr('data-post') ?? ''
      const type = $(el).attr('data-type') ?? ''
      const nume = $(el).attr('data-nume') ?? ''
      const label = $(el).find('span').first().text().trim()
      if (post !== '' && type !== '' && nume !== '') {
        options.push({ post, type, nume, label })
      }
    })

    Logger.debug(`  NontonAnimeid: options=${options.length}, nonce=${nonce}`)
    return { options, episodeUrl, nonce }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warning(`⚠️  NontonAnimeid episode page fetch failed: ${msg}`)
    return null
  }
}

/**
 * fetchNaidEmbedUrl — POSTs to NontonAnimeid's WordPress AJAX endpoint.
 *
 * Key findings:
 * - action = 'player_ajax'
 * - Requires nonce (from kotakajax.nonce in inline base64 script)
 * - Requires Origin header (server checks it)
 * - Response is raw HTML containing <iframe src="...">
 */
async function fetchNaidEmbedUrl(
  option: NaidPlayerOption,
  episodeUrl: string,
  nonce: string
): Promise<string | null> {
  const ajaxUrl = `${PROVIDERS.NONTONANIMEID.baseUrl}/wp-admin/admin-ajax.php`

  const form = new FormData()
  form.append('action', 'player_ajax')
  form.append('post', option.post)
  form.append('nume', option.nume)
  form.append('type', option.type)
  form.append('nonce', nonce)

  try {
    const res = await fetch(ajaxUrl, {
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Origin: PROVIDERS.NONTONANIMEID.baseUrl,
        Referer: episodeUrl,
      },
      body: form,
    })

    if (!res.ok) return null

    const raw = await res.text()

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
 * scrapeNontonAnimeidStreaming — Fetches all streaming servers for a NontonAnimeid episode.
 *
 * Flow:
 *  1. Fetch episode page → extract player options + nonce
 *  2. For each option, POST to AJAX endpoint → get embed URL
 *  3. Resolve embed URLs → direct CDN URLs
 */
async function scrapeNontonAnimeidStreaming(
  slug: string,
  episode: number
): Promise<StreamingServer[] | null> {
  const pageData = await fetchNaidPageData(slug, episode)
  if (pageData === null || pageData.options.length === 0) return null

  const { options, episodeUrl, nonce } = pageData

  // Fetch embed URLs concurrently
  const results = await Promise.allSettled(
    options.map(async (opt) => {
      const embedUrl = await fetchNaidEmbedUrl(opt, episodeUrl, nonce)
      return { opt, embedUrl }
    })
  )

  const servers: StreamingServer[] = []

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const { opt, embedUrl } = result.value
    if (embedUrl === null || embedUrl.length === 0) continue

    const resolution = extractResolution(opt.label)
    // Label format: "S-Lokal-c", "S-Kotakvideo" — derive server name from URL
    const serverName = serverNameFromUrl(embedUrl)
    const providerLabel = resolution !== null ? `${serverName} ${resolution}` : serverName

    servers.push({
      provider: providerLabel,
      url: embedUrl,
      url_resolved: null,
      resolution,
      stream: null,
    })
  }

  // ── Resolve embed URLs concurrently ──────────────────────────────────────────
  await Promise.all(
    servers.map(async (server) => {
      server.url_resolved = await resolveEmbedUrl(server.url)
    })
  )

  Logger.debug(`  ✅ NontonAnimeid: found ${servers.length} streaming servers`)
  return servers.length > 0 ? servers : null
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
  // Use the real episode URL from the episode list if available (same slug-mismatch fix as Animasu)
  const realUrl = await getEpisodeUrl(slug, PROVIDERS.SAMEHADAKU.name, episode)
  const episodeUrl = realUrl ?? `${PROVIDERS.SAMEHADAKU.baseUrl}/${slug}-episode-${episode}/`
  if (realUrl !== null) {
    Logger.debug(`📡 Fetching Samehadaku episode page (URL from episode list): ${episodeUrl}`)
  } else {
    Logger.debug(`📡 Fetching Samehadaku episode page (constructed URL): ${episodeUrl}`)
  }

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

    servers.push({
      provider: providerLabel,
      url: embedUrl,
      url_resolved: null,
      resolution,
      stream: null,
    })
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

// ── HuggingFace + Cloudflare Workers integration ──────────────────────────────

/**
 * enrichWithStreamUrls — After scraping, for each StreamingServer that has a
 * url_resolved, we:
 *   1. Check Supabase video_store — if already archived in HuggingFace:
 *      - set stream = CF Workers → HF URL
 *      - set url_resolved = HF direct URL (so client can see it changed)
 *   2. Otherwise, build a CF Workers proxy URL that streams url_resolved directly.
 *   3. Fire-and-forget: enqueue + trigger HF Space webhook (only if not already queued).
 *
 * Returns true if ALL servers with url_resolved are fully archived in HF
 * (so the caller can promote the cache entry to permanent).
 */
async function enrichWithStreamUrls(
  servers: StreamingServer[],
  malId: number,
  episode: number,
  provider: string
): Promise<boolean> {
  let allArchivedInHf = true

  await Promise.allSettled(
    servers.map(async (server) => {
      // Only process servers that have a resolved direct URL
      if (server.url_resolved === null) {
        server.stream = null
        // Servers with no url_resolved don't count against HF archival check
        return
      }

      try {
        // Step 1: Check if already archived in HuggingFace
        const stored = await findVideoStore(malId, episode, provider, server.resolution)

        if (stored !== null) {
          // Video is ready in HuggingFace — update url_resolved to HF URL + wrap in CF proxy
          server.url_resolved = stored.hf_direct_url
          server.stream = buildStreamUrl(stored.hf_direct_url)
          Logger.debug(`  📦 HF archived: ${stored.hf_direct_url}`)
          return
        }

        // Not yet archived — cache cannot be permanent
        allArchivedInHf = false

        // Step 2: Build CF Workers proxy URL wrapping the current url_resolved directly
        server.stream = buildStreamUrl(server.url_resolved)

        // Step 3: Check if already queued (pending/downloading/uploading) — skip if so
        const existing = await findVideoQueueEntry(malId, episode, provider, server.resolution)
        if (existing !== null) {
          Logger.debug(
            `  ⏭️  Already queued (${existing.status}): mal=${malId} ep=${episode} ${provider}`
          )
          return
        }

        // Step 4: Determine the correct URL to enqueue for download.
        // For Mega: enqueue the original embed URL (mega.nz/embed/NODE#KEY) — it contains
        // the AES key in the hash fragment that mega.py needs for decryption.
        // Enqueueing the CDN url_resolved (gfs...mega.co.nz) would download encrypted bytes.
        // For all other providers: enqueue url_resolved (direct CDN URL).
        // Providers where url_resolved has ASN-bound or expiring tokens:
        // - Mega: CDN URL has no AES key → need embed URL with #KEY fragment
        // - Vidhidepro: HLS token is ASN-bound to API server IP → re-resolve in HF Space
        // For these, enqueue embed URL so HF Space resolves fresh with its own ASN.
        const needsEmbedUrl = (u: string): boolean => {
          try {
            const { hostname } = new URL(u)
            return (
              hostname.includes('mega.nz') ||
              hostname.includes('mega.co.nz') ||
              hostname.includes('vidhidepro') ||
              hostname.includes('vidhidefast') ||
              hostname.includes('callistanise')
            )
          } catch {
            return false
          }
        }
        const downloadUrl = needsEmbedUrl(server.url) ? server.url : server.url_resolved

        void enqueueVideo(malId, episode, provider, downloadUrl, server.resolution)

        // Step 5: Trigger HF Space webhook for immediate processing
        triggerHfSpaceWebhook(HF_SPACE_WEBHOOK_URL, {
          mal_id: malId,
          episode,
          provider,
          video_url: downloadUrl,
          resolution: server.resolution,
        })
      } catch {
        // Non-fatal: stream stays null, not archived
        allArchivedInHf = false
        server.stream = server.url_resolved !== null ? buildStreamUrl(server.url_resolved) : null
      }
    })
  )

  return allArchivedInHf
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * getStreamingLinks — Fetches streaming embed links from all providers concurrently,
 * enriches each server with a `stream` URL (Cloudflare Workers proxy), and
 * fires background jobs to archive videos to HuggingFace.
 *
 * Cache strategy (two-tier):
 * - 20 min TTL: normal scrape result (embed URLs expire, so we re-scrape periodically)
 * - Permanent:  once ALL servers with url_resolved are archived to HuggingFace,
 *               the cache entry is promoted to permanent (expiresAt = 0).
 *               url_resolved in cached response will already point to HF URLs.
 *
 * @param slugAnimasu       - Animasu slug from the mapping (null if not available)
 * @param slugSamehadaku    - Samehadaku slug from the mapping (null if not available)
 * @param slugNontonanimeid - NontonAnimeid slug from the mapping (null if not available)
 * @param episode           - Episode number to fetch
 * @param malId             - MAL ID used for queue/store lookup and CF Workers URL
 */
export async function getStreamingLinks(
  slugAnimasu: string | null,
  slugSamehadaku: string | null,
  slugNontonanimeid: string | null,
  episode: number,
  malId: number
): Promise<{
  animasu: StreamingServer[] | null
  samehadaku: StreamingServer[] | null
  nontonanimeid: StreamingServer[] | null
}> {
  const cacheKey = `${malId}:${episode}`
  const now = Date.now()

  // ── Cache hit check (scrape results only) ──────────────────────────────────
  const cached = streamingCache.get(cacheKey)
  let animasuResult: StreamingServer[] | null
  let samehadakuResult: StreamingServer[] | null
  let nontonanimeidResult: StreamingServer[] | null

  if (cached !== undefined && cached.expiresAt > now) {
    Logger.debug(`  ✅ Scrape cache hit (20min): ${cacheKey}`)
    animasuResult = cached.animasu
    samehadakuResult = cached.samehadaku
    nontonanimeidResult = cached.nontonanimeid
  } else {
    // Cache miss or expired — re-scrape all providers
    if (cached !== undefined) streamingCache.delete(cacheKey)

    const [a, s, n] = await Promise.all([
      slugAnimasu !== null ? scrapeAnimasuStreaming(slugAnimasu, episode) : Promise.resolve(null),
      slugSamehadaku !== null
        ? scrapeSamehadakuStreaming(slugSamehadaku, episode)
        : Promise.resolve(null),
      slugNontonanimeid !== null
        ? scrapeNontonAnimeidStreaming(slugNontonanimeid, episode)
        : Promise.resolve(null),
    ])
    animasuResult = a
    samehadakuResult = s
    nontonanimeidResult = n

    // Cache raw scrape results for 20 minutes
    streamingCache.set(cacheKey, {
      animasu: animasuResult,
      samehadaku: samehadakuResult,
      nontonanimeid: nontonanimeidResult,
      expiresAt: now + EPISODE_CACHE_TTL_MS,
    })
    Logger.debug(`  💾 Scrape cached (20min): ${cacheKey}`)
  }

  // ── Always check HF store fresh + enrich stream URLs ─────────────────────
  // Runs on every request (cache hit or miss). Supabase query ~20ms.
  await Promise.all([
    animasuResult !== null
      ? enrichWithStreamUrls(animasuResult, malId, episode, 'animasu')
      : Promise.resolve(true),
    samehadakuResult !== null
      ? enrichWithStreamUrls(samehadakuResult, malId, episode, 'samehadaku')
      : Promise.resolve(true),
    nontonanimeidResult !== null
      ? enrichWithStreamUrls(nontonanimeidResult, malId, episode, 'nontonanimeid')
      : Promise.resolve(true),
  ])

  return {
    animasu: animasuResult,
    samehadaku: samehadakuResult,
    nontonanimeid: nontonanimeidResult,
  }
}
