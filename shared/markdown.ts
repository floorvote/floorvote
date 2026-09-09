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

/**
 * Insert the blank lines a model omits, so a CommonMark parser sees the blocks
 * it intended.
 *
 * Models write one block per line with no blank line between them. CommonMark
 * then treats a prose line following a bullet as a LAZY CONTINUATION of that
 * bullet, so a summary ending "…second thing.\nEffective January 1, 2026." puts
 * the effective date inside the last list item, joined without even a space.
 * Alternating prose and lists is mangled the same way.
 *
 * Only one rule is needed: a non-list line directly after a list line starts a
 * new block. A list following a paragraph already parses correctly, because
 * CommonMark lets a bullet list interrupt a paragraph.
 */
export function separateBlocks(text: string): string {
  const isListLine = (l: string) => /^[ \t]*([-*+]|\d+\.)\s/.test(l)
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const prev = lines[i - 1]
    const cur = lines[i]
    if (prev !== undefined && prev.trim() && cur.trim() && isListLine(prev) && !isListLine(cur)) {
      out.push('')
    }
    out.push(cur)
  }
  return out.join('\n')
}

/**
 * Normalize list indentation to two spaces per level.
 *
 * Models indent nested items by two, four, or six spaces without much
 * consistency. CommonMark measures nesting from the parent item's content
 * column, and treats anything four or more columns past it as an indented code
 * block -- so a six-space "child" under "- parent" renders as <pre>, not a
 * nested list. Snapping each list line to at most one level deeper than the
 * line above makes nesting depend on the model's INTENT (it indented further)
 * rather than on hitting an exact column.
 */
export function normalizeListIndent(text: string): string {
  const listLine = /^([ \t]*)(([-*+]|\d+\.)\s+)(.*)$/
  const depths: number[] = []   // raw indent width at each rendered level
  return text.split('\n').map(line => {
    const m = listLine.exec(line)
    if (!m) { depths.length = 0; return line }
    const raw = m[1].replace(/\t/g, '  ').length
    while (depths.length && raw < depths[depths.length - 1]) depths.pop()
    if (!depths.length || raw > depths[depths.length - 1]) depths.push(raw)
    return '  '.repeat(depths.length - 1) + m[2] + m[4]
  }).join('\n')
}
