import DOMPurify from 'dompurify'

// Explicit URI allowlist: restrict link schemes to http(s)/mailto/tel. The shape
// (a scheme branch PLUS a non-scheme branch for plain/relative values) intentionally
// mirrors DOMPurify's default, so that non-URI attribute values like target="_blank"
// and rel still pass — a naive /^https?:/ would make DOMPurify reject those and strip
// target/rel.
export const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

// Force rel="noopener noreferrer" on any anchor that opens a new context
// (target=...), closing reverse-tabnabbing on rendered links.
export function forceLinkRel(node: Element) {
  if (node.tagName === 'A' && node.hasAttribute('target')) {
    node.setAttribute('rel', 'noopener noreferrer')
  }
}

export interface SanitizeOptions {
  allowedTags: string[]
  allowedAttr: string[]
}

/**
 * Sanitize an HTML string with the given allowlists. Scopes the forceLinkRel
 * hook to this call (add → sanitize → remove) so it can't leak into other
 * DOMPurify consumers in the app.
 */
export function sanitizeHtml(html: string, { allowedTags, allowedAttr }: SanitizeOptions): string {
  DOMPurify.addHook('afterSanitizeAttributes', forceLinkRel)
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: allowedAttr,
      ALLOWED_URI_REGEXP,
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}
