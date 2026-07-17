import snarkdown from 'snarkdown'
import { sanitizeHtml } from './sanitizeHtml'

// Tailored for static legal prose: adds headings (h1-h4), hr, code, and pre;
// drops the comment-only span/s tags and mention data-* attributes.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'a',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'br',
]
const ALLOWED_ATTR = ['href', 'target', 'rel']

// snarkdown does not implement CommonMark backslash escapes, so generator-produced
// legal docs (which over-escape inert punctuation like "1\." so it is not parsed as a
// list) render the backslash literally. Strip a backslash before non-HTML-structural
// ASCII punctuation on the rendered HTML: snarkdown has already parsed the markdown, so
// this cannot re-trigger it, and excluding < > & " ' leaves tags/attrs/entities intact.
const UNESCAPE_PUNCT = /\\([-!#$%()*+,.\/:;=?@[\]^_`{|}~])/g

/**
 * Convert operator-authored legal markdown to sanitized HTML via the shared
 * sanitizer. Content is first-party (committed by the operator), so the
 * sanitizer is defense-in-depth.
 */
export function renderLegalMarkdown(md: string): string {
  // Strip trailing horizontal whitespace per line before parsing. Generator-produced
  // docs often have trailing two-space hard-breaks (CommonMark) that snarkdown
  // misreads as in-list hard-breaks, collapsing ordered/unordered lists into a single
  // <li> with <br> separators. The source should be clean, but strip defensively.
  const cleaned = md.replace(/[ \t]+$/gm, '')
  const html = snarkdown(cleaned).replace(UNESCAPE_PUNCT, '$1')
  return sanitizeHtml(html, { allowedTags: ALLOWED_TAGS, allowedAttr: ALLOWED_ATTR })
}
