/**
 * abridgeSummary: the short rendering of a summary an email card shows (#992).
 * All fixture text is invented; only the shape (a lead plus a bold-label list)
 * follows real summaries.
 */
import { describe, it, expect } from 'vitest'
import { abridgeSummary, stripMarkdown } from './markdown'

/** `n` words, 5n-1 plain characters. */
const filler = (n: number) => Array(n).fill('word').join(' ')
const plainLen = (md: string) => stripMarkdown(md).length
const LEAD = 'Revises the permit renewal process.'
const itemLines = (md: string) => md.split('\n').filter(l => /^\s*([-*+]|\d+\.)\s/.test(l))

const GLUED_BOLD = 'Shifts petition signature gathering to an electronic system in stages. - **Devices**: Requires each collection device to scan an ID card. - **Deadlines**: Requires 25% of signatures to be electronic by 2029. - **Effective date**: Takes effect on July 1, 2027.'
const GLUED = 'Repeals and replaces the old rules with new ones.- Prohibiting a practice in **some cases**.- Capping a fee at $25,000.'

describe('abridgeSummary: the budget', () => {
  it('keeps the lead and the whole items that fit, then cuts the next item at a word ending in an ellipsis', () => {
    const raw = [
      LEAD,
      `- **Fees**: ${filler(30)}`,
      `- **Forms**: ${filler(30)}`,
      `- **Dates**: ${filler(30)}`,
      `- **Audits**: ${filler(30)}`,
    ].join('\n')
    const { md, cut } = abridgeSummary(raw)
    const lines = md.split('\n').filter(Boolean)
    expect(cut).toBe(true)
    expect(lines[0]).toBe(LEAD)
    expect(lines[1]).toBe(`- **Fees**: ${filler(30)}`)
    expect(lines[2]).toMatch(/^- \*\*Forms\*\*: (word )+word…$/)
    expect(lines).toHaveLength(3)
    expect(md).not.toContain('Dates')
    expect(md).not.toContain('Audits')
    expect(plainLen(md.replace('…', ''))).toBeLessThanOrEqual(320)
  })

  it('returns a summary under the budget whole and says it was not cut', () => {
    const raw = `${LEAD}\n\n- **Fees**: Lowers a fee.\n- **Forms**: Adds a form.\n- **Dates**: Starts in July.`
    const { md, cut } = abridgeSummary(raw)
    expect(cut).toBe(false)
    expect(md).toBe(raw)
    expect(md).not.toContain('…')
  })

  it('returns text of exactly 320 characters whole, and cuts one of 321', () => {
    const exact = filler(64).slice(0, 319) + 'x'
    expect(exact).toHaveLength(320)
    expect(abridgeSummary(exact)).toEqual({ md: exact, cut: false })
    const r = abridgeSummary(`${exact} y`)
    expect(r.cut).toBe(true)
    expect(r.md.endsWith('…')).toBe(true)
  })

  it('never cuts when many short items stay inside the budget', () => {
    const raw = ['Lead.', ...Array.from({ length: 8 }, (_, i) => `- Item ${i}.`)].join('\n')
    const { md, cut } = abridgeSummary(raw)
    expect(cut).toBe(false)
    expect(itemLines(md)).toHaveLength(8)
  })

  it('keeps about 100 characters of the cut item when the budget is nearly spent', () => {
    const raw = `${filler(63)}\n- ${filler(40)}`
    expect(plainLen(filler(63))).toBe(314)
    const { md, cut } = abridgeSummary(raw)
    expect(cut).toBe(true)
    const item = itemLines(md)[0].replace(/^- /, '').replace(/…$/, '')
    expect(item.length).toBeGreaterThanOrEqual(95)
    expect(item.length).toBeLessThanOrEqual(100)
  })

  it('keeps a crossing item whole when it fits the 100-character minimum and nothing follows it', () => {
    const raw = `${filler(60)}\n- ${filler(18)}`
    const { md, cut } = abridgeSummary(raw)
    expect(cut).toBe(false)
    expect(md).toBe(`${filler(60)}\n\n- ${filler(18)}`)
  })

  it('marks a kept crossing item with an ellipsis when more items follow it', () => {
    const raw = `${filler(60)}\n- ${filler(18)}\n- ${filler(18)}`
    const { md, cut } = abridgeSummary(raw)
    expect(cut).toBe(true)
    expect(itemLines(md)).toEqual([`- ${filler(18)}…`])
  })

  it('treats empty and whitespace-only input as nothing', () => {
    expect(abridgeSummary('')).toEqual({ md: '', cut: false })
    expect(abridgeSummary('   \n  ')).toEqual({ md: '', cut: false })
  })
})

describe('abridgeSummary: where it cuts', () => {
  it('cuts prose over the budget at a word and ends in an ellipsis', () => {
    const { md, cut } = abridgeSummary(filler(100))
    expect(cut).toBe(true)
    expect(md).toMatch(/^(word )+word…$/)
    expect(plainLen(md.replace('…', ''))).toBeLessThanOrEqual(320)
    expect(plainLen(md.replace('…', ''))).toBeGreaterThan(300)
  })

  it('closes a bold label the cut falls inside', () => {
    const raw = `${filler(54)}\n- **${filler(25)}**: ${filler(30)}`
    const { md, cut } = abridgeSummary(raw)
    expect(cut).toBe(true)
    const item = itemLines(md)[0]
    expect(item.match(/\*\*/g)).toHaveLength(2)
    expect(item).toMatch(/\*\*…$/)
  })

  it('closes an underscore bold the cut falls inside', () => {
    const raw = `${filler(54)}\n- __${filler(25)}__: ${filler(30)}`
    const item = itemLines(abridgeSummary(raw).md)[0]
    expect(item.match(/__/g)).toHaveLength(2)
    expect(item).toMatch(/__…$/)
  })

  it('trims trailing punctuation before the ellipsis', () => {
    for (const p of [',', ';', ':']) {
      const { md } = abridgeSummary(Array(100).fill(`word${p}`).join(' '))
      expect(md.endsWith('word…')).toBe(true)
      expect(md).not.toMatch(/[,;:]…$/)
    }
  })

  it('trims trailing punctuation inside a bold the cut closes', () => {
    const raw = `${filler(54)}\n- **${Array(25).fill('word:').join(' ')}** ${filler(30)}`
    expect(itemLines(abridgeSummary(raw).md)[0]).toMatch(/word\*\*…$/)
  })

  it('closes a single-marker emphasis the cut falls inside', () => {
    for (const m of ['*', '_']) {
      const item = itemLines(abridgeSummary(`${filler(54)}\n- ${m}${filler(40)}${m} tail`).md)[0]
      expect(item.split(m).length - 1).toBe(2)
      expect(item.endsWith(`${m}…`)).toBe(true)
    }
  })

  it('leaves a lone asterisk that is not emphasis alone', () => {
    const { md } = abridgeSummary(`${filler(54)}\n- 5 * 3 ${filler(40)}`)
    expect(itemLines(md)[0].split('*').length - 1).toBe(1)
  })

  it('trims final punctuation before the ellipsis on a whole crossing item that more items follow', () => {
    const raw = `${filler(60)}\n- ${filler(18)}.\n- ${filler(18)}`
    expect(itemLines(abridgeSummary(raw).md)).toEqual([`- ${filler(18)}…`])
  })

  it('trims a final period before the ellipsis on a cut', () => {
    const { md } = abridgeSummary(Array(100).fill('word.').join(' '))
    expect(md.endsWith('word…')).toBe(true)
  })

  it('caps a block of markers that count as no text, so it cannot bypass the budget', () => {
    const { md, cut } = abridgeSummary('**** '.repeat(3000))
    expect(cut).toBe(true)
    expect(md.length).toBeLessThanOrEqual(3 * 320 + 10)
    expect(md.endsWith('…')).toBe(true)
  })

  it('counts several paragraphs against one budget, cutting the one that crosses it', () => {
    const { md, cut } = abridgeSummary(`${filler(30)}\n\n${filler(30)}\n\n${filler(30)}`)
    expect(cut).toBe(true)
    const paras = md.split('\n\n')
    expect(paras).toHaveLength(3)
    expect(paras[2].endsWith('…')).toBe(true)
  })
})

describe('abridgeSummary: structure', () => {
  it('keeps nesting: two spaces per level, whatever indent the model used', () => {
    const raw = `${LEAD}\n- **Parent**: Does a thing.\n    - Child one.\n    - Child two.\n        - Grandchild.\n- **Next**: Another thing.`
    const { md, cut } = abridgeSummary(raw)
    expect(cut).toBe(false)
    expect(md.split('\n').filter(Boolean)).toEqual([
      LEAD,
      '- **Parent**: Does a thing.',
      '  - Child one.',
      '  - Child two.',
      '    - Grandchild.',
      '- **Next**: Another thing.',
    ])
  })

  it('cuts a nested item at its own depth and drops what follows it', () => {
    const raw = `${filler(50)}\n- Parent.\n  - ${filler(40)}\n  - Dropped.\n- Also dropped.`
    const { md } = abridgeSummary(raw)
    const lines = md.split('\n').filter(Boolean)
    expect(lines[1]).toBe('- Parent.')
    expect(lines[2]).toMatch(/^ {2}- (word )+word…$/)
    expect(md).not.toContain('ropped')
  })

  it('counts nested items against the budget in document order', () => {
    const raw = `${LEAD}\n- A.\n  - ${filler(60)}\n- Last item.`
    const { md, cut } = abridgeSummary(raw)
    expect(cut).toBe(true)
    expect(md).not.toContain('Last item')
  })

  it('keeps ordered lists ordered', () => {
    const { md } = abridgeSummary(`${LEAD}\n1. First step.\n2. Second step.`)
    expect(md.split('\n').filter(Boolean)).toEqual([LEAD, '1. First step.', '2. Second step.'])
  })

  it('keeps a paragraph that follows a list as its own block', () => {
    const { md } = abridgeSummary(`${LEAD}\n- One.\n- Two.\nEffective January 1, 2027.`)
    expect(md).toBe(`${LEAD}\n\n- One.\n- Two.\n\nEffective January 1, 2027.`)
  })
})

describe('abridgeSummary: normalizes first, as the web renderer does', () => {
  it('turns an HTML summary into markdown blocks', () => {
    const { md, cut } = abridgeSummary('<p>Lead sentence here.</p><ul><li>One</li><li><strong>Two</strong> more</li></ul>')
    expect(cut).toBe(false)
    expect(md.split('\n').filter(Boolean)).toEqual(['Lead sentence here.', '- One', '- **Two** more'])
  })

  it('splits a one-line list whose items open with a bold label', () => {
    const { md } = abridgeSummary(GLUED_BOLD)
    expect(md.split('\n').filter(Boolean)).toEqual([
      'Shifts petition signature gathering to an electronic system in stages.',
      '- **Devices**: Requires each collection device to scan an ID card.',
      '- **Deadlines**: Requires 25% of signatures to be electronic by 2029.',
      '- **Effective date**: Takes effect on July 1, 2027.',
    ])
  })

  it('splits dash bullets glued to the lead', () => {
    const { md } = abridgeSummary(GLUED)
    expect(itemLines(md)).toEqual(['- Prohibiting a practice in **some cases**.', '- Capping a fee at $25,000.'])
  })
})
