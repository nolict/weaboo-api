export const PROVIDERS = {
  SAMEHADAKU: {
    name: 'samehadaku',
    url: 'https://v1.samehadaku.how/anime-terbaru/',
  },
  ANIMASU: {
    name: 'animasu',
    url: 'https://v1.animasu.app/anime-sedang-tayang-terbaru/',
  },
} as const

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const API_VERSION = 'v1'
export const PORT = process.env.PORT ?? 3000
