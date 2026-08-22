import { marked } from 'marked'
import { sanitizeHtml } from './sanitizeHtml'

// Tailored for static legal prose: block elements including table support,
// inline formatting, links. Drops comment-only span/s tags and data-* attrs.
// `id` is allowed so the in-document table of contents can link to sections.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'a',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'br',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]
const ALLOWED_ATTR = ['href', 'target', 'rel', 'scope', 'colspan', 'rowspan', 'id']

/**
 * Anchor slug for a heading. Kept in sync with the `#...` targets written into
 * each document's TABLE OF CONTENTS — legalDocs.toc.test.ts fails if they drift.
 */
export function headingSlug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
}

/**
 * Convert operator-authored legal markdown to sanitized HTML. marked (GFM)
 * handles tables, proper <p> paragraphs, lists, and CommonMark backslash
 * escapes. Headings carry an id so the document's own TOC links resolve.
 * DOMPurify is defense-in-depth — content is first-party.
 */
export function renderLegalMarkdown(md: string): string {
  const renderer = new marked.Renderer()
  renderer.heading = function ({ tokens, depth }) {
    const inner = this.parser.parseInline(tokens)
    const plain = tokens.map((t) => ('raw' in t ? t.raw : '')).join('')
    return `<h${depth} id="${headingSlug(plain)}">${inner}</h${depth}>\n`
  }
  const html = marked.parse(md, { async: false, renderer }) as string
  return sanitizeHtml(html, { allowedTags: ALLOWED_TAGS, allowedAttr: ALLOWED_ATTR })
}
