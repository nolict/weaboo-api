import * as cheerio from 'cheerio'

import { PROVIDERS, DEFAULT_USER_AGENT } from '../config/constants'
import type { AnimeItem, ProviderResponse } from '../types/anime'
import { Logger } from '../utils/logger'

export class AnimasuProvider {
  private readonly url: string = PROVIDERS.ANIMASU.url
  private readonly providerName: string = PROVIDERS.ANIMASU.name

  async fetch(): Promise<ProviderResponse> {
    Logger.info(`🔄 Starting scrape: ${this.providerName}`)

    try {
      const response = await fetch(this.url, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const html = await response.text()
      const $ = cheerio.load(html)

      const items: AnimeItem[] = []

      $('.bs').each((_, element) => {
        const $item = $(element)

        const titleElement = $item.find('a[title]').first()
        const displayTitle = titleElement.attr('title')?.trim() ?? ''
        const link = titleElement.attr('href') ?? ''

        // .tt contains the original/Japanese title — use it for slug matching
        const originalTitle = $item.find('.tt').first().text().trim()
        const title = originalTitle !== '' ? originalTitle : displayTitle

        const imageElement = $item.find('img').first()
        const image = imageElement.attr('src') ?? imageElement.attr('data-src') ?? ''

        if (displayTitle !== '' && image !== '' && link !== '') {
          const slug = this.extractSlugFromUrl(link)
          items.push({
            name: title,
            cover: image,
            slugs: slug,
            provider: this.providerName,
          })
        }
      })

      Logger.success(`✅ Scraped ${items.length} items from ${this.providerName}`)

      return {
        success: true,
        data: items,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      Logger.error(`❌ Failed to scrape ${this.providerName}: ${errorMessage}`)

      return {
        success: false,
        data: [],
        error: errorMessage,
      }
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
