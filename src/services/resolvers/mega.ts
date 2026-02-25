import axios from 'axios'

import { Logger } from '../../utils/logger'

/**
 * resolveMega — Resolves a mega.nz embed URL to a direct CDN download URL.
 *
 * URL format: https://mega.nz/embed/{NODE_ID}#{KEY}
 *
 * Flow:
 *   1. Parse NODE_ID from embed URL
 *   2. POST to Mega API (/cs) with action "g" to get file metadata
 *   3. Extract `g` field (CDN download URL) from response
 *   4. Return CDN URL — supports HTTP Range requests (seekable)
 *
 * Note: Mega does NOT use HLS/DASH. The resolved URL is a direct progressive
 * download URL that supports Range requests for seeking. The file content is
 * AES-128-CTR encrypted on Mega's side, but the CDN URL itself is publicly
 * accessible without further auth headers.
 *
 * @param embedUrl  Full embed URL, e.g. "https://mega.nz/embed/qwBEiQwQ#Z7yv..."
 * @returns         Direct CDN download URL, or null on failure
 */
export async function resolveMega(embedUrl: string): Promise<string | null> {
  Logger.debug(`🔍 Resolving mega: ${embedUrl}`)

  try {
    // ── Step 1: Parse NODE_ID from URL ────────────────────────────────────────
    // Format: https://mega.nz/embed/{NODE_ID}#{KEY}
    // Also handle: https://mega.nz/file/{NODE_ID}#{KEY}
    const nodeMatch = /mega\.nz\/(?:embed|file)\/([A-Za-z0-9_-]+)/.exec(embedUrl)
    if (nodeMatch === null) {
      Logger.warning(`⚠️  mega: cannot parse NODE_ID from "${embedUrl}"`)
      return null
    }

    const nodeId = nodeMatch[1]

    // ── Step 2: POST to Mega API to get download URL ──────────────────────────
    // Endpoint: https://g.api.mega.co.nz/cs
    // Body: array of commands (batch API)
    // Action "g" with "g":1 = request download URL
    const apiUrl = 'https://g.api.mega.co.nz/cs'
    const response = await axios.post<MegaApiResponse[]>(apiUrl, [{ a: 'g', g: 1, p: nodeId }], {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Origin: 'https://mega.nz',
        Referer: 'https://mega.nz/',
      },
      timeout: 15000,
      params: {
        id: Math.floor(Math.random() * 0xffffffff).toString(16), // random request id
      },
    })

    const data = response.data

    // ── Step 3: Extract CDN URL from response ────────────────────────────────
    // Response is an array matching the request commands array
    // For action "g", the result object contains:
    //   g:  direct CDN URL (string)  ← what we want
    //   s:  file size in bytes
    //   at: encrypted file attributes (AES-128-CBC, contains filename etc.)
    if (!Array.isArray(data) || data.length === 0) {
      Logger.warning('⚠️  mega: unexpected API response format')
      return null
    }

    const result = data[0]

    // Mega API returns a negative integer on error (e.g. -9 = ENOENT, -17 = rate limit)
    if (typeof result === 'number') {
      const errorMsg = getMegaErrorMessage(result)
      Logger.warning(`⚠️  mega: API error ${result} — ${errorMsg}`)
      return null
    }

    if (typeof result !== 'object' || result === null) {
      Logger.warning('⚠️  mega: API returned unexpected result type')
      return null
    }

    const cdnUrl = result.g
    if (typeof cdnUrl !== 'string' || cdnUrl.length === 0) {
      Logger.warning('⚠️  mega: no CDN URL in API response')
      return null
    }

    Logger.debug(`  ✅ mega resolved: ${cdnUrl.slice(0, 80)}...`)
    return cdnUrl
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warning(`⚠️  mega resolver error: ${msg}`)
    return null
  }
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface MegaFileResult {
  g: string // CDN download URL
  s: number // file size in bytes
  at: string // encrypted attributes (base64)
}

// API response is either a MegaFileResult object or a negative error code integer
type MegaApiResponse = MegaFileResult | number

// ── Error code reference ──────────────────────────────────────────────────────

function getMegaErrorMessage(code: number): string {
  const errors: Record<number, string> = {
    [-1]: 'EINTERNAL — internal error',
    [-2]: 'EARGS — invalid arguments',
    [-3]: 'EAGAIN — rate limited, retry later',
    [-4]: 'ERATELIMIT — too many requests',
    [-9]: 'ENOENT — file not found or expired',
    [-11]: 'EACCESS — access denied',
    [-14]: 'EBLOCKED — file blocked',
    [-17]: 'ETOOMANYCONNECTIONS — too many connections',
    [-18]: 'EOVERQUOTA — over bandwidth quota',
  }
  return errors[code] ?? `unknown error code ${code}`
}
