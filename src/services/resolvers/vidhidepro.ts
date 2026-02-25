import axios from 'axios'

import { Logger } from '../../utils/logger'

/**
 * resolveVidhidepro — Resolves a vidhidepro.com (or vidhidefast.com / callistanise.com)
 * embed URL to a direct HLS sub-playlist (.m3u8) URL with absolute segment URLs.
 *
 * Redirect chain:
 *   vidhidepro.com/v/{id} → vidhidefast.com/v/{id} → callistanise.com/v/{id}
 *
 * On the final page there is a Dean Edwards p,a,c,k,e,d packed JS snippet containing
 * a `links` object with HLS URLs:
 *   {
 *     hls2: "https://<cdn>.dramiyos-cdn.com/hls2/.../master.m3u8?t=...&s=...&e=...",
 *     hls4: "/stream/.../master.m3u8",
 *     hls3: "https://<cdn>.cyou/.../master.txt"
 *   }
 *
 * Priority order: hls2 → hls4 → hls3
 *
 * The master.m3u8 contains relative sub-playlist paths (e.g. "index-v1-a1.m3u8?t=...").
 * We fetch the master and resolve the first sub-playlist to an absolute URL, because
 * many players cannot handle relative HLS paths and will stall/stuck on master.m3u8.
 *
 * @param embedUrl  Full embed URL, e.g. "https://vidhidepro.com/v/xbfehxcybpf2"
 * @returns         Direct absolute HLS sub-playlist URL, or null on failure
 */
export async function resolveVidhidepro(embedUrl: string): Promise<string | null> {
  Logger.debug(`🔍 Resolving vidhidepro: ${embedUrl}`)

  try {
    // ── Step 1: Fetch the embed page (follow redirects automatically) ─────────
    // vidhidepro → vidhidefast → callistanise
    const resp = await axios.get<string>(embedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
        Referer: 'https://vidhidepro.com/',
      },
      maxRedirects: 10,
      timeout: 20000,
    })

    const html: string = resp.data
    // Track the final URL after redirects (needed to absolutise relative paths)
    const finalUrl: string =
      (resp.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? embedUrl

    // ── Step 2: Extract the packed JS eval block ──────────────────────────────
    // Pattern: eval(function(p,a,c,k,e,d){...}('...', ...))
    const evalMatch =
      /eval\(function\(p,a,c,k,e,d\)\{.*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)\)\)/m.exec(
        html
      )

    if (evalMatch === null) {
      Logger.warning('⚠️  vidhidepro: no packed JS found in page')
      return null
    }

    const decoded = unpackJs(
      evalMatch[1],
      parseInt(evalMatch[2], 10),
      parseInt(evalMatch[3], 10),
      evalMatch[4].split('|')
    )

    // ── Step 3: Extract links object from decoded JS ──────────────────────────
    // Pattern: var links={"hls2":"...","hls4":"...","hls3":"..."}
    const linksMatch = /(?:var\s+links\s*=\s*|"links"\s*:\s*)\{([^}]+)\}/.exec(decoded)

    if (linksMatch === null) {
      // Fallback: try to find direct m3u8 URL in decoded string
      const m3u8Match = /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/.exec(decoded)
      if (m3u8Match !== null) {
        Logger.debug(`  ✅ vidhidepro resolved via m3u8 fallback: ${m3u8Match[1]}`)
        return m3u8Match[1]
      }
      Logger.warning('⚠️  vidhidepro: links object not found in decoded JS')
      return null
    }

    const linksStr = `{${linksMatch[1]}}`

    // Parse individual keys from the links object string
    const hls2 = extractJsonString(linksStr, 'hls2')
    const hls4 = extractJsonString(linksStr, 'hls4')
    const hls3 = extractJsonString(linksStr, 'hls3')

    // ── Step 4: Pick best available master URL ───────────────────────────────
    // hls2 = external CDN with signed token → best quality & most reliable
    // hls4 may be a relative path like /stream/...
    // hls3 = .txt alias — still a valid playlist
    let masterUrl: string | null = null

    if (hls2 !== null && hls2.length > 0) {
      masterUrl = hls2
    } else if (hls4 !== null && hls4.length > 0) {
      masterUrl = hls4.startsWith('http') ? hls4 : absolutiseUrl(hls4, finalUrl)
    } else if (hls3 !== null && hls3.length > 0) {
      masterUrl = hls3
    }

    if (masterUrl === null) {
      Logger.warning('⚠️  vidhidepro: all link slots are empty')
      return null
    }

    // ── Step 5: Resolve master.m3u8 → sub-playlist absolute URL ──────────────
    // master.m3u8 has relative sub-playlist paths → players stall/stuck on it.
    // Fetch master, parse first EXT-X-STREAM-INF entry, absolutise it.
    const subPlaylist = await resolveMasterM3u8(masterUrl)
    if (subPlaylist !== null) {
      Logger.debug(`  ✅ vidhidepro resolved (sub-playlist): ${subPlaylist.slice(0, 80)}...`)
      return subPlaylist
    }

    // Fallback: return master URL if sub-playlist resolution fails
    Logger.debug(`  ✅ vidhidepro resolved (master fallback): ${masterUrl.slice(0, 80)}...`)
    return masterUrl
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warning(`⚠️  vidhidepro resolver error: ${msg}`)
    return null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * unpackJs — Implements the Dean Edwards p,a,c,k,e,d JS unpacker.
 * Equivalent to the browser's eval() call on the packed block.
 */
function unpackJs(p: string, a: number, _c: number, k: string[]): string {
  let result = p
  const lookup = (val: number): string => {
    const base = val < a ? '' : lookup(Math.floor(val / a))
    const rem = val % a
    return base + (rem > 35 ? String.fromCharCode(rem + 29) : rem.toString(36))
  }

  // Build substitution dictionary
  const dict: Record<string, string> = {}
  let i = k.length
  while (i-- > 0) {
    if (k[i] !== '') dict[lookup(i)] = k[i] ?? ''
  }

  // Replace all tokens
  result = result.replace(/\b\w+\b/g, (token) => dict[token] ?? token)
  return result
}

/**
 * extractJsonString — Pull a string value for `key` from a simple JSON-like object string.
 * Handles both double and single quoted values.
 * e.g. extractJsonString('{"hls2":"https://...","hls4":"/stream/..."}', 'hls2')
 */
function extractJsonString(obj: string, key: string): string | null {
  const re = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`)
  const m = re.exec(obj)
  return m !== null ? m[1] : null
}

/**
 * resolveMasterM3u8 — Fetch a master HLS playlist and return the first sub-playlist
 * as an absolute URL. Sub-playlists contain absolute segment URLs → playable by any player.
 *
 * master.m3u8 structure (dramiyos-cdn.com):
 *   #EXTM3U
 *   #EXT-X-STREAM-INF:BANDWIDTH=411351,RESOLUTION=1128x480,...
 *   index-v1-a1.m3u8?t=...&s=...&e=...    ← relative path, same query string
 *
 * The sub-playlist (index-v1-a1.m3u8) contains fully absolute .ts segment URLs.
 */
async function resolveMasterM3u8(masterUrl: string): Promise<string | null> {
  try {
    const resp = await axios.get<string>(masterUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      timeout: 10000,
    })

    const m3u8 = resp.data
    if (typeof m3u8 !== 'string') return null

    // Find the first non-comment, non-empty line after #EXT-X-STREAM-INF
    const lines = m3u8.split('\n').map((l) => l.trim())
    let nextIsPlaylist = false
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        nextIsPlaylist = true
        continue
      }
      if (nextIsPlaylist && line.length > 0 && !line.startsWith('#')) {
        // Absolutise relative path using master URL as base
        return absolutiseUrl(line, masterUrl)
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * absolutiseUrl — Convert a relative path to an absolute URL using the base page URL.
 */
function absolutiseUrl(path: string, baseUrl: string): string {
  try {
    return new URL(path, baseUrl).toString()
  } catch {
    return path
  }
}
