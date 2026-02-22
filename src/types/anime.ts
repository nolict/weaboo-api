export interface AnimeItem {
  name: string
  cover: string
  slugs: string
  provider: string
}

export interface ProviderResponse {
  success: boolean
  data: AnimeItem[]
  error?: string
}

export interface NormalizedAnime extends AnimeItem {
  sources: string[]
}
