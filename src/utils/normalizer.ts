import type { AnimeItem, NormalizedAnime } from '../types/anime'

export const AnimeNormalizer = {
  createCanonicalSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/^nonton\s*anime\s*/i, '')
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/\s*-\s*season\s*\d+/gi, '')
      .replace(/\s*season\s*\d+/gi, '')
      .replace(/\s*\d+(st|nd|rd|th)\s*season/gi, '')
      .replace(/\s*s\d+/gi, '')
      .replace(/\s*part\s*\d+/gi, '')
      .replace(/\s*cour\s*\d+/gi, '')
      .replace(/\s*sub\s*indo?\s*/gi, '')
      .replace(/\s*batch\s*/gi, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  },

  cleanTitle(title: string): string {
    return title
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/\s*-\s*sub\s*indo?\s*/gi, '')
      .replace(/\s*sub\s*indo?\s*/gi, '')
      .replace(/\s*batch\s*/gi, '')
      .replace(/nonton\s*anime\s*/gi, '')
      .trim()
  },

  calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase()
    const s2 = str2.toLowerCase()

    if (s1 === s2) return 1.0

    const longer = s1.length > s2.length ? s1 : s2

    if (longer.length === 0) return 1.0

    const editDistance = this.levenshteinDistance(s1, s2)
    return (longer.length - editDistance) / longer.length
  },

  levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = []

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i]
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1]
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          )
        }
      }
    }

    return matrix[str2.length][str1.length]
  },

  deduplicateAnime(items: AnimeItem[]): NormalizedAnime[] {
    const slugMap = new Map<string, NormalizedAnime>()
    const SIMILARITY_THRESHOLD = 0.85

    for (const item of items) {
      const canonicalSlug = this.createCanonicalSlug(item.name)
      const cleanedName = this.cleanTitle(item.name)

      let matched = false

      for (const [existingSlug, existing] of slugMap.entries()) {
        const similarity = this.calculateSimilarity(canonicalSlug, existingSlug)
        const isPrefix =
          canonicalSlug.startsWith(existingSlug) || existingSlug.startsWith(canonicalSlug)

        if (similarity >= SIMILARITY_THRESHOLD || isPrefix) {
          if (!existing.sources.includes(item.provider)) {
            existing.sources.push(item.provider)
          }
          matched = true
          break
        }
      }

      if (!matched) {
        slugMap.set(canonicalSlug, {
          name: cleanedName,
          cover: item.cover,
          slugs: canonicalSlug,
          provider: item.provider,
          sources: [item.provider],
        })
      }
    }

    return Array.from(slugMap.values())
  },
}
