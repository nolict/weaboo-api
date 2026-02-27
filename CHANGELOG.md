# Changelog

## 0.0.1 (2026-02-27)


### Features

* **anime:** add MAL full metadata cache, episode list scraping, and score tie tiebreak by year ([089dd61](https://github.com/nolict/weaboo-api/commit/089dd61e50047840c7be7797a3b6396984888d7c))
* **mapping:** implement MAL triangle mapping with pHash & multi-factor discovery ([4d05088](https://github.com/nolict/weaboo-api/commit/4d05088dcedf67f6d5a2e34db1f1c61abb4a3c07))
* **search:** add genre search, MAL-ID endpoint, fix episode [END] parsing, ([e80ef46](https://github.com/nolict/weaboo-api/commit/e80ef46eca078c05743fcdf2fe177e0aa5c906fa))
* **streaming:** add /api/v1/streaming/:malId/:episode with Animasu base64 decode and Samehadaku player_ajax AJAX scraping ([1b1f47f](https://github.com/nolict/weaboo-api/commit/1b1f47f9059e1e0f4389465321ccbedd7b696419))
* **streaming:** add embed url resolver with vidhidepro/vidhidefast/callistanise HLS sub-playlist extraction ([126d263](https://github.com/nolict/weaboo-api/commit/126d263246d7629535de2719bb8b484e00feb839))
* **streaming:** add filedon.co resolver via Inertia.js data-page parsing ([1d23b5a](https://github.com/nolict/weaboo-api/commit/1d23b5a48bab161b3d309d04bdda695ba8d11598))
* **streaming:** add HuggingFace archival + Cloudflare Workers proxy with two-tier cache ([44bad22](https://github.com/nolict/weaboo-api/commit/44bad22f21b7882befe8d11b9713032d69d790fa))
* **streaming:** add mega.nz resolver with direct CDN URL extraction via Mega API ([fb71c2a](https://github.com/nolict/weaboo-api/commit/fb71c2afa633403250d461e6515c7641cb5665f7))
* **streaming:** add mp4upload.com resolver via videojs player.src() extraction ([3600bdd](https://github.com/nolict/weaboo-api/commit/3600bdd4a40bec8f68641751f313d9e3f7817c1b))
* **streaming:** add yourupload.com resolver via jwplayer file extraction ([99d61ee](https://github.com/nolict/weaboo-api/commit/99d61ee7847f89a7e2d3d6602b8db4dee3d211d9))
* **streaming:** remove mp4upload & yourupload resolvers (CDN requires Referer) ([98119cb](https://github.com/nolict/weaboo-api/commit/98119cbdbc7620f13528fe1b5df976a8e034f21a))


### Bug Fixes

* **mapping:** fix cleanTitle unicode escapes, scoreCandidate quote stripping, Jikan LN fallback queries, Samehadaku LN separator slugs, and streaming episode URL from DOM cache ([aaa1861](https://github.com/nolict/weaboo-api/commit/aaa1861c784ecebbf980d8aa0d9f592566e535de))
* **mapping:** resolve slug canonicalization, Jikan multi-query, and cross-provider discovery bugs ([1e1295d](https://github.com/nolict/weaboo-api/commit/1e1295d95f0a63d5bf663339ccfab8445940eab6))
* **mapping:** use native fetch for Animasu detail pages + cover fallback + year-slug discovery ([b6e1b03](https://github.com/nolict/weaboo-api/commit/b6e1b03b91af27aa18710abf4860a717a716e4e7))
* **streaming:** resolve HF proxy stuck, Mega decrypt, Vidhidepro ASN-bound token, Filedon stream, and HF Space concurrency/recovery ([0dc0c73](https://github.com/nolict/weaboo-api/commit/0dc0c73dd75ad7238495f2c77d1b2f45b6da1595))
