import snarkdown from 'snarkdown'
import { sanitizeHtml } from './sanitizeHtml'

// Tailored for static legal prose: adds headings (h1-h4), hr, code, and pre;
// drops the comment-only span/s tags and mention data-* attributes.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'a',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'br',
]
const ALLOWED_ATTR = ['href', 'target', 'rel']

/**
 * Convert operator-authored legal markdown to sanitized HTML via the shared
 * sanitizer. Content is first-party (committed by the operator), so the
 * sanitizer is defense-in-depth.
 */
export function renderLegalMarkdown(md: string): string {
  return sanitizeHtml(snarkdown(md), { allowedTags: ALLOWED_TAGS, allowedAttr: ALLOWED_ATTR })
}
