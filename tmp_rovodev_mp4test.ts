// Test berbagai Referer untuk mp4upload CDN
const cdnUrl = 'https://a4.mp4upload.com:183/d/xkxwdzllz3b4quuonsvayp2sci3fjekcovdkjyg4un25j3qfpx2b2zylwf63r3n5wm5p7c4q/video.mp4'

const referers = [
  'https://www.mp4upload.com/',
  'https://www.mp4upload.com/embed-vmr3rjexl9cp.html',
  'https://v1.samehadaku.how/',
  '', // no referer
]

for (const referer of referers) {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Range': 'bytes=0-100',
  }
  if (referer) headers['Referer'] = referer

  try {
    const res = await fetch(cdnUrl, { headers })
    console.log(`Referer: "${referer}" → Status: ${res.status} ${res.statusText}`)
  } catch (e) {
    console.log(`Referer: "${referer}" → Error: ${e}`)
  }
}
