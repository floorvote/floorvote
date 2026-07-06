/**
 * Pure (React-free) markdown helpers for AI-generated bill summaries.
 * Shared by the web MarkdownSummary renderer and the bill-card model so
 * both the full and short (Feed / list / tooltip) summary paths normalize
 * and strip markdown identically. No external dependencies, no DOM.
 */

// Detect whether a string is HTML (contains at least one tag).
export function isHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text)
}

// Convert a subset of HTML to markdown so the block parser can handle it.
// Handles the realistic Gemini output space: ul/ol/li, p, br, strong/b, em/i.
export function htmlToMarkdown(html: string): string {
  return html
    // ordered list container — drop open, add newline on close
    .replace(/<ol[^>]*>/gi, '')
    .replace(/<\/ol>/gi, '\n')
    // unordered list container
    .replace(/<ul[^>]*>/gi, '')
    .replace(/<\/ul>/gi, '\n')
    // list items: open → "- ", close → newline
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    // paragraphs: open → nothing, close → blank line
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    // line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    // bold (must come before italic to avoid mis-matching nested tags)
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    // italic
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
    // strip any remaining tags
    .replace(/<[^>]+>/g, '')
    // unescape common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // collapse runs of 3+ newlines down to a blank line
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Normalize bullet lists that aren't already newline-separated.
// Handles: • inline bullets ("• Item A. • Item B."), line-start •, and
// dash-style inline bullets ("Intro: - Item one - Item two"). The dash may be
// glued directly to the preceding punctuation with no space ("...2026.- Prohibiting"),
// which is how Gemini sometimes emits lists — the space before the dash is optional.
export function normalizeInlineBullets(text: string): string {
  // • bullets: split any line (or the whole string) on the • separator
  const normalized = text.split('\n').flatMap(line => {
    const t = line.trim()
    if (t.startsWith('•') || t.includes(' •')) {
      return t.split(/\s*•\s*/).filter(Boolean).map(s => `- ${s.trim()}`)
    }
    return [line]
  }).join('\n')

  // Dash-style inline bullets: "Intro: - Word" or "Intro:- Word" → "Intro:\n- Word"
  return normalized.replace(/([.!?:])[ \t]*-[ \t]+([A-Z])/g, '$1\n- $2')
}

/** Strip markdown syntax for compact plain-text previews (bill list cards, sidebar, Feed). */
export function stripMarkdown(text: string): string {
  // If input is HTML (Gemini returns <ul><li>... sometimes), convert first
  const input = isHtml(text) ? htmlToMarkdown(text) : text
  // Normalize • / dash bullets before stripping so they don't bleed into the plain text
  const normalized = normalizeInlineBullets(input)
  return normalized
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s+/gm, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
