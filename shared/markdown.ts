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
// The item may open with a bold label ("... 2026. - **Fees**: Lowers"), the house
// list style, so the capital can sit behind ** or __.
export function normalizeInlineBullets(text: string): string {
  // • bullets: split any line (or the whole string) on the • separator
  const normalized = text.split('\n').flatMap(line => {
    const t = line.trim()
    if (t.startsWith('•') || t.includes(' •')) {
      return t.split(/\s*•\s*/).filter(Boolean).map(s => `- ${s.trim()}`)
    }
    return [line]
  }).join('\n')

  // Dash-style inline bullets: "Intro: - Word" or "Intro:- **Word**" → "Intro:\n- Word"
  return normalized.replace(/([.!?:])[ \t]*-[ \t]+((?:\*\*|__)?[A-Z])/g, '$1\n- $2')
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

/**
 * One block of a normalized summary: a paragraph (`item` null) or one list item.
 * `depth` is the nesting level (two spaces per level) and `marker` is `-` for a
 * bullet or the item's own `1.` for a numbered one.
 */
export type SummaryBlock = { text: string; item: { depth: number; marker: string } | null }

/** The markdown a summary parses from once the web renderer's normalizers have run. */
export function normalizeSummary(raw: string): string {
  const input = isHtml(raw) ? htmlToMarkdown(raw) : raw
  return separateBlocks(normalizeListIndent(normalizeInlineBullets(input)))
}

/**
 * Split normalized markdown into blocks in document order: each paragraph (its
 * lines joined with a space) and each list item, nested ones included. Pure
 * line work: it never produces HTML, so nothing here can carry a tag through.
 */
export function parseSummaryBlocks(md: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ text: para.join(' '), item: null })
    para = []
  }
  for (const line of md.split('\n')) {
    const m = /^( *)([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (m) {
      flush()
      blocks.push({ text: m[3].trim(), item: { depth: Math.floor(m[1].length / 2), marker: /\d/.test(m[2]) ? m[2] : '-' } })
    } else if (!line.trim()) {
      flush()
    } else {
      para.push(line.trim().replace(/^#{1,6}\s+/, ''))
    }
  }
  flush()
  return blocks.filter(b => b.text)
}

function blocksToMarkdown(blocks: SummaryBlock[]): string {
  return blocks.map((b, i) => {
    const line = b.item ? `${'  '.repeat(b.item.depth)}${b.item.marker} ${b.text}` : b.text
    if (i === 0) return line
    // Items of one list sit on consecutive lines; anything else gets a blank line.
    return (blocks[i - 1].item && b.item ? '\n' : '\n\n') + line
  }).join('')
}

/** What an email card shows of a summary, in plain characters. */
export const EMAIL_SUMMARY_BUDGET = 320
/** The block that crosses the budget keeps at least this much, so a list never ends on a stub. */
const EMAIL_SUMMARY_MIN_KEEP = 100
/** A single block longer than this many budgets of raw markdown is cut whatever it counts as. */
const EMAIL_SUMMARY_RAW_CAP_FACTOR = 3

const plainLength = (md: string) => stripMarkdown(md).length

/** Drop what trails a cut: spaces and sentence punctuation, so the ellipsis follows the last word. */
const trimTail = (text: string) => text.replace(/[\s.,;:]+$/, '')

/** Close a bold or emphasis a cut left open, so the cut text still parses as balanced. */
function closeOpenMarkers(text: string): string {
  let out = text
  for (const marker of ['**', '__']) {
    if (out.split(marker).length % 2 === 0) out += marker
  }
  const bare = out.replace(/\*\*|__/g, '')
  if (/(?:^|[\s(])\*(?=[^\s*])[^*]*$/.test(bare)) out += '*'
  if (/(?:^|[\s(])_(?=[^\s_])[^_]*$/.test(bare)) out += '_'
  return out
}

/**
 * Cut markdown text to about `room` plain characters at a word, never mid-word:
 * trailing punctuation dropped, and any bold or emphasis the cut left open closed.
 */
function cutAtWord(md: string, room: number): string {
  let out = ''
  for (const word of md.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word
    if (out && plainLength(next) > room) break
    out = next
  }
  return closeOpenMarkers(trimTail(out))
}

export type AbridgedSummary = { md: string; cut: boolean }

/**
 * The short form of a summary for an email card. Normalizes it as the web
 * renderer does, then keeps blocks in order (the lead paragraph, then list items
 * with their nesting) while the plain-text total stays within the budget.
 *
 * The block that crosses the budget keeps whatever fits, but at least about 100
 * characters, cut at a word and ending in "…". If it fits within that minimum
 * and nothing follows it, the whole summary is kept and `cut` is false.
 *
 * Returns normalized markdown (blank line between blocks, two-space nesting) and
 * whether anything was left out.
 */
export function abridgeSummary(raw: string | null | undefined, budget = EMAIL_SUMMARY_BUDGET): AbridgedSummary {
  const blocks = parseSummaryBlocks(normalizeSummary(raw ?? ''))
  const kept: SummaryBlock[] = []
  let used = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    // A block of markers counts as no text, so cap it by its raw length too.
    const overlong = block.text.length > EMAIL_SUMMARY_RAW_CAP_FACTOR * budget
    const length = overlong ? Infinity : plainLength(block.text)
    if (used + length <= budget) {
      kept.push(block)
      used += length
      continue
    }
    const room = Math.max(budget - used, EMAIL_SUMMARY_MIN_KEEP)
    const shortened = length > room
    const source = overlong ? block.text.slice(0, EMAIL_SUMMARY_RAW_CAP_FACTOR * budget).replace(/\s+\S*$/, '') : block.text
    const cut = shortened || i < blocks.length - 1
    // Whole but followed by more: the ellipsis still goes after the last word, not the period.
    const text = shortened ? cutAtWord(source, room) : cut ? trimTail(block.text) : block.text
    kept.push({ ...block, text: cut ? `${text}…` : text })
    return { md: blocksToMarkdown(kept), cut }
  }
  return { md: blocksToMarkdown(kept), cut: false }
}
