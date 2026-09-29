/**
 * Convert a legislature's HTML bill document to text for the AI.
 *
 * Two things this does that a naive tag-strip does not:
 *
 * 1. It removes `<script>` and `<style>` ELEMENTS, contents included. Stripping
 *    tags alone leaves CSS rules and JavaScript in the text — an Illinois bill
 *    measured 27,221 characters stripped against 3,824 characters of actual
 *    bill, the rest being Google Translate chrome.
 *
 * 2. It passes the legislature's own redline markup through VERBATIM. States
 *    encode "this language is being removed" as markup, and most also bracket
 *    it, but California uses strike-plus-colour and no brackets at all. With
 *    the markup gone, superseded language reads as operative and summaries
 *    assert provisions the bill does not contain.
 *
 * Deliberately no interpretation. The same strikethrough means different things
 * in different states — and in California it means different things in an
 * Introduced version (a diff against existing law) than in an Amended one (a
 * diff against the previous printing of the bill). Relabelling markup as
 * "[DELETED]" would assert one reading everywhere. Measurement says the model
 * reads the raw notation correctly on its own.
 */

/** Tags whose meaning is the legislature's, passed through untouched. */
const KEEP_TAG = /^(?:<\/?(?:strike|s|del|ins|u|i|b|em|strong)\b[^>]*>|<font\b[^>]*>|<\/font\s*>)$/i

/** Tags that imply a line break in the rendered document. */
const BLOCK_TAG = /^<\/?\s*(?:p|div|br|tr|li|h[1-6])\b[^>]*>$/i

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
}

export function billHtmlToText(html: string): string {
  // Elements, not just tags: the contents go too.
  let s = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')

  const out: string[] = []
  let pos = 0
  for (const m of s.matchAll(/<[^>]*>/g)) {
    const at = m.index ?? 0
    out.push(s.slice(pos, at))
    const tag = m[0]
    if (KEEP_TAG.test(tag)) out.push(tag)
    else if (BLOCK_TAG.test(tag)) out.push('\n')
    else out.push(' ')
    pos = at + tag.length
  }
  out.push(s.slice(pos))

  let text = out.join('')
  for (const [ent, ch] of Object.entries(ENTITIES)) {
    text = text.split(ent).join(ch)
  }
  text = text.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
  text = text.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))

  // Non-breaking spaces (decoded above from &nbsp;/&#160;/&#xA0;) collapse too.
  text = text.replace(/[ \t ]+/g, ' ')
  text = text.replace(/ *\n[ \n]*/g, '\n')
  return text.trim()
}
