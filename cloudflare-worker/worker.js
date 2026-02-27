/**
 * Weaboo API — Cloudflare Workers Video Stream Proxy
 *
 * Routes:
 *   GET /stream/:malId/:episode/:provider/:resolution
 *     → If video is archived in HuggingFace (video_store): proxy/redirect to HF raw URL
 *     → Otherwise: proxy the original url_resolved from video_queue
 *     → If neither: 404
 *
 *   GET /health
 *     → Worker health check
 *
 * Environment variables (set in wrangler.toml or CF dashboard):
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (read-only access needed)
 */

// ── Supabase REST client (lightweight, no SDK needed in Workers) ─────────────

/**
 * Query Supabase REST API directly from the Worker.
 * Returns the first matching row or null.
 */
async function supabaseSelect(env, table, filters) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`)
  url.searchParams.set('select', '*')
  url.searchParams.set('limit', '1')

  for (const [col, val] of Object.entries(filters)) {
    if (val === null) {
      url.searchParams.set(col, 'is.null')
    } else {
      url.searchParams.set(col, `eq.${val}`)
    }
  }

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  })

  if (!resp.ok) return null

  const data = await resp.json()
  if (!Array.isArray(data) || data.length === 0) return null
  return data[0]
}

// ── Stream proxy helper ───────────────────────────────────────────────────────

/**
 * Detect if a URL is a HuggingFace dataset resolve URL.
 * HF raw URLs redirect to LFS/CDN — we must follow redirects manually
 * and use a browser-like UA, otherwise CF Workers gets a redirect loop or
 * a 403 from HF's CDN.
 */
function isHuggingFaceUrl(url) {
  try {
    const { hostname } = new URL(url)
    return hostname === 'huggingface.co' || hostname.endsWith('.huggingface.co')
  } catch {
    return false
  }
}

/**
 * Proxy a video stream from a remote URL, forwarding Range headers so
 * the client can seek. Supports both HLS (.m3u8) and progressive MP4.
 *
 * For HuggingFace URLs: follow redirects manually with a browser UA so we
 * land on the actual LFS/CDN URL, then proxy from there.
 * For other URLs: proxy directly.
 */
async function proxyStream(request, targetUrl) {
  const range = request.headers.get('Range')

  // HuggingFace dataset resolve URLs redirect to LFS CDN.
  // CF Workers fetch() follows redirects automatically but HF requires a
  // browser-like User-Agent AND the redirect destination (cdn-lfs.huggingface.co)
  // needs proper Range header forwarding. We resolve the final URL first, then
  // proxy from there directly to avoid double-hop issues.
  let finalUrl = targetUrl
  if (isHuggingFaceUrl(targetUrl)) {
    try {
      // Use HEAD to follow HF redirects and discover the final CDN URL without
      // consuming any body bytes. HF dataset resolve URLs redirect to
      // cdn-lfs-us-1.huggingface.co — we need that final URL for Range requests.
      const headResp = await fetch(targetUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: '*/*',
        },
        redirect: 'follow',
      })

      // After following redirects, headResp.url is the final CDN URL
      if (headResp.url && headResp.url !== targetUrl) {
        finalUrl = headResp.url
      }

      // Now do the real GET request to the final CDN URL, with Range if present
      const getHeaders = new Headers()
      getHeaders.set(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      )
      if (range !== null) getHeaders.set('Range', range)

      const cdnResp = await fetch(finalUrl, { headers: getHeaders })

      const responseHeaders = new Headers()
      responseHeaders.set('Content-Type', 'video/mp4')
      const cl = cdnResp.headers.get('Content-Length')
      if (cl !== null) responseHeaders.set('Content-Length', cl)
      const cr = cdnResp.headers.get('Content-Range')
      if (cr !== null) responseHeaders.set('Content-Range', cr)
      const ar = cdnResp.headers.get('Accept-Ranges')
      // HF CDN supports Range — always advertise this even if upstream didn't send it
      responseHeaders.set('Accept-Ranges', ar ?? 'bytes')
      responseHeaders.set('Content-Disposition', 'inline')
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      responseHeaders.set('Access-Control-Allow-Headers', 'Range')
      responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

      return new Response(cdnResp.body, { status: cdnResp.status, headers: responseHeaders })
    } catch (err) {
      return new Response(`Failed to resolve HuggingFace URL: ${err.message}`, { status: 502 })
    }
  }

  // ── Non-HF URL: proxy directly ───────────────────────────────────────────
  const headers = new Headers()
  if (range !== null) headers.set('Range', range)
  headers.set(
    'User-Agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  )

  const upstream = await fetch(finalUrl, { headers })

  // Build response headers — expose to browser
  const responseHeaders = new Headers()

  // Normalise Content-Type: some CDNs (e.g. Cloudflare R2 via Filedon) send
  // 'application/octet-stream' or 'binary/octet-stream' which also triggers
  // download. Force 'video/mp4' for any non-HLS binary response so the browser
  // treats it as an inline video stream.
  const contentType = upstream.headers.get('Content-Type') ?? ''
  if (
    contentType.includes('mpegurl') ||
    contentType.includes('x-mpegurl') ||
    finalUrl.includes('.m3u8')
  ) {
    responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl')
  } else {
    // For MP4 / octet-stream / anything else — force video/mp4 so browser streams inline
    responseHeaders.set('Content-Type', 'video/mp4')
  }

  const contentLength = upstream.headers.get('Content-Length')
  if (contentLength !== null) responseHeaders.set('Content-Length', contentLength)

  const contentRange = upstream.headers.get('Content-Range')
  if (contentRange !== null) responseHeaders.set('Content-Range', contentRange)

  const acceptRanges = upstream.headers.get('Accept-Ranges')
  if (acceptRanges !== null) responseHeaders.set('Accept-Ranges', acceptRanges)

  // Explicitly DO NOT forward Content-Disposition — CDNs like Filedon/R2 send
  // 'attachment; filename=...' which forces browser download instead of streaming.
  responseHeaders.set('Content-Disposition', 'inline')

  // CORS — allow any origin so video players on any domain can access
  responseHeaders.set('Access-Control-Allow-Origin', '*')
  responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  responseHeaders.set('Access-Control-Allow-Headers', 'Range')
  responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

// ── HLS m3u8 rewriter ────────────────────────────────────────────────────────

/**
 * For HLS streams: rewrite segment URLs in .m3u8 playlists so all
 * .ts segment requests also go through this Worker (avoiding CORS issues).
 * Relative URLs are absolutised using the m3u8 base URL.
 */
async function proxyM3u8(request, targetUrl, workerBase) {
  const upstream = await fetch(targetUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: '*/*',
    },
    redirect: 'follow',
  })

  if (!upstream.ok) {
    return new Response('Failed to fetch playlist', { status: 502 })
  }

  const text = await upstream.text()
  const baseUrl = new URL(targetUrl)
  const basePath = baseUrl.origin + baseUrl.pathname.replace(/\/[^/]*$/, '')

  // Rewrite each segment/sub-playlist line to go through our proxy
  const rewritten = text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) return line

      // Absolutise relative URLs
      let absoluteUrl = trimmed
      if (!trimmed.startsWith('http')) {
        absoluteUrl = trimmed.startsWith('/') ? `${baseUrl.origin}${trimmed}` : `${basePath}/${trimmed}`
      }

      // Route segment through Worker proxy endpoint
      const encoded = encodeURIComponent(absoluteUrl)
      return `${workerBase}/proxy?url=${encoded}`
    })
    .join('\n')

  return new Response(rewritten, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
    },
  })
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const workerBase = `${url.protocol}//${url.host}`

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', worker: 'weaboo-stream' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    // ── Generic proxy (for rewritten HLS segment URLs) ────────────────────────
    // GET /proxy?url=<encoded_url>
    if (url.pathname === '/proxy') {
      const targetRaw = url.searchParams.get('url')
      if (targetRaw === null) {
        return new Response('Missing url param', { status: 400 })
      }
      let targetUrl
      try {
        targetUrl = decodeURIComponent(targetRaw)
        new URL(targetUrl) // validate
      } catch {
        return new Response('Invalid url param', { status: 400 })
      }
      return proxyStream(request, targetUrl)
    }

    // ── Main stream route ─────────────────────────────────────────────────────
    // GET /stream/:malId/:episode/:provider/:resolution
    const streamMatch = /^\/stream\/(\d+)\/(\d+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (streamMatch === null) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const [, malIdStr, episodeStr, provider, resolutionRaw] = streamMatch
    const malId = parseInt(malIdStr, 10)
    const episode = parseInt(episodeStr, 10)
    const resolution = resolutionRaw === 'unknown' ? null : resolutionRaw

    // ── Step 1: Check video_store (HuggingFace archived) ────────────────────
    const storeFilters = { mal_id: malId, episode, provider, resolution }
    const stored = await supabaseSelect(env, 'video_store', storeFilters)

    if (stored !== null && typeof stored.hf_direct_url === 'string') {
      const isM3u8 = stored.hf_direct_url.includes('.m3u8')
      if (isM3u8) {
        return proxyM3u8(request, stored.hf_direct_url, workerBase)
      }
      return proxyStream(request, stored.hf_direct_url)
    }

    // ── Step 2: Fall back to video_queue url_resolved (not archived yet) ────
    const queueFilters = { mal_id: malId, episode, provider, resolution }
    const queued = await supabaseSelect(env, 'video_queue', queueFilters)

    if (queued !== null && typeof queued.video_url === 'string') {
      const isM3u8 = queued.video_url.includes('.m3u8')
      if (isM3u8) {
        return proxyM3u8(request, queued.video_url, workerBase)
      }
      return proxyStream(request, queued.video_url)
    }

    // ── Step 3: Nothing available ────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        error: 'Stream not available',
        detail: `No video found for mal_id=${malId} episode=${episode} provider=${provider} resolution=${resolution ?? 'unknown'}`,
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    )
  },
}
