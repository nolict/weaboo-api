import { load } from 'cheerio'

interface ElementNode {
  tag: string
  text?: string
  attributes: Record<string, string>
  children?: ElementNode[]
}

const deepScan = async (url: string): Promise<void> => {
  try {
    console.log(`\n🔍 Deep scanning: ${url}\n`)

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const html = await response.text()
    const $ = load(html)

    const traverse = (element: cheerio.Element): ElementNode => {
      const children = $(element).children()
      if (children.length === 0) {
        return {
          tag: element.tagName,
          text: $(element).text().trim(),
          attributes: element.attribs,
        }
      }

      return {
        tag: element.tagName,
        attributes: element.attribs,
        children: children.map((_i: number, el: cheerio.Element) => traverse(el)).get(),
      }
    }

    const root = $('body').get(0)
    if (root !== undefined) {
      const tree = traverse(root)
      console.log(JSON.stringify(tree, null, 2))
    } else {
      console.log('Could not find body element.')
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`Error during deep scan: ${errorMessage}`)
  }
}

const url = process.argv[2]
if (url === undefined) {
  console.log('Usage: bun run scan <url>')
  console.log('Example: bun run scan https://v1.samehadaku.how/daftar-anime-2/')
  process.exit(1)
}

void deepScan(url)
