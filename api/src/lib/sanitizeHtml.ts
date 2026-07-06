// Server-side HTML sanitizer for user comment content.
//
// Comments are stored verbatim and later interpolated into @-mention notification
// emails (api/src/lib/mentions.ts). On-screen rendering is already safe because
// web/src/components/CommentContent.tsx runs the stored HTML through DOMPurify, but
// the email path does not — so any unsanitized stored HTML is a stored-XSS /
// content-injection vector in mail clients. We therefore sanitize on WRITE.
//
// Runtime constraint: this runs on Cloudflare Workers (workerd) — there is no DOM,
// no jsdom, no `document`, so browser DOMPurify is unavailable. The tiptap editor
// emits a small, well-defined HTML grammar, so a DOM-free allowlist tokenizer is
// sufficient and synchronous (matching the call sites, which want a plain string).
//
// The allowlist intentionally MIRRORS the on-screen renderer's DOMPurify config in
// web/src/components/CommentContent.tsx. Keep the two in sync.

/** Tags allowed in stored comment HTML (mirror of CommentContent.tsx ALLOWED_TAGS). */
const ALLOWED_TAGS = new Set(['p', 'strong', 'em', 'a', 'blockquote', 'ul', 'ol', 'li', 'span', 'br', 's'])

/** Attributes allowed on any allowed tag (mirror of CommentContent.tsx ALLOWED_ATTR). */
const ALLOWED_ATTR = new Set(['href', 'target', 'rel', 'data-type', 'data-id', 'data-label'])

/**
 * Tags whose entire contents must be discarded when the tag is removed (raw-text /
 * script-context elements). For ordinary disallowed tags we drop the tag but keep
 * the inner text; for these we drop the tag AND everything inside it.
 */
const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'title', 'textarea'])

const VOID_TAGS = new Set(['br'])

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** True if an href value uses a safe scheme. Relative/anchor/query URLs are safe. */
function isSafeHref(value: string): boolean {
  // Browsers ignore leading whitespace and control chars (NUL, tab, newline, etc.)
  // when resolving a URL scheme, so strip them all before checking.
  const stripped = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  if (stripped.startsWith('javascript:') || stripped.startsWith('data:') || stripped.startsWith('vbscript:')) {
    return false
  }
  return true
}

/** Parse an attribute string ("href=\"x\" target=_blank") into name/value pairs. */
function parseAttributes(attrStr: string): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = []
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr)) !== null) {
    const name = m[1].toLowerCase()
    let value = m[2] ?? ''
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1)
    }
    attrs.push({ name, value })
  }
  return attrs
}

function buildAttrString(tag: string, attrs: Array<{ name: string; value: string }>): string {
  const parts: string[] = []
  for (const { name, value } of attrs) {
    // Drop anything not on the allowlist. This also drops every on* handler,
    // style, src, etc. since none are listed.
    if (!ALLOWED_ATTR.has(name)) continue
    if (name === 'href' && !isSafeHref(value)) continue
    parts.push(`${name}="${escapeAttr(value)}"`)
  }
  return parts.length ? ' ' + parts.join(' ') : ''
}

/**
 * Sanitize stored comment HTML to the same allowlist the on-screen renderer uses.
 * - Allowed tags are kept (with only allowlisted attributes; href schemes checked).
 * - Disallowed tags are dropped but their inner text is preserved and escaped.
 * - script/style/iframe/etc. are dropped along with their contents.
 * - Text content is HTML-escaped so stray angle brackets can't form new tags.
 */
export function sanitizeCommentHtml(html: string): string {
  if (!html) return ''

  let out = ''
  let i = 0
  const n = html.length
  // Stack of currently-open dropped-content elements (e.g. inside <script>).
  // When non-empty, all text and nested tags are discarded.
  let dropDepth = 0
  let dropTag: string | null = null

  const tagRe = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?\s*>/g

  while (i < n) {
    tagRe.lastIndex = i
    const m = tagRe.exec(html)
    if (!m) {
      // No more tags — emit remaining text.
      if (dropDepth === 0) out += escapeText(html.slice(i))
      break
    }

    const matchStart = m.index
    // Text before this tag.
    if (matchStart > i) {
      if (dropDepth === 0) out += escapeText(html.slice(i, matchStart))
    }

    const isClose = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrStr = m[3] ?? ''

    if (dropDepth > 0) {
      // Inside a drop-content element: discard everything until its matching close.
      if (isClose && tag === dropTag) {
        dropDepth = 0
        dropTag = null
      }
      i = tagRe.lastIndex
      continue
    }

    if (DROP_CONTENT_TAGS.has(tag)) {
      if (!isClose) {
        dropDepth = 1
        dropTag = tag
      }
      // A stray close tag for a drop-content element with no open: just drop it.
      i = tagRe.lastIndex
      continue
    }

    if (ALLOWED_TAGS.has(tag)) {
      if (isClose) {
        out += `</${tag}>`
      } else if (VOID_TAGS.has(tag)) {
        out += `<${tag}>`
      } else {
        const attrs = parseAttributes(attrStr)
        out += `<${tag}${buildAttrString(tag, attrs)}>`
      }
    }
    // Disallowed (but not drop-content) tag: drop the tag, keep surrounding text.

    i = tagRe.lastIndex
  }

  return out
}
