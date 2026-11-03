import { describe, it, expect } from 'vitest'
import { renderSampleEmail } from '../../src/lib/sampleEmails'

// The QA sample emails show every summary case the abridged card has, so one send of each
// type shows what a reader sees: a list that is cut, prose that is cut, and summaries that fit.
const LINK = 'Full summary on FloorVote →'
const count = (html: string, needle: string) => html.split(needle).length - 1

describe('sample digest: every summary case', () => {
  const { html } = renderSampleEmail('digest', 'https://ut.example.test')

  it('cuts exactly two cards, each ending in an ellipsis before the "Full summary" link', () => {
    expect(count(html, LINK)).toBe(2)
    expect(count(html, `…</`)).toBeGreaterThanOrEqual(2)
  })

  it('cuts a long list: the lead and the first items stay, the last item does not', () => {
    expect(html).toContain('Accepted IDs')
    expect(html).not.toContain('Reporting')
    expect(html).toContain('<li')
  })

  it('cuts a long prose-only summary at a word, with no list in that card', () => {
    expect(html).toContain('Lets cities and towns adopt ranked-choice voting')
    // The prose's closing words are cut away, and the cut ends in an ellipsis.
    expect(html).not.toContain('administrators, and every ballot')
    expect(html).toMatch(/ranked-choice voting[^<]{200,}…<\/p>/)
  })

  it('shows a short list whole: both items, no ellipsis in its block, no link after it', () => {
    const start = html.indexOf('Authorizes secure 24-hour drop boxes')
    const block = html.slice(start, html.indexOf('</ul>', start))
    expect(block).toContain('Puts at least one box at each town hall.')
    expect(block).toContain('Sets chain-of-custody rules for collecting ballots.')
    expect(block).not.toContain('…')
    expect(html.slice(html.indexOf('</ul>', start), html.indexOf('</ul>', start) + 400)).not.toContain(LINK)
  })

  it('shows short prose whole: no ellipsis and no link in its card', () => {
    for (const sentence of [
      'Sets minimum hours and staffing for early voting sites in every county.',
      'Registers eligible residents to vote automatically when they get or renew a license, unless they opt out.',
    ]) {
      const at = html.indexOf(sentence)
      expect(at).toBeGreaterThan(-1)
      const after = html.slice(at, at + sentence.length + 300)
      expect(after.slice(sentence.length, sentence.length + 12)).not.toContain('…')
      expect(after).not.toContain(LINK)
    }
  })
})

describe('sample mention: a long list summary that is cut', () => {
  const { html } = renderSampleEmail('mention', 'https://ut.example.test')

  it('shows the lead and some items, an ellipsis, and the link, once', () => {
    expect(html).toContain('Requires photo identification to vote in person and by mail')
    expect(html).toContain('<li')
    // The ellipsis is in the summary block itself, between the lead and the link that follows it.
    const block = html.slice(html.indexOf('Requires photo identification'), html.indexOf(LINK))
    expect(block).toContain('<li')
    expect(block).toContain('…')
    expect(count(html, LINK)).toBe(1)
    expect(html).not.toContain('Reporting')
  })
})

describe('sample reply: a short list that fits', () => {
  const { html } = renderSampleEmail('reply', 'https://ut.example.test')

  it('shows the whole list and no "Full summary" link', () => {
    expect(html).toContain('<li')
    expect(html).toContain('Issues a free voter ID on request.')
    expect(html).not.toContain(LINK)
    expect(html).not.toContain('…')
  })
})
