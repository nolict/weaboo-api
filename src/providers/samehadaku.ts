import { load } from 'cheerio'

import { PROVIDERS } from '../config/constants'
import type { AnimeItem, ProviderResponse } from '../types/anime'
import { fetchHTML } from '../utils/fetcher'
import { Logger } from '../utils/logger'

interface CachedResult {
  data: AnimeItem[]
  timestamp: number
}

export class SamehadakuProvider {
  private readonly baseUrl: string = 'https://v1.samehadaku.how'
  private readonly homeUrl: string = PROVIDERS.SAMEHADAKU.url
  private readonly providerName: string = PROVIDERS.SAMEHADAKU.name
  private cachedResult: CachedResult | null = null
  private readonly cacheTtlMs: number = 5 * 60 * 1000

  async fetch(): Promise<ProviderResponse> {
    Logger.info(`🔄 Starting scrape: ${this.providerName}`)

    if (this.cachedResult !== null) {
      const now = Date.now()
      const age = now - this.cachedResult.timestamp

      if (age < this.cacheTtlMs) {
        const ageSeconds = Math.floor(age / 1000)
        Logger.debug(
          `Using cached data (age: ${ageSeconds}s, ${this.cachedResult.data.length} items)`
        )
        return {
          success: true,
          data: this.cachedResult.data,
        }
      } else {
        Logger.debug('Cache expired, fetching fresh data')
        this.cachedResult = null
      }
    }

    try {
      const html = await fetchHTML(this.homeUrl)
      const $ = load(html)

      const items: AnimeItem[] = []

      $('.post-show ul li').each((_, element) => {
        const $item = $(element)
        const $link = $item.find('a')
        const $image = $item.find('img')

        const url = $link.attr('href') ?? ''
        const animeName = $link.attr('title') ?? $image.attr('alt') ?? ''
        const coverUrl = $image.attr('src') ?? ''

        if (url !== '' && animeName !== '' && coverUrl !== '') {
          const slug = this.extractSlugFromUrl(url)

          if (slug !== '') {
            items.push({
              name: animeName.trim(),
              cover: coverUrl.trim(),
              slugs: slug,
              provider: this.providerName,
            })
          }
        }
      })

      if (items.length === 0) {
        throw new Error('No anime items found. Page structure may have changed.')
      }

      Logger.info(`Enriching ${items.length} anime titles from detail pages...`)

      const enrichPromises = items.map(async (anime) => {
        const fullTitle = await this.extractFullTitleFromDetailPage(anime.slugs)
        if (fullTitle !== null) {
          Logger.debug(`Enriched: "${anime.name}" → "${fullTitle}"`)
          anime.name = fullTitle
        }
      })

      await Promise.all(enrichPromises)

      this.cachedResult = {
        data: items,
        timestamp: Date.now(),
      }

      Logger.success(`✅ Scraped ${items.length} items from ${this.providerName}`)
      Logger.debug(`Cached data (TTL: 5 minutes)`)

      return {
        success: true,
        data: items,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      Logger.warning(`⚠️  Failed to scrape ${this.providerName}: ${errorMessage}`)
      Logger.info('   Continuing with other providers...')

      return {
        success: false,
        data: [],
        error: errorMessage,
      }
    }
  }

  private async extractFullTitleFromDetailPage(slug: string): Promise<string | null> {
    try {
      const detailUrl = `${this.baseUrl}/anime/${slug}/`
      const html = await fetchHTML(detailUrl)
      const $ = load(html)

      const paragraphs = $('.entry-content p')

      if (paragraphs.length >= 2) {
        const p0 = $(paragraphs[0]).text().trim()
        const p1 = $(paragraphs[1]).text().trim()

        if (p0 === 'Judul lengkap:' && p1.length > 0) {
          return p1
        }
      }

      return null
    } catch {
      return null
    }
  }

  private extractSlugFromUrl(url: string): string {
    try {
      const urlObj = new URL(url)
      const pathParts = urlObj.pathname.split('/').filter(Boolean)
      return pathParts[pathParts.length - 1] ?? ''
    } catch {
      return ''
    }
  }
}
