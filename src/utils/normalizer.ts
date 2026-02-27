import type { AnimeItem, NormalizedAnime } from '../types/anime'

// ── Season/cour/part normalisation map ───────────────────────────────────────
// Converts human-readable suffixes to a canonical ordinal form so that
// "Sakamoto Days Cour 2" and "Sakamoto Days Part 2" both become
// "Sakamoto Days 2" before comparison.
const SEASON_ALIASES: Array<[RegExp, string]> = [
  [/\bcour\s*(\d+)/gi, 'part $1'],
  [/\bseason\s*(\d+)/gi, 'part $1'],
  [/\b(\d+)(st|nd|rd|th)\s*season/gi, 'part $1'],
  [/\bs(\d+)\b/gi, 'part $1'],
  [/\bpart\s*(\d+)/gi, 'part $1'], // normalise existing "part N" too (trim whitespace)
]

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
    return (
      title
        .replace(/\s*\(.*?\)\s*/g, '')
        .replace(/\s*-\s*sub\s*indo?\s*/gi, '')
        .replace(/\s*sub\s*indo?\s*/gi, '')
        .replace(/\s*batch\s*/gi, '')
        .replace(/nonton\s*anime\s*/gi, '')
        // Normalise punctuation variants so that "?" and """ and "!" don't
        // create Levenshtein distance vs MAL titles that use different quote styles.
        // e.g. "?Omae Gotoki...?" vs ""Omae Gotoki..."" → both become "Omae Gotoki..."
        .replace(
          /[\u0022\u201C\u201D\u2018\u2019\u300C\u300D\u300E\u300F\u3010\u3011\u3008\u3009\u300A\u300B\u003F\uFF01!]/g,
          ''
        )
        .replace(/\s+/g, ' ')
        .trim()
    )
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

  /**
   * normaliseSeason — Applies SEASON_ALIASES to produce a canonical title
   * where all season/cour/part suffixes use the same "part N" form.
   * Used before fuzzy-matching across providers and against Jikan.
   *
   * Examples:
   *   "Sakamoto Days Cour 2"  → "Sakamoto Days part 2"
   *   "Attack on Titan S4"    → "Attack on Titan part 4"
   *   "Overlord 2nd Season"   → "Overlord part 2"
   */
  normaliseSeason(title: string): string {
    let result = title.trim()
    for (const [pattern, replacement] of SEASON_ALIASES) {
      result = result.replace(pattern, replacement)
    }
    // Collapse extra whitespace that substitutions may introduce
    return result.replace(/\s+/g, ' ').trim()
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
          // Store the original provider slug so consumers can build the correct URL
          existing.providerSlugs[item.provider] = item.slugs
          matched = true
          break
        }
      }

      if (!matched) {
        slugMap.set(canonicalSlug, {
          name: cleanedName,
          cover: item.cover,
          // slugs = original slug from the primary provider (not canonical)
          slugs: item.slugs,
          provider: item.provider,
          sources: [item.provider],
          providerSlugs: { [item.provider]: item.slugs },
        })
      }
    }

    return Array.from(slugMap.values())
  },
}
