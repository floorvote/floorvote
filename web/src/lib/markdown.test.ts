import { describe, it, expect } from 'vitest'
import { normalizeInlineBullets, stripMarkdown } from './markdown'

// Real-world Gemini output: dash glued to the preceding period with no space,
// and the whole list on a single line (see CA SB1164).
const GLUED = 'Repealing and replacing the California Voting Rights Act of 2001 with the California Voting Rights Act of 2026.- Prohibiting political subdivisions from engaging in **voter suppression**.- Capping the recovery of attorney fees at $25,000 and other costs at $50,000.'

// The same failure in the house list style: every item opens with a bold label.
const GLUED_BOLD = 'Shifts petition signature gathering to an electronic system in stages. - **Devices**: Requires each collection device to scan an ID card. - **Deadlines**: Requires 25% of signatures to be electronic by 2029. - **Effective date**: Takes effect on July 1, 2027.'

describe('normalizeInlineBullets', () => {
  it('splits dash bullets with no space before the dash onto their own lines', () => {
    const out = normalizeInlineBullets(GLUED)
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/^- Prohibiting/)
    expect(lines[2]).toMatch(/^- Capping/)
  })

  it('still handles a space before the dash', () => {
    const out = normalizeInlineBullets('Intro: - One. - Two.')
    expect(out.split('\n').filter(l => l.startsWith('- '))).toHaveLength(2)
  })

  it('does not split mid-sentence hyphenation or dollar amounts', () => {
    expect(normalizeInlineBullets('costs at $25,000 and $50,000.')).not.toContain('\n')
  })

  // The house list style puts a bold label first, so a list the model writes on
  // one line has "- **" after each sentence, not "- " and a capital letter.
  it('splits one-line bullets that open with a bold label', () => {
    const out = normalizeInlineBullets(GLUED_BOLD)
    expect(out.split('\n')).toEqual([
      'Shifts petition signature gathering to an electronic system in stages.',
      '- **Devices**: Requires each collection device to scan an ID card.',
      '- **Deadlines**: Requires 25% of signatures to be electronic by 2029.',
      '- **Effective date**: Takes effect on July 1, 2027.',
    ])
  })

  it('splits bold labels whose colon is inside the bold', () => {
    const out = normalizeInlineBullets('Updates audit rules. - **Reporting:** Requires a yearly report. - **Fees:** Caps the fee at $40.')
    expect(out.split('\n').filter(l => l.startsWith('- **'))).toHaveLength(2)
  })

  it('splits bold-label bullets after a lead-in colon and with no space before the dash', () => {
    const out = normalizeInlineBullets('Revises business licenses. The bill:- **Fees**: Lowers a fee.- **Forms**: Adds a form.')
    expect(out.split('\n')).toEqual(['Revises business licenses. The bill:', '- **Fees**: Lowers a fee.', '- **Forms**: Adds a form.'])
  })

  it('splits bullets whose label uses underscore bold', () => {
    const out = normalizeInlineBullets('Changes the primary date. - __Date__: Moves it to March.')
    expect(out.split('\n')).toEqual(['Changes the primary date.', '- __Date__: Moves it to March.'])
  })

  it('does not split a dash between bold words with no sentence end before it', () => {
    expect(normalizeInlineBullets('applies to **cities** - **counties** too.')).not.toContain('\n')
  })

  it('leaves an already line-separated bold list alone', () => {
    const md = 'Lead sentence.\n- **One**: First.\n- **Two**: Second.'
    expect(normalizeInlineBullets(md)).toBe(md)
  })
})

describe('stripMarkdown', () => {
  it('removes glued-dash bullets and bold markers for short previews', () => {
    const out = stripMarkdown(GLUED)
    expect(out).not.toContain('-')
    expect(out).not.toContain('*')
    expect(out).toContain('voter suppression')
    expect(out).toContain('Prohibiting political subdivisions')
  })

  it('leaves no stray dashes when one-line bullets open with a bold label', () => {
    expect(stripMarkdown(GLUED_BOLD)).toBe(
      'Shifts petition signature gathering to an electronic system in stages. Devices: Requires each collection device to scan an ID card. Deadlines: Requires 25% of signatures to be electronic by 2029. Effective date: Takes effect on July 1, 2027.',
    )
  })

  it('also strips HTML summaries (Gemini sometimes returns <ul>/<li> instead of markdown)', () => {
    const html = '<p>Requires counties to do X.</p><ul><li>Prohibits <strong>voter suppression</strong></li><li>Caps fees at $25,000</li></ul>'
    const out = stripMarkdown(html)
    expect(out).not.toMatch(/[<>*]/)
    expect(out).toBe('Requires counties to do X. Prohibits voter suppression Caps fees at $25,000')
  })
})
