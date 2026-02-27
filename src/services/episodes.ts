import * as cheerio from 'cheerio'

import { EPISODE_CACHE_TTL_MS, PROVIDERS } from '../config/constants'
import type { EpisodeEntry, EpisodeList, ProviderEpisodeList } from '../types/anime'
import { fetchHTML } from '../utils/fetcher'
import { Logger } from '../utils/logger'

// ── In-memory episode cache (20-minute TTL) ───────────────────────────────────
// Key: `${provider}:${slug}`
const episodeCache = new Map<string, ProviderEpisodeList>()

// ── Episode label parser ──────────────────────────────────────────────────────

/**
 * parseEpisodeLabel — Extracts episodeStart and episodeEnd from a raw label.
 *
 * Handles:
 *   "Episode 7"       → { start: 7,   end: 7 }
 *   "Episode 115-120" → { start: 115, end: 120 }
 *   "Episode 1 - 3"   → { start: 1,   end: 3 }
 *   "Ep. 5"           → { start: 5,   end: 5 }
 *   "5"               → { start: 5,   end: 5 }
 *
 * Returns null if no numeric part can be parsed.
 */
function parseEpisodeLabel(rawLabel: string): { start: number; end: number } | null {
  // Strip "Episode", "Ep.", "EP" prefixes (case-insensitive)
  let stripped = rawLabel.replace(/^(episode|ep\.?)\s*/i, '').trim()

  // Strip trailing episode-finale markers: [END], [FIN], [TAMAT], [FINAL], etc.
  stripped = stripped.replace(/\s*\[(end|fin|tamat|final|complete|完)\]/i, '').trim()

  // Also strip anime title prefix before episode number, e.g. "Sakamoto Days Cour 2 Episode 11"
  // Pattern: strip everything up to the last standalone number/range
  // We do this by checking if there's still a title-like prefix before digits
  const titlePrefixMatch = /^.+\s+(\d+(?:\s*[-–]\s*\d+)?)$/.exec(stripped)
  if (titlePrefixMatch !== null) {
    stripped = titlePrefixMatch[1]
  }

  // Try range pattern: "115-120" or "115 - 120"
  const rangeMatch = /^(\d+)\s*[-–]\s*(\d+)$/.exec(stripped)
  if (rangeMatch !== null) {
    const start = parseInt(rangeMatch[1], 10)
    const end = parseInt(rangeMatch[2], 10)
    if (!isNaN(start) && !isNaN(end)) {
      return { start: Math.min(start, end), end: Math.max(start, end) }
    }
  }

  // Try single number: "7" or "7.5"
  const singleMatch = /^(\d+(?:\.\d+)?)$/.exec(stripped)
  if (singleMatch !== null) {
    const num = parseFloat(singleMatch[1])
    if (!isNaN(num)) {
      const rounded = Math.floor(num)
      return { start: rounded, end: rounded }
    }
  }

  return null
}

// ── DOM scraper ───────────────────────────────────────────────────────────────

/**
 * scrapeAnimasuEpisodes — Animasu detail page episode list.
 *
 * Structure: ul#daftarepisode > li > span.lchx > a
 *   - href → full watch URL  (e.g. https://v1.animasu.app/nonton-dead-account-episode-7/)
 *   - text → episode label   (e.g. "Episode 7" or "Episode 115-120")
 */
function scrapeAnimasuEpisodes($: cheerio.CheerioAPI): EpisodeEntry[] {
  const entries: EpisodeEntry[] = []

  $('#daftarepisode li').each((_i, li) => {
    const $a = $(li).find('span.lchx a')
    if ($a.length === 0) return

    const href = $a.attr('href') ?? ''
    const rawLabel = $a.text().trim()
    if (href === '' || rawLabel === '') return

    const parsed = parseEpisodeLabel(rawLabel)
    if (parsed === null) {
      Logger.debug(`  ⚠️  Could not parse Animasu episode label: "${rawLabel}" — skipping`)
      return
    }

    entries.push({ label: rawLabel, episodeStart: parsed.start, episodeEnd: parsed.end, url: href })
  })

  return entries
}

/**
 * scrapeSamehadakuEpisodes — Samehadaku detail page episode list.
 *
 * Structure: div.lstepsiode.listeps > ul > li
 *   - div.epsleft > span.lchx > a → full label  (e.g. "Dead Account Episode 7")
 *   - div.epsright > span.eps > a → episode number only (e.g. "7")
 *
 * We prefer the epsright number (cleaner for parsing), falling back to lchx label.
 * URL format: https://v1.samehadaku.how/{slug}-episode-{N}/
 */
function scrapeSamehadakuEpisodes($: cheerio.CheerioAPI): EpisodeEntry[] {
  const entries: EpisodeEntry[] = []

  $('.lstepsiode.listeps ul li').each((_i, li) => {
    // Prefer the short episode number from epsright (e.g. "7" or "115-120")
    const $epsRight = $(li).find('div.epsright span.eps a')
    const $epsLeft = $(li).find('div.epsleft span.lchx a')

    const href = $epsLeft.attr('href') ?? $epsRight.attr('href') ?? ''
    if (href === '') return

    // Try epsright number first (cleaner), fall back to full lchx label
    const shortLabel = $epsRight.text().trim()
    const fullLabel = $epsLeft.text().trim()
    const rawLabel = shortLabel !== '' ? shortLabel : fullLabel
    if (rawLabel === '') return

    const parsed = parseEpisodeLabel(rawLabel)
    if (parsed === null) {
      Logger.debug(`  ⚠️  Could not parse Samehadaku episode label: "${rawLabel}" — skipping`)
      return
    }

    // Use full label for display (e.g. "Dead Account Episode 7") if available
    const displayLabel = fullLabel !== '' ? fullLabel : rawLabel

    entries.push({
      label: displayLabel,
      episodeStart: parsed.start,
      episodeEnd: parsed.end,
      url: href,
    })
  })

  return entries
}

/**
 * scrapeNontonAnimeidEpisodes — NontonAnimeid detail page episode list.
 *
 * Structure: .episode-list-items > a.episode-item
 *   - href → full watch URL  (e.g. https://s11.nontonanimeid.boats/{slug}-episode-{N}/)
 *   - .ep-title text → episode label (e.g. "Episode 9")
 *
 * Detail page URL format: /anime/{slug}/
 */
function scrapeNontonAnimeidEpisodes($: cheerio.CheerioAPI): EpisodeEntry[] {
  const entries: EpisodeEntry[] = []

  $('.episode-list-items a.episode-item').each((_i, el) => {
    const $el = $(el)
    const href = $el.attr('href') ?? ''
    const rawLabel = $el.find('.ep-title').text().trim()
    if (href === '' || rawLabel === '') return

    const parsed = parseEpisodeLabel(rawLabel)
    if (parsed === null) {
      Logger.debug(`  ⚠️  Could not parse NontonAnimeid episode label: "${rawLabel}" — skipping`)
      return
    }

    entries.push({ label: rawLabel, episodeStart: parsed.start, episodeEnd: parsed.end, url: href })
  })

  return entries
}

/**
 * scrapeEpisodeList — Fetches the anime detail page and extracts episode entries
 * using the provider-specific DOM structure.
 *
 * - Animasu:       ul#daftarepisode > li > span.lchx > a
 * - Samehadaku:    div.lstepsiode.listeps > ul > li > div.epsleft > span.lchx > a
 * - NontonAnimeid: .episode-list-items a.episode-item > .ep-title
 *
 * Episodes are returned in ascending order (oldest first).
 */
async function scrapeEpisodeList(slug: string, provider: string): Promise<EpisodeEntry[]> {
  let detailUrl: string

  if (provider === PROVIDERS.ANIMASU.name) {
    detailUrl = `${PROVIDERS.ANIMASU.baseUrl}/anime/${slug}/`
  } else if (provider === PROVIDERS.NONTONANIMEID.name) {
    detailUrl = `${PROVIDERS.NONTONANIMEID.baseUrl}/anime/${slug}/`
  } else {
    detailUrl = `${PROVIDERS.SAMEHADAKU.baseUrl}/anime/${slug}/`
  }

  Logger.debug(`📺 Scraping episodes: ${provider}/${slug}`)

  // NontonAnimeid uses native fetch (no Cloudflare issues)
  let html: string
  if (provider === PROVIDERS.NONTONANIMEID.name) {
    const res = await fetch(detailUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${detailUrl}`)
    html = await res.text()
  } else {
    html = await fetchHTML(detailUrl)
  }

  const $ = cheerio.load(html)

  let entries: EpisodeEntry[]
  if (provider === PROVIDERS.ANIMASU.name) {
    entries = scrapeAnimasuEpisodes($)
  } else if (provider === PROVIDERS.NONTONANIMEID.name) {
    entries = scrapeNontonAnimeidEpisodes($)
  } else {
    entries = scrapeSamehadakuEpisodes($)
  }

  // Providers list newest-first; reverse to ascending (ep 1, 2, 3 ... N)
  entries.reverse()

  Logger.debug(`  ✅ Found ${entries.length} episodes for ${provider}/${slug}`)
  return entries
}

// ── Cache-aware public API ────────────────────────────────────────────────────

/**
 * getEpisodesForProvider — Returns episode list for a single provider slug,
 * using in-memory cache with 20-minute TTL.
 *
 * Returns null if the slug is null/empty or scraping fails.
 */
async function getEpisodesForProvider(
  slug: string | null,
  provider: string
): Promise<EpisodeEntry[] | null> {
  if (slug === null || slug.trim() === '') return null

  const cacheKey = `${provider}:${slug}`
  const cached = episodeCache.get(cacheKey)

  if (cached !== undefined) {
    const age = Date.now() - cached.cachedAt
    if (age < EPISODE_CACHE_TTL_MS) {
      Logger.debug(`⚡ Episode cache hit: ${cacheKey} (age: ${Math.floor(age / 1000)}s)`)
      return cached.episodes
    }
    Logger.debug(`🕐 Episode cache expired: ${cacheKey}`)
    episodeCache.delete(cacheKey)
  }

  try {
    const episodes = await scrapeEpisodeList(slug, provider)

    episodeCache.set(cacheKey, {
      provider,
      episodes,
      cachedAt: Date.now(),
    })

    return episodes
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.warning(`⚠️  Episode scrape failed for ${provider}/${slug}: ${msg}`)
    return null
  }
}

/**
 * getEpisodeList — Fetches episode lists from all providers concurrently.
 *
 * Accepts the slugs from an AnimeMapping. Each provider is fetched
 * independently — failure in one does not affect the other.
 *
 * Returns an EpisodeList with null for any provider that failed or has no slug.
 */
export async function getEpisodeList(
  slugAnimasu: string | null,
  slugSamehadaku: string | null,
  slugNontonanimeid?: string | null
): Promise<EpisodeList> {
  const [animasuEpisodes, samehadakuEpisodes, nontonanimeidEpisodes] = await Promise.all([
    getEpisodesForProvider(slugAnimasu, PROVIDERS.ANIMASU.name),
    getEpisodesForProvider(slugSamehadaku, PROVIDERS.SAMEHADAKU.name),
    getEpisodesForProvider(slugNontonanimeid ?? null, PROVIDERS.NONTONANIMEID.name),
  ])

  return {
    animasu: animasuEpisodes,
    samehadaku: samehadakuEpisodes,
    nontonanimeid: nontonanimeidEpisodes,
  }
}

/**
 * getEpisodeUrl — Returns the direct URL for a specific episode number from
 * the episode list of a provider. Uses the cached episode list (fetching if
 * needed). Returns null if the episode is not found.
 *
 * This is used by the streaming service to get the real episode URL from the
 * DOM (which always has the correct slug), rather than constructing it from
 * the stored mapping slug (which may be canonical/shortened and not match).
 */
export async function getEpisodeUrl(
  slug: string,
  provider: string,
  episode: number
): Promise<string | null> {
  const episodes = await getEpisodesForProvider(slug, provider)
  if (episodes === null) return null

  // Find entry where the target episode falls within the range
  const entry = episodes.find((e) => episode >= e.episodeStart && episode <= e.episodeEnd)
  return entry?.url ?? null
}
