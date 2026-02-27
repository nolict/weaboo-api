import { AnimasuProvider } from '../providers/animasu'
import { NontonAnimeidProvider } from '../providers/nontonanimeid'
import { SamehadakuProvider } from '../providers/samehadaku'
import type { NormalizedAnime, ProviderResponse } from '../types/anime'
import { Logger } from '../utils/logger'
import { AnimeNormalizer } from '../utils/normalizer'

export class AnimeAggregator {
  private readonly providers = [
    new AnimasuProvider(),
    new SamehadakuProvider(),
    new NontonAnimeidProvider(),
  ]

  async aggregateHome(): Promise<NormalizedAnime[]> {
    Logger.info('🚀 Starting anime aggregation from all providers')

    const results = await Promise.allSettled(
      this.providers.map(async (provider) => await provider.fetch())
    )

    const allItems: ProviderResponse['data'] = []
    let successCount = 0
    let failCount = 0

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        allItems.push(...result.value.data)
        successCount++
      } else {
        failCount++
      }
    }

    Logger.info(`📊 Aggregation stats: ${successCount} succeeded, ${failCount} failed`)
    Logger.info(`📦 Total items before deduplication: ${allItems.length}`)

    const deduplicated = AnimeNormalizer.deduplicateAnime(allItems)

    Logger.success(`✨ Deduplication complete: ${deduplicated.length} unique anime`)
    Logger.info(`🗑️  Removed ${allItems.length - deduplicated.length} duplicates`)

    return deduplicated
  }
}
