/**
 * Pure (DOM-free) HTML→plain-text converter for deriving the text/plain part of
 * an email from its HTML body. MIRROR of shared/htmlToText.ts — central is a
 * standalone package and does not import from shared/. Keep the two in sync.
 */

const BLOCK_TAGS = 'p|div|h[1-6]|li|tr|table|ul|ol|section|header|footer|blockquote'

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Numeric entities (decimal + hex) — covers &#39; and typographic chars like
    // &#8212; / &#x2019; emitted by hand-authored templates.
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&') // last, so we don't double-decode entities like &amp;lt;
}

export function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim()
      const url = href.trim()
      if (!text || text === url) return url
      return `${text} (${url})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n')
    .replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (m) => decodeEntities(m))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
