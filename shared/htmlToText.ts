/**
 * Pure (DOM-free) HTML→plain-text converter for deriving the text/plain part of
 * an email from its HTML body. Not a full HTML parser — it targets the realistic
 * email markup we emit (block elements, <br>, anchors, basic entities) so every
 * message ships a plain-text alternative (better spam scores, text-only clients).
 * No external dependencies. Mirror copy lives in central/src/lib/htmlToText.ts
 * (central is a standalone package and does not import from shared/).
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
    // Drop style/script blocks (tag + content) entirely.
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Anchors → "text (url)", or just the url when the text already is the url.
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim()
      const url = href.trim()
      if (!text || text === url) return url
      return `${text} (${url})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n')
    .replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, '')        // strip any remaining tags
    .replace(/&[a-z#0-9]+;/gi, (m) => decodeEntities(m)) // decode after stripping
    .replace(/[ \t]+/g, ' ')        // collapse horizontal whitespace
    .replace(/ *\n */g, '\n')       // trim spaces around line breaks
    .replace(/\n{3,}/g, '\n\n')     // collapse blank-line runs
    .trim()
}
