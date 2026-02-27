import * as cheerio from 'cheerio'

import { PROVIDERS } from '../config/constants'
import type { AnimeItem, ProviderResponse } from '../types/anime'
import { Logger } from '../utils/logger'

const PROVIDER_NAME = PROVIDERS.NONTONANIMEID.name
const HOMEPAGE_URL = PROVIDERS.NONTONANIMEID.url

// In-memory cache: 5 minutes TTL (same as Samehadaku)
let cachedResult: AnimeItem[] | null = null
let cacheExpiry = 0
const CACHE_TTL_MS = 5 * 60 * 1000

export class NontonAnimeidProvider {
  async fetch(): Promise<ProviderResponse> {
    const now = Date.now()
    if (cachedResult !== null && now < cacheExpiry) {
      Logger.debug(`[${PROVIDER_NAME}] Serving homepage from cache`)
      return { success: true, data: cachedResult }
    }

    Logger.info(`🔄 Starting scrape: ${PROVIDER_NAME}`)

    try {
      const res = await fetch(HOMEPAGE_URL, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      const html = await res.text()
      const $ = cheerio.load(html)
      const items: AnimeItem[] = []

      // Cards: <article class="animeseries post-XXXXX">
      // Each card has: a[href] → /anime/{slug}/, img[src], h3.title span → title
      $('article.animeseries').each((_, el) => {
        const $el = $(el)
        const link = $el.find('a[href]').first().attr('href') ?? ''
        if (link === '' || !link.includes('/anime/')) return

        const slug = this.extractSlugFromUrl(link)
        if (slug === '') return

        const title = $el.find('h3.title span').first().text().trim()
        if (title === '') return

        // Image: img inside .limit
        let cover = $el.find('img').first().attr('src') ?? ''
        // Remove WordPress resize params for higher quality
        cover = cover.replace(/\?h=\d+/, '')

        items.push({
          name: title,
          cover,
          slugs: slug,
          provider: PROVIDER_NAME,
        })
      })

      Logger.success(`✅ ${PROVIDER_NAME}: ${items.length} anime scraped`)

      cachedResult = items
      cacheExpiry = Date.now() + CACHE_TTL_MS

      return { success: true, data: items }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      Logger.error(`❌ Failed to scrape ${PROVIDER_NAME}: ${msg}`)
      return { success: false, data: [], error: msg }
    }
  }

  private extractSlugFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname
      // URL format: /anime/{slug}/
      const match = pathname.match(/^\/anime\/([^/]+)\/?$/)
      return match?.[1] ?? ''
    } catch {
      return ''
    }
  }
}
