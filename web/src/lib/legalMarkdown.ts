import { marked } from 'marked'
import { sanitizeHtml } from './sanitizeHtml'

// Tailored for static legal prose: block elements including table support,
// inline formatting, links. Drops comment-only span/s tags and data-* attrs.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'a',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'br',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]
const ALLOWED_ATTR = ['href', 'target', 'rel', 'scope', 'colspan', 'rowspan']

/**
 * Convert operator-authored legal markdown to sanitized HTML. marked (GFM)
 * handles tables, proper <p> paragraphs, lists, and CommonMark backslash
 * escapes. DOMPurify is defense-in-depth — content is first-party.
 */
export function renderLegalMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string
  return sanitizeHtml(html, { allowedTags: ALLOWED_TAGS, allowedAttr: ALLOWED_ATTR })
}
