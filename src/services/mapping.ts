import * as cheerio from 'cheerio'

import {
  EPISODE_COUNT_TOLERANCE,
  PHASH_HAMMING_THRESHOLD,
  PROVIDERS,
  TITLE_SIMILARITY_THRESHOLD,
} from '../config/constants'
import { findMappingByMalId, findMappingByPHash, upsertMapping } from '../lib/supabase'
import type { AnimeDetailScrape, AnimeMapping, JikanAnime, MatchResult } from '../types/anime'
import { fetchHTML } from '../utils/fetcher'
import { Logger } from '../utils/logger'
import { AnimeNormalizer } from '../utils/normalizer'

import { generatePHash } from './image'
import { getAnimeById, getAnimeFullById, searchByTitle, validateMetadataMatch } from './jikan'

// ── In-memory Request Lock ────────────────────────────────────────────────────
// Prevents multiple concurrent requests for the same slug from each triggering
// their own Enrichment Phase (which would hammer scrapers + Jikan).
// The lock stores a Promise so subsequent callers simply await the first one.
const enrichmentLocks = new Map<string, Promise<AnimeMapping | null>>()

// ── Provider detail-page scrapers ─────────────────────────────────────────────

/**
 * Scrape a Samehadaku anime detail page.
 * URL pattern: https://v1.samehadaku.how/anime/<slug>/
 *
 * Extracts: full title (H1), poster image, release year, episode count.
 * The "Judul lengkap:" paragraph enrichment is re-used from SamehadakuProvider.
 */
async function scrapeAnimasuDetail(slug: string): Promise<AnimeDetailScrape | null> {
  try {
    const url = `${PROVIDERS.ANIMASU.baseUrl}/anime/${slug}/`

    // Animasu works with native fetch() — axios with short UA gets blocked by Cloudflare
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    })

    if (!res.ok) {
      Logger.warning(`⚠️  Animasu detail HTTP ${res.status} for slug "${slug}"`)
      return null
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Title: prefer .entry-title / h1, fallback to page <title>
    const h1Entry = $('h1.entry-title').first().text().trim()
    const h1Generic = $('h1').first().text().trim()
    const titleTag = $('title').text().split('|')[0].trim()
    const title = h1Entry !== '' ? h1Entry : h1Generic !== '' ? h1Generic : titleTag

    // Cover: og:image (older anime pages may not have it) → fallback to
    // first wp.com / animasu-hosted image found in the page (data-src or src)
    let coverUrl = $('meta[property="og:image"]').attr('content') ?? ''

    if (coverUrl === '' || !isCoverUrlValid(coverUrl, 'animasu')) {
      // Walk all img tags, pick first one hosted on WordPress CDN or animasu domain
      $('img').each((_, el) => {
        if (coverUrl !== '') return false // already found
        const src = $(el).attr('src') ?? $(el).attr('data-src') ?? $(el).attr('data-lazy-src') ?? ''
        if (isCoverUrlValid(src, 'animasu')) coverUrl = src
      })
    }

    // Year: Animasu uses "Rilis: Jan 6, 2026" or "Rilis: 2004" format in .spe span
    let year: number | null = null
    $('div.spe span').each((_, el) => {
      const text = $(el).text().trim()
      if (/^rilis:/i.test(text)) {
        const match = /(\d{4})/.exec(text)
        if (match !== null) year = parseInt(match[1], 10)
      }
    })

    // Episodes: Animasu detail page does NOT show total episode count —
    // only "Status: Sedang Tayang" is shown. Set null so metadata gate
    // relies on year + title only.
    const totalEpisodes: number | null = null

    if (title === '' || coverUrl === '') return null

    return { title, coverUrl, year, totalEpisodes, slug, provider: PROVIDERS.ANIMASU.name }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.warning(`⚠️  Failed to scrape Animasu detail (${slug}): ${msg}`)
    return null
  }
}

async function scrapeSamehadakuDetail(slug: string): Promise<AnimeDetailScrape | null> {
  try {
    const url = `${PROVIDERS.SAMEHADAKU.baseUrl}/anime/${slug}/`
    const html = await fetchHTML(url)
    const $ = cheerio.load(html)

    // Full title from "Judul lengkap:" paragraph pattern (established in SamehadakuProvider)
    let title = ''
    const paragraphs = $('.entry-content p')
    if (paragraphs.length >= 2) {
      const p0 = $(paragraphs[0]).text().trim()
      const p1 = $(paragraphs[1]).text().trim()
      if (p0 === 'Judul lengkap:' && p1.length > 0) title = p1
    }
    // Fallback to H1
    if (title === '') title = $('h1').first().text().trim()

    const coverUrl =
      $('meta[property="og:image"]').attr('content') ??
      $('img.attachment-post-thumbnail').attr('src') ??
      ''

    // Year: Samehadaku uses "Released: Jan 6, 2026 to ?" format in .spe span
    let year: number | null = null
    $('div.spe span').each((_, el) => {
      const text = $(el).text().trim()
      if (/^released:/i.test(text)) {
        const match = /(\d{4})/.exec(text)
        if (match !== null) year = parseInt(match[1], 10)
      }
    })

    // Episodes: Samehadaku uses "Total Episode 13" format (no colon)
    let totalEpisodes: number | null = null
    $('div.spe span').each((_, el) => {
      const text = $(el).text().trim()
      if (/^total\s+episode\s+\d+/i.test(text)) {
        const match = /(\d+)$/.exec(text)
        if (match !== null) totalEpisodes = parseInt(match[1], 10)
      }
    })

    if (title === '' || coverUrl === '') return null

    return { title, coverUrl, year, totalEpisodes, slug, provider: PROVIDERS.SAMEHADAKU.name }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.warning(`⚠️  Failed to scrape Samehadaku detail (${slug}): ${msg}`)
    return null
  }
}

/**
 * Scrape a NontonAnimeid anime detail page.
 * URL pattern: https://s11.nontonanimeid.boats/anime/<slug>/
 *
 * Extracts: title (h1), poster image (og:image), release year (Aired: field),
 * episode count (span.info-item containing "N Episodes").
 */
async function scrapeNontonAnimeidDetail(slug: string): Promise<AnimeDetailScrape | null> {
  try {
    const url = `${PROVIDERS.NONTONANIMEID.baseUrl}/anime/${slug}/`

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    })

    if (!res.ok) {
      Logger.warning(`⚠️  NontonAnimeid detail HTTP ${res.status} for slug "${slug}"`)
      return null
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Title: h1 contains "Nonton {Title} Sub Indo" — extract clean title from og:title
    // og:title format: "{Title} Sub Indo Terbaru - Nonton Anime ID"
    // Prefer title from h1.entry-title but strip "Nonton ... Sub Indo" prefix/suffix
    const ogTitle = $('meta[property="og:title"]').attr('content') ?? ''
    let title = ogTitle
      .replace(/\s*Sub Indo.*$/i, '')
      .replace(/\s*Terbaru.*$/i, '')
      .trim()
    if (title === '') {
      const h1 = $('h1').first().text().trim()
      title = h1
        .replace(/^Nonton\s+/i, '')
        .replace(/\s+Sub Indo$/i, '')
        .trim()
    }

    // Cover: og:image — NontonAnimeid uses standard WordPress og:image
    const coverUrl = $('meta[property="og:image"]').attr('content') ?? ''

    // Year: "Aired: Jan 9, 2026 to ?" format in .details-list li
    let year: number | null = null
    $('.details-list li').each((_, el) => {
      const text = $(el).text().trim()
      if (/^Aired:/i.test(text)) {
        const match = /(\d{4})/.exec(text)
        if (match !== null) year = parseInt(match[1], 10)
      }
    })

    // Episodes: "12 Episodes" in span.info-item
    let totalEpisodes: number | null = null
    $('span.info-item').each((_, el) => {
      const text = $(el).text().trim()
      const match = /^(\d+)\s+Episodes?$/i.exec(text)
      if (match !== null) totalEpisodes = parseInt(match[1], 10)
    })

    if (title === '' || coverUrl === '') return null

    return { title, coverUrl, year, totalEpisodes, slug, provider: PROVIDERS.NONTONANIMEID.name }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.warning(`⚠️  Failed to scrape NontonAnimeid detail (${slug}): ${msg}`)
    return null
  }
}

// ── Cross-provider slug discovery ─────────────────────────────────────────────

/**
 * Validate that a scraped coverUrl actually belongs to the target provider
 * and is not a fallback/default image (e.g. Linktree og:image, site logo).
 *
 * A valid cover must be hosted on the provider's own domain or a known
 * CDN it uses (e.g. wp.com for WordPress-based sites).
 */
function isCoverUrlValid(
  coverUrl: string,
  targetProvider: 'samehadaku' | 'animasu' | 'nontonanimeid'
): boolean {
  if (coverUrl === '') return false
  try {
    const { hostname } = new URL(coverUrl)
    if (targetProvider === 'animasu') {
      // Animasu uses WordPress — images served via i0.wp.com / i1.wp.com / i2.wp.com
      return hostname.includes('animasu') || hostname.endsWith('wp.com')
    }
    if (targetProvider === 'nontonanimeid') {
      // NontonAnimeid uses WordPress CDN (i0.wp.com) or their own domain
      return hostname.includes('nontonanimeid') || hostname.endsWith('wp.com')
    }
    // Samehadaku images hosted on their own domain or CDN
    return hostname.includes('samehadaku') || hostname.endsWith('wp.com')
  } catch {
    return false
  }
}

/**
 * searchProviderForSlug — Queries the WordPress search endpoint of a provider
 * to discover real slugs for a given title query.
 *
 * Both Animasu and Samehadaku are WordPress sites exposing /?s=<query>.
 * Search results include real slugs + thumbnail covers — no slug guessing.
 * We only return results whose cover URL passes the domain validity check.
 */
async function searchProviderForSlug(
  query: string,
  targetProvider: 'samehadaku' | 'animasu' | 'nontonanimeid',
  trustSearchEngine: boolean = false
): Promise<
  Array<{
    slug: string
    coverUrl: string
    cardTitle: string
    skipTitleFilter: boolean
  }>
> {
  let baseUrl: string
  if (targetProvider === 'animasu') {
    baseUrl = PROVIDERS.ANIMASU.baseUrl
  } else if (targetProvider === 'nontonanimeid') {
    baseUrl = PROVIDERS.NONTONANIMEID.baseUrl
  } else {
    baseUrl = PROVIDERS.SAMEHADAKU.baseUrl
  }

  const searchUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`
  Logger.debug(`  🔎 Provider search: ${searchUrl}`)

  try {
    let html: string
    if (targetProvider === 'nontonanimeid') {
      // NontonAnimeid uses native fetch (no Cloudflare block)
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      html = await res.text()
    } else {
      html = await fetchHTML(searchUrl)
    }

    const $ = cheerio.load(html)

    const results: Array<{
      slug: string
      coverUrl: string
      cardTitle: string
      skipTitleFilter: boolean
    }> = []

    // Animasu: .bs cards
    // Samehadaku: .animpost on search pages
    // NontonAnimeid: article.animeseries cards (slug under /anime/{slug}/)
    let cardSelector: string
    if (targetProvider === 'animasu') {
      cardSelector = '.bs'
    } else if (targetProvider === 'nontonanimeid') {
      cardSelector = 'article.animeseries'
    } else {
      cardSelector = '.animpost'
    }

    $(cardSelector).each((_, el) => {
      const $el = $(el)

      let href = ''
      let img = ''
      let cardTitle = ''

      if (targetProvider === 'nontonanimeid') {
        // NontonAnimeid: a[href] → /anime/{slug}/, img[src], h3.title span
        href = $el.find('a[href]').first().attr('href') ?? ''
        img = $el.find('img').first().attr('src') ?? ''
        cardTitle = $el.find('h3.title span').first().text().trim()
        // Slug is in /anime/{slug}/ path
        try {
          const urlObj = new URL(href)
          const parts = urlObj.pathname.split('/').filter(Boolean)
          // path: ['anime', '{slug}']
          const slug = parts[1] ?? ''
          if (slug !== '' && isCoverUrlValid(img, 'nontonanimeid')) {
            results.push({ slug, coverUrl: img, cardTitle, skipTitleFilter: false })
          }
        } catch {
          // skip
        }
        return
      }

      const $anchor = $el.find('a[title]').first()
      href = $anchor.attr('href') ?? $el.find('a').first().attr('href') ?? ''
      img = $el.find('img').first().attr('src') ?? $el.find('img').first().attr('data-src') ?? ''

      // Card title:
      // - Animasu: prefer .tt (Japanese/original title), fallback to a[title]
      // - Samehadaku .animpost: title is in a[title] or h2 text
      const ttText = $el.find('.tt').first().text().trim()
      const h2Text = $el.find('h2').first().text().trim()
      const anchorTitle = $anchor.attr('title') ?? ''
      cardTitle = ttText !== '' ? ttText : anchorTitle !== '' ? anchorTitle : h2Text

      if (href === '' || img === '') return

      try {
        const urlObj = new URL(href)
        const parts = urlObj.pathname.split('/').filter(Boolean)
        const slug = parts[parts.length - 1] ?? ''

        if (slug !== '' && isCoverUrlValid(img, targetProvider)) {
          results.push({ slug, coverUrl: img, cardTitle, skipTitleFilter: false })
        }
      } catch {
        // skip malformed URLs
      }
    })

    Logger.debug(`  Found ${results.length} candidate(s) on ${targetProvider}`)

    // If trustSearchEngine is set and we got a small, specific result set,
    // mark all candidates to skip the card-title pre-filter.
    if (trustSearchEngine && results.length <= 3) {
      return results.map((r) => ({ ...r, skipTitleFilter: true }))
    }

    return results
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.debug(`  Provider search failed on ${targetProvider}: ${msg}`)
    return []
  }
}

/**
 * Given a confirmed MAL entry, attempt to find the *opposite* provider's slug.
 *
 * Strategy (Search-First):
 *  1. Query the opposite provider's WordPress search with MAL title variants.
 *  2. For each search result (real slug + thumbnail):
 *     a. Compare thumbnail pHash against source pHash (Hamming < threshold) → ✅ match
 *     b. Fallback: scrape detail page → validate metadata (year ±1, eps ±tolerance) → ✅ match
 *
 * Why search-first?
 *  Slug formats differ wildly between providers (e.g. Samehadaku "yuukawa" vs
 *  Animasu "yuusha-party-ni-kawaii-ko"). Guessing slugs from MAL titles is
 *  unreliable. Search gives us the real slug + a valid thumbnail cover URL
 *  without hitting an unknown detail page URL.
 *
 * Episode tolerance:
 *  Simulcast providers may differ by 1–2 episodes. We use EPISODE_COUNT_TOLERANCE
 *  as the allowed delta. `last_sync` in Supabase tells consumers when to re-check.
 */
async function discoverOppositeSlug(
  jikanAnime: JikanAnime,
  sourceProvider: 'samehadaku' | 'animasu' | 'nontonanimeid',
  sourcePHash: string | null,
  explicitTarget?: 'samehadaku' | 'animasu' | 'nontonanimeid'
): Promise<{ slug: string; phash: string | null } | null> {
  // If explicitTarget is given, use it. Otherwise derive the opposite.
  let targetProvider: 'samehadaku' | 'animasu' | 'nontonanimeid'
  if (explicitTarget !== undefined) {
    targetProvider = explicitTarget
  } else if (sourceProvider === 'samehadaku') {
    targetProvider = 'animasu'
  } else if (sourceProvider === 'animasu') {
    targetProvider = 'samehadaku'
  } else {
    targetProvider = 'samehadaku' // nontonanimeid default: search samehadaku
  }

  // Build search query list — ordered from most specific to most lenient:
  // 1. Full title as-is   (e.g. "Jigokuraku 2nd Season", "Hell's Paradise Season 2")
  // 2. Pre-colon prefix   (e.g. "Hell's Paradise") — for colon-subtitle titles
  // 3. Base title only    (e.g. "Jigokuraku") — strip season/cour/part suffix entirely
  //                        ↑ critical for providers that index by base series name
  // 4. First 3 words      (e.g. "Hell's Paradise") — last resort broad search
  const rawTitles = [jikanAnime.title_english, jikanAnime.title].filter(
    (t): t is string => t !== null && t.length > 0
  )

  const queryTitles: string[] = []
  const seen = new Set<string>()

  const addQuery = (q: string): void => {
    const trimmed = q.trim()
    if (trimmed.length > 1 && !seen.has(trimmed)) {
      seen.add(trimmed)
      queryTitles.push(trimmed)
    }
  }

  for (const t of rawTitles) {
    // 1. Full title
    addQuery(t)

    // 2. Pre-colon prefix (e.g. "Hell's Paradise: Jigokuraku" → "Hell's Paradise")
    const colonIdx = t.indexOf(':')
    if (colonIdx > 0) {
      addQuery(t.slice(0, colonIdx))
    }

    // 3. Base title — strip season/cour/part/S\d suffix and everything after
    //    e.g. "Jigokuraku 2nd Season" → "Jigokuraku"
    //    e.g. "Hell's Paradise Season 2" → "Hell's Paradise"
    const baseTitle = t
      .replace(/\s*(season|cour|part|s)\s*\d+.*/gi, '')
      .replace(/\s*\d+(st|nd|rd|th)\s*season.*/gi, '')
      .trim()
    addQuery(baseTitle)

    // 4. First 3 words as broad fallback (min 8 chars to avoid noise)
    const firstThree = t.split(/\s+/).slice(0, 3).join(' ')
    if (firstThree.length >= 8) addQuery(firstThree)
  }

  Logger.info(`🔎 Discovering ${targetProvider} slug via search for: "${queryTitles[0] ?? ''}"`)

  const { hammingDistance } = await import('./image')

  for (let qIdx = 0; qIdx < queryTitles.length; qIdx++) {
    const query = queryTitles[qIdx]

    // For Samehadaku: trust the search engine if ≤ 3 results come back — Samehadaku
    // indexes by full title so even short-slug entries (e.g. "omae-gotoki-ga-maou...")
    // will appear. Skip card-title pre-filter and go straight to detail scrape.
    // Previously this was only for qIdx ≥ 2 but even q[0] (full title) returns the
    // right result on Samehadaku when there are few candidates.
    const isSpecificRomajiQuery = targetProvider === 'samehadaku'
    const candidates = await searchProviderForSlug(query, targetProvider, isSpecificRomajiQuery)

    for (const candidate of candidates) {
      Logger.debug(
        `  Candidate: ${targetProvider}/${candidate.slug} | card title: "${candidate.cardTitle}"`
      )

      // ── Pre-filter: card title similarity check ──────────────────────────
      // Before doing any network calls (pHash download, detail scrape),
      // verify the search result card title is similar enough to MAL title.
      // This prevents wasting time on obviously wrong results.
      //
      // EXCEPTION: if candidate.skipTitleFilter is true (set when the query is a
      // specific romaji title on Samehadaku with ≤ 3 results), we trust the search
      // engine and skip the card-title check — Samehadaku often uses short/abbrev
      // titles on cards (e.g. "Yuukawa") even when the full title matches perfectly.
      if (!candidate.skipTitleFilter && candidate.cardTitle !== '') {
        const cleanedCard = AnimeNormalizer.cleanTitle(candidate.cardTitle)
        const malTitleEn = AnimeNormalizer.cleanTitle(jikanAnime.title_english ?? jikanAnime.title)
        const malTitleRo = AnimeNormalizer.cleanTitle(jikanAnime.title)

        const cardSim = Math.max(
          AnimeNormalizer.calculateSimilarity(
            AnimeNormalizer.normaliseSeason(cleanedCard),
            AnimeNormalizer.normaliseSeason(malTitleEn)
          ),
          AnimeNormalizer.calculateSimilarity(
            AnimeNormalizer.normaliseSeason(cleanedCard),
            AnimeNormalizer.normaliseSeason(malTitleRo)
          )
        )

        Logger.debug(`  Card title sim=${cardSim.toFixed(3)} for "${cleanedCard}"`)

        if (cardSim < TITLE_SIMILARITY_THRESHOLD) {
          Logger.debug(`  Card title mismatch — skipping ${candidate.slug}`)
          continue
        }
      } else if (candidate.skipTitleFilter) {
        Logger.debug(
          `  Card title filter skipped (specific romaji query, ≤ few results) — going to detail scrape`
        )
      }

      // ── Step A: pHash comparison using search thumbnail ─────────────────
      // The thumbnail from search results IS the poster — valid cover, no
      // detail page fetch needed. Compare directly against source pHash.
      if (sourcePHash !== null) {
        const candidateHash = await generatePHash(candidate.coverUrl)
        if (candidateHash !== null) {
          const dist = hammingDistance(sourcePHash, candidateHash)
          Logger.debug(`  pHash dist=${dist} for ${candidate.slug}`)
          if (dist >= 0 && dist < PHASH_HAMMING_THRESHOLD) {
            Logger.success(
              `✅ Cross-provider pHash match: ${targetProvider}/${candidate.slug} (dist=${dist})`
            )
            return { slug: candidate.slug, phash: candidateHash }
          }
        }
      }

      // ── Step B: Metadata fallback — scrape detail page ──────────────────
      // pHash didn't match conclusively. Scrape the full detail page and
      // run a THREE-factor check: title similarity + year + episode count.
      // All three must pass to avoid false positives like "yuukawa" ≠ "SI-VIS".
      let detail: AnimeDetailScrape | null
      if (targetProvider === 'animasu') {
        detail = await scrapeAnimasuDetail(candidate.slug)
      } else if (targetProvider === 'nontonanimeid') {
        detail = await scrapeNontonAnimeidDetail(candidate.slug)
      } else {
        detail = await scrapeSamehadakuDetail(candidate.slug)
      }

      if (detail !== null && isCoverUrlValid(detail.coverUrl, targetProvider)) {
        // Gate 1: Title must be similar to MAL title (> threshold)
        // Without this, unrelated anime with same year/episodes will match.
        const cleanedDetailTitle = AnimeNormalizer.cleanTitle(detail.title)
        const malTitle = AnimeNormalizer.cleanTitle(jikanAnime.title_english ?? jikanAnime.title)
        const malTitleRomaji = AnimeNormalizer.cleanTitle(jikanAnime.title)

        const titleSim = Math.max(
          AnimeNormalizer.calculateSimilarity(
            AnimeNormalizer.normaliseSeason(cleanedDetailTitle),
            AnimeNormalizer.normaliseSeason(malTitle)
          ),
          AnimeNormalizer.calculateSimilarity(
            AnimeNormalizer.normaliseSeason(cleanedDetailTitle),
            AnimeNormalizer.normaliseSeason(malTitleRomaji)
          )
        )

        Logger.debug(
          `  Title sim=${titleSim.toFixed(3)} for "${cleanedDetailTitle}" vs "${malTitle}"`
        )

        if (titleSim < TITLE_SIMILARITY_THRESHOLD) {
          Logger.debug(`  Title mismatch for ${candidate.slug} — skipping`)
          continue
        }

        // Gate 2: Year + episode count
        // At least one metadata field must be known and pass validation.
        // If BOTH year and totalEpisodes are null/unknown, we cannot confirm
        // identity via metadata — skip to avoid false positives.
        const effectiveEpisodes =
          detail.totalEpisodes !== null && detail.totalEpisodes > 0 ? detail.totalEpisodes : null
        const hasAnyMeta = detail.year !== null || effectiveEpisodes !== null
        if (!hasAnyMeta) {
          Logger.debug(`  No metadata available for ${candidate.slug} — cannot confirm, skipping`)
          continue
        }

        const metaOk = validateMetadataMatch(
          jikanAnime,
          { year: detail.year, totalEpisodes: effectiveEpisodes },
          EPISODE_COUNT_TOLERANCE
        )
        if (metaOk) {
          Logger.success(`✅ Cross-provider metadata match: ${targetProvider}/${candidate.slug}`)
          return { slug: candidate.slug, phash: null }
        }
        Logger.debug(`  Year/episode mismatch for ${candidate.slug} — trying next`)
      }
    }
  }

  // ── Last resort: direct slug derivation ──────────────────────────────────
  // WordPress search may fail for short/acronym titles (e.g. "SI-VIS" → 0 results).
  // Try hitting the detail page directly using canonical slugs derived from all
  // MAL title variants. This covers cases like samehadaku.how/anime/si-vis/.
  Logger.debug(`  Search exhausted — trying direct slug hits as last resort`)

  const directSlugs: string[] = []
  const directSeen = new Set<string>()

  const addDirectSlug = (s: string): void => {
    if (s !== '' && !directSeen.has(s)) {
      directSeen.add(s)
      directSlugs.push(s)
    }
  }

  // Season suffix variants to append to base slug when looking for sequels.
  // e.g. base "jigokuraku" → try "jigokuraku-season-2", "jigokuraku-2nd-season", etc.
  const seasonVariantSuffixes = (n: number): string[] => [
    `-season-${n}`,
    `-${n}nd-season`,
    `-${n}rd-season`,
    `-${n}st-season`,
    `-${n}th-season`,
    `-part-${n}`,
    `-cour-${n}`,
    `-s${n}`,
  ]

  // Detect season number from MAL title (e.g. "Jigokuraku 2nd Season" → 2)
  const seasonMatch = /(\d+)(st|nd|rd|th)\s*season|season\s*(\d+)|part\s*(\d+)|cour\s*(\d+)/i.exec(
    jikanAnime.title
  )
  const seasonNum =
    seasonMatch !== null
      ? parseInt(seasonMatch[1] ?? seasonMatch[3] ?? seasonMatch[4] ?? seasonMatch[5] ?? '0', 10)
      : null

  for (const t of [jikanAnime.title_english, jikanAnime.title, jikanAnime.title_japanese].filter(
    (x): x is string => x !== null && x.length > 0
  )) {
    // Full canonical slug (season info stripped by createCanonicalSlug)
    const full = AnimeNormalizer.createCanonicalSlug(t)
    addDirectSlug(full)

    // Pre-colon prefix slug (e.g. "SI-VIS: The Sound of Heroes" → "si-vis")
    const colonIdx = t.indexOf(':')
    if (colonIdx > 0) {
      addDirectSlug(AnimeNormalizer.createCanonicalSlug(t.slice(0, colonIdx)))
    }

    // Base title slug (strip season suffix from title before slugging)
    const baseTitle = t
      .replace(/\s*(season|cour|part|s)\s*\d+.*/gi, '')
      .replace(/\s*\d+(st|nd|rd|th)\s*season.*/gi, '')
      .trim()
    const baseSlug = AnimeNormalizer.createCanonicalSlug(baseTitle)
    addDirectSlug(baseSlug)

    // Truncated slug variants — some providers (especially Samehadaku) use
    // shortened slugs cut at logical title separators.
    // Light novel titles often use " to " or " node " as separators:
    // e.g. "Omae Gotoki ga Maou ni Kateru to Omouna" to Yuusha Party..."
    //   → Samehadaku slug: "omae-gotoki-ga-maou-ni-kateru-to-omouna"
    // Try slug forms cut at common LN title separator words.
    const cleanedT = AnimeNormalizer.cleanTitle(t)
    const lnSeparators = [' node ', ' to ', ' ga ', ' de ', ' ni ', ' wo ']
    for (const sep of lnSeparators) {
      const sepIdx = cleanedT.toLowerCase().lastIndexOf(sep)
      if (sepIdx > 10) {
        // Only cut if there's meaningful content before the separator
        const prefix = cleanedT.slice(0, sepIdx).trim()
        if (prefix.split(/\s+/).length >= 3) {
          addDirectSlug(AnimeNormalizer.createCanonicalSlug(prefix))
        }
      }
    }

    // Season slug variants — append known season suffixes to base slug
    // e.g. "jigokuraku" + "-season-2" → "jigokuraku-season-2"
    if (baseSlug !== '' && seasonNum !== null && seasonNum >= 2) {
      for (const suffix of seasonVariantSuffixes(seasonNum)) {
        addDirectSlug(`${baseSlug}${suffix}`)
      }
    }

    // Year-suffixed slug variants — some providers append release year to disambiguate
    // e.g. Animasu "monster-2004" for MAL title "Monster" (year=2004)
    if (baseSlug !== '' && jikanAnime.year !== null) {
      addDirectSlug(`${baseSlug}-${jikanAnime.year}`)
    }
    if (full !== '' && jikanAnime.year !== null && full !== baseSlug) {
      addDirectSlug(`${full}-${jikanAnime.year}`)
    }
  }

  const directScraper = targetProvider === 'animasu' ? scrapeAnimasuDetail : scrapeSamehadakuDetail

  for (const directSlug of directSlugs) {
    Logger.debug(`  Direct hit attempt: ${targetProvider}/${directSlug}`)
    const detail = await directScraper(directSlug)

    if (detail === null || !isCoverUrlValid(detail.coverUrl, targetProvider)) continue

    // Verify title similarity
    const cleanedDetail = AnimeNormalizer.cleanTitle(detail.title)
    const malEn = AnimeNormalizer.cleanTitle(jikanAnime.title_english ?? jikanAnime.title)
    const malRo = AnimeNormalizer.cleanTitle(jikanAnime.title)

    const sim = Math.max(
      AnimeNormalizer.calculateSimilarity(
        AnimeNormalizer.normaliseSeason(cleanedDetail),
        AnimeNormalizer.normaliseSeason(malEn)
      ),
      AnimeNormalizer.calculateSimilarity(
        AnimeNormalizer.normaliseSeason(cleanedDetail),
        AnimeNormalizer.normaliseSeason(malRo)
      )
    )

    Logger.debug(`  Direct slug title sim=${sim.toFixed(3)} for "${cleanedDetail}"`)

    // Also accept if one title is a prefix of the other — handles cases where
    // a provider uses a shortened title (e.g. "SI-VIS" vs "SI-VIS: The Sound of Heroes").
    const normDetail = AnimeNormalizer.normaliseSeason(cleanedDetail).toLowerCase()
    const normEn = AnimeNormalizer.normaliseSeason(malEn).toLowerCase()
    const normRo = AnimeNormalizer.normaliseSeason(malRo).toLowerCase()
    const isPrefixMatch =
      normEn.startsWith(normDetail) ||
      normRo.startsWith(normDetail) ||
      normDetail.startsWith(normEn) ||
      normDetail.startsWith(normRo)

    if (sim < TITLE_SIMILARITY_THRESHOLD && !isPrefixMatch) {
      Logger.debug(`  Direct slug title mismatch — skipping`)
      continue
    }

    if (isPrefixMatch && sim < TITLE_SIMILARITY_THRESHOLD) {
      Logger.debug(`  Direct slug accepted via prefix match`)
    }

    // pHash confirm if we have source hash
    if (sourcePHash !== null) {
      const candidateHash = await generatePHash(detail.coverUrl)
      if (candidateHash !== null) {
        const dist = hammingDistance(sourcePHash, candidateHash)
        Logger.debug(`  Direct slug pHash dist=${dist} for ${directSlug}`)
        if (dist >= 0 && dist < PHASH_HAMMING_THRESHOLD) {
          Logger.success(
            `✅ Direct slug pHash match: ${targetProvider}/${directSlug} (dist=${dist})`
          )
          return { slug: directSlug, phash: candidateHash }
        }
      }
    }

    // Metadata confirm
    const effectiveEps =
      detail.totalEpisodes !== null && detail.totalEpisodes > 0 ? detail.totalEpisodes : null
    const hasAnyMeta = detail.year !== null || effectiveEps !== null
    if (hasAnyMeta) {
      const metaOk = validateMetadataMatch(
        jikanAnime,
        { year: detail.year, totalEpisodes: effectiveEps },
        EPISODE_COUNT_TOLERANCE
      )
      if (metaOk) {
        Logger.success(`✅ Direct slug metadata match: ${targetProvider}/${directSlug}`)
        return { slug: directSlug, phash: null }
      }
    } else {
      // Title confirmed, no metadata to contradict.
      // Only accept title-only if the MAL title has NO season markers —
      // otherwise we risk accepting Season 1 when Season 2 was requested.
      const hasSeasonMarker =
        /season|cour|part|\d+(st|nd|rd|th)\s*season/i.test(jikanAnime.title) ||
        /season|cour|part|\d+(st|nd|rd|th)\s*season/i.test(jikanAnime.title_english ?? '')
      if (!hasSeasonMarker) {
        Logger.success(`✅ Direct slug title-only match: ${targetProvider}/${directSlug}`)
        return { slug: directSlug, phash: null }
      }
      Logger.debug(`  Title-only unsafe for multi-season title "${jikanAnime.title}" — skipping`)
    }
  }

  Logger.debug(`  No valid cross-provider slug found on ${targetProvider}`)
  return null
}

// ── Core Discovery Logic ──────────────────────────────────────────────────────

/**
 * runDiscovery — Full multi-factor enrichment pipeline for a single anime.
 *
 * Pipeline:
 *  1. Scrape the source provider detail page → title, cover, year, episodes
 *  2. Generate pHash from poster (in-memory, no disk I/O)
 *  3. Visual match: query Supabase for existing pHash within Hamming threshold
 *  4. Metadata fallback: if no visual match, search Jikan by normalised title
 *  5. Validate Jikan result with year + episode metadata
 *  6. Cross-provider: discover opposite provider slug
 *  7. Upsert complete "Triangle Mapping" into Supabase
 *
 * Returns the upserted AnimeMapping, or null if MAL ID could not be resolved.
 */
async function runDiscovery(
  slug: string,
  provider: 'samehadaku' | 'animasu' | 'nontonanimeid'
): Promise<AnimeMapping | null> {
  Logger.info(`🚀 Starting enrichment for ${provider}/${slug}`)

  // ── Step 1: Scrape detail page ────────────────────────────────────────────
  let detail: AnimeDetailScrape | null
  if (provider === 'samehadaku') {
    detail = await scrapeSamehadakuDetail(slug)
  } else if (provider === 'nontonanimeid') {
    detail = await scrapeNontonAnimeidDetail(slug)
  } else {
    detail = await scrapeAnimasuDetail(slug)
  }

  if (detail === null) {
    Logger.warning(`⚠️  Could not scrape detail page for ${provider}/${slug}`)
    return null
  }

  Logger.info(
    `📄 Scraped: "${detail.title}" | year=${detail.year ?? '?'} | eps=${detail.totalEpisodes ?? '?'}`
  )

  // ── Step 2: Generate pHash in-memory ─────────────────────────────────────
  const pHash = await generatePHash(detail.coverUrl)

  // ── Step 3: Visual match via Supabase ────────────────────────────────────
  let matchResult: MatchResult = {
    method: 'none',
    malId: null,
    titleMain: null,
    confidence: 0,
    jikanAnime: null,
  }

  if (pHash !== null) {
    Logger.debug(`🔍 Querying Supabase for pHash match (threshold < ${PHASH_HAMMING_THRESHOLD})`)
    const existing = await findMappingByPHash(pHash, PHASH_HAMMING_THRESHOLD)

    if (existing !== null) {
      Logger.success(`✅ Visual match found: mal_id=${existing.mal_id} "${existing.title_main}"`)
      matchResult = {
        method: 'phash',
        malId: existing.mal_id,
        titleMain: existing.title_main,
        confidence: 1.0,
        jikanAnime: await getAnimeById(existing.mal_id),
      }
    }
  }

  // ── Step 4 & 5: Jikan metadata fallback ──────────────────────────────────
  if (matchResult.method === 'none') {
    // Always clean the title before sending to Jikan — strip "Sub Indo",
    // "Nonton Anime", batch suffixes, etc. that pollute fuzzy scoring.
    const cleanedTitle = AnimeNormalizer.cleanTitle(detail.title)
    Logger.info(`🔍 No visual match — searching Jikan for: "${cleanedTitle}"`)
    const jikanResult = await searchByTitle(cleanedTitle, detail.year)

    if (jikanResult !== null) {
      const isExact =
        AnimeNormalizer.calculateSimilarity(
          AnimeNormalizer.normaliseSeason(cleanedTitle),
          AnimeNormalizer.normaliseSeason(AnimeNormalizer.cleanTitle(jikanResult.title))
        ) >= TITLE_SIMILARITY_THRESHOLD

      const metaOk = validateMetadataMatch(
        jikanResult,
        { year: detail.year, totalEpisodes: detail.totalEpisodes },
        EPISODE_COUNT_TOLERANCE
      )

      // ── Acceptance gate ────────────────────────────────────────────────────
      // Title similarity (isExact) alone is NOT sufficient when year is known.
      // A high title score for "Jigokuraku" would match both Season 1 and
      // Season 2 — only metadata can distinguish them.
      //
      // Rules:
      //  - If scraped year is known  → BOTH isExact AND metaOk are REQUIRED
      //  - If scraped year is unknown → title similarity alone is enough (no metadata to check)
      const hasKnownYear = detail.year !== null
      const accepted = hasKnownYear ? isExact && metaOk : isExact || metaOk

      if (accepted) {
        const confidence = isExact && metaOk ? 1.0 : isExact ? 0.9 : 0.75
        matchResult = {
          method: isExact ? 'jikan_exact' : 'jikan_fuzzy',
          malId: jikanResult.mal_id,
          titleMain: jikanResult.title,
          confidence,
          jikanAnime: jikanResult,
        }
        Logger.success(
          `✅ Jikan match (${matchResult.method}): "${jikanResult.title}" ` +
            `mal_id=${jikanResult.mal_id} confidence=${confidence}`
        )
      } else {
        Logger.warning(
          `⚠️  Jikan candidate "${jikanResult.title}" (year=${jikanResult.year ?? '?'}) ` +
            `failed validation for ${provider}/${slug} (scraped year=${detail.year ?? '?'}) — skipping`
        )
      }
    }
  }

  if (matchResult.malId === null || matchResult.jikanAnime === null) {
    Logger.warning(`⚠️  Could not resolve MAL ID for ${provider}/${slug}`)
    return null
  }

  // ── Step 6: Cross-provider slug discovery ─────────────────────────────────
  // For nontonanimeid: discover both animasu + samehadaku
  // For animasu/samehadaku: discover the other two providers
  let slugSamehadaku: string | null = provider === 'samehadaku' ? slug : null
  let slugAnimasu: string | null = provider === 'animasu' ? slug : null
  let slugNontonanimeid: string | null = provider === 'nontonanimeid' ? slug : null
  let finalPHash: string | null = pHash

  // Discover missing provider slugs
  const providersToDo: Array<'samehadaku' | 'animasu' | 'nontonanimeid'> = []
  if (slugSamehadaku === null) providersToDo.push('samehadaku')
  if (slugAnimasu === null) providersToDo.push('animasu')
  if (slugNontonanimeid === null) providersToDo.push('nontonanimeid')

  for (const targetProv of providersToDo) {
    // discoverOppositeSlug searches <targetProv> when sourceProvider != targetProv
    // We use the current source provider for the first discovery, then switch
    const result = await discoverOppositeSlug(
      matchResult.jikanAnime,
      provider,
      finalPHash,
      targetProv
    )
    if (result !== null) {
      if (targetProv === 'samehadaku') slugSamehadaku = result.slug
      else if (targetProv === 'animasu') slugAnimasu = result.slug
      else slugNontonanimeid = result.slug
      finalPHash = finalPHash ?? result.phash
    }
  }

  // ── Step 7: Build mapping and upsert ──────────────────────────────────────
  const mapping = await upsertMapping({
    malId: matchResult.malId,
    titleMain: matchResult.titleMain ?? matchResult.jikanAnime.title,
    slugSamehadaku,
    slugAnimasu,
    slugNontonanimeid,
    phashV1: finalPHash,
    releaseYear: matchResult.jikanAnime.year ?? detail.year,
    totalEpisodes: matchResult.jikanAnime.episodes ?? detail.totalEpisodes,
  })

  Logger.success(
    `💾 Mapping saved: mal_id=${mapping.mal_id} | ` +
      `samehadaku=${mapping.slug_samehadaku ?? '-'} | ` +
      `animasu=${mapping.slug_animasu ?? '-'} | ` +
      `nontonanimeid=${mapping.slug_nontonanimeid ?? '-'}`
  )

  return mapping
}

// ── MAL-ID-first discovery ────────────────────────────────────────────────────

/**
 * runDiscoveryByMalId — Entry point when we already know the MAL ID.
 *
 * Strategy:
 *  1. Check Supabase — return cached mapping immediately if found.
 *  2. Fetch MAL title from Jikan (getAnimeFullById).
 *  3. Use MAL title variants to search BOTH providers (Samehadaku + Animasu)
 *     via the same discoverOppositeSlug logic — treating "no source" as a
 *     two-sided discovery.
 *  4. Upsert and return the new mapping.
 */
async function runDiscoveryByMalId(malId: number): Promise<AnimeMapping | null> {
  Logger.info(`🚀 Starting MAL-ID enrichment for mal_id=${malId}`)

  // ── Step 1: Supabase cache check ─────────────────────────────────────────
  const cached = await findMappingByMalId(malId)
  if (cached !== null) {
    Logger.success(`⚡ Mapping cache hit for mal_id=${malId}`)
    return cached
  }

  // ── Step 2: Fetch MAL metadata from Jikan ────────────────────────────────
  const malAnime = await getAnimeFullById(malId)
  if (malAnime === null) {
    Logger.warning(`⚠️  Could not fetch Jikan data for mal_id=${malId}`)
    return null
  }

  Logger.info(
    `📄 Jikan: "${malAnime.title}" (year=${malAnime.year ?? '?'}, eps=${malAnime.episodes ?? '?'})`
  )

  // Build a JikanAnime-shaped object to reuse discoverOppositeSlug
  const jikanAnime: JikanAnime = {
    mal_id: malAnime.mal_id,
    title: malAnime.title,
    title_english: malAnime.title_english,
    title_japanese: malAnime.title_japanese,
    episodes: malAnime.episodes,
    year: malAnime.year,
    images: malAnime.images,
  }

  // ── Step 3: Discover slugs on all providers ───────────────────────────────
  // Search Samehadaku first, use its pHash to assist other providers.
  Logger.info(`🔎 Searching Samehadaku for mal_id=${malId} ("${malAnime.title}")`)
  const samehadakuResult = await discoverOppositeSlug(jikanAnime, 'animasu', null, 'samehadaku')

  const slugSamehadaku: string | null = samehadakuResult?.slug ?? null
  let sourcePHash: string | null = samehadakuResult?.phash ?? null

  // If we got a Samehadaku slug, generate its pHash to assist other providers
  if (slugSamehadaku !== null && sourcePHash === null) {
    const detail = await scrapeSamehadakuDetail(slugSamehadaku)
    if (detail !== null) {
      sourcePHash = await generatePHash(detail.coverUrl)
    }
  }

  Logger.info(`🔎 Searching Animasu for mal_id=${malId} ("${malAnime.title}")`)
  const animasuResult = await discoverOppositeSlug(jikanAnime, 'samehadaku', sourcePHash, 'animasu')

  const slugAnimasu: string | null = animasuResult?.slug ?? null
  const phashAfterAnimasu = sourcePHash ?? animasuResult?.phash ?? null

  Logger.info(`🔎 Searching NontonAnimeid for mal_id=${malId} ("${malAnime.title}")`)
  const naidResult = await discoverOppositeSlug(
    jikanAnime,
    'samehadaku',
    phashAfterAnimasu,
    'nontonanimeid'
  )

  const slugNontonanimeid: string | null = naidResult?.slug ?? null
  const finalPHash = phashAfterAnimasu ?? naidResult?.phash ?? null

  if (slugSamehadaku === null && slugAnimasu === null && slugNontonanimeid === null) {
    Logger.warning(`⚠️  Could not find any provider slug for mal_id=${malId}`)
    // Still upsert a partial mapping so MAL metadata is cached
  }

  // ── Step 4: Upsert mapping ────────────────────────────────────────────────
  const mapping = await upsertMapping({
    malId: malAnime.mal_id,
    titleMain: malAnime.title,
    slugSamehadaku,
    slugAnimasu,
    slugNontonanimeid,
    phashV1: finalPHash,
    releaseYear: malAnime.year,
    totalEpisodes: malAnime.episodes,
  })

  Logger.success(
    `💾 Mapping saved (by MAL ID): mal_id=${mapping.mal_id} | ` +
      `samehadaku=${mapping.slug_samehadaku ?? '-'} | ` +
      `animasu=${mapping.slug_animasu ?? '-'} | ` +
      `nontonanimeid=${mapping.slug_nontonanimeid ?? '-'}`
  )

  return mapping
}

// ── Public entrypoints (with Request Lock) ───────────────────────────────────

/**
 * resolveMappingByMalId — Public entrypoint for MAL-ID-first lookup.
 * Uses a Request Lock keyed by mal_id to prevent duplicate concurrent jobs.
 */
export async function resolveMappingByMalId(malId: number): Promise<AnimeMapping | null> {
  const lockKey = `mal:${malId}`

  const existing = enrichmentLocks.get(lockKey)
  if (existing !== undefined) {
    Logger.debug(`⏳ Request lock active for ${lockKey} — awaiting existing job`)
    return await existing
  }

  const job = runDiscoveryByMalId(malId).finally(() => {
    enrichmentLocks.delete(lockKey)
  })

  enrichmentLocks.set(lockKey, job)
  return await job
}

/**
 * resolveMapping — Public entrypoint used by the controller.
 * Implements the Request Lock pattern: subsequent callers for the same slug
 * await the same Promise instead of spawning duplicate discovery jobs.
 */
export async function resolveMapping(
  slug: string,
  provider: 'samehadaku' | 'animasu' | 'nontonanimeid'
): Promise<AnimeMapping | null> {
  const lockKey = `${provider}:${slug}`

  // Reuse an in-flight enrichment if one exists
  const existing = enrichmentLocks.get(lockKey)
  if (existing !== undefined) {
    Logger.debug(`⏳ Request lock active for ${lockKey} — awaiting existing job`)
    return await existing
  }

  // Kick off enrichment and register the lock
  const job = runDiscovery(slug, provider).finally(() => {
    enrichmentLocks.delete(lockKey)
  })

  enrichmentLocks.set(lockKey, job)
  return await job
}
