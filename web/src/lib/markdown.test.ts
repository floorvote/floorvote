import { describe, it, expect } from 'vitest'
import { normalizeInlineBullets, stripMarkdown } from './markdown'

// Real-world Gemini output: dash glued to the preceding period with no space,
// and the whole list on a single line (see CA SB1164).
const GLUED = 'Repealing and replacing the California Voting Rights Act of 2001 with the California Voting Rights Act of 2026.- Prohibiting political subdivisions from engaging in **voter suppression**.- Capping the recovery of attorney fees at $25,000 and other costs at $50,000.'

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
})

describe('stripMarkdown', () => {
  it('removes glued-dash bullets and bold markers for short previews', () => {
    const out = stripMarkdown(GLUED)
    expect(out).not.toContain('-')
    expect(out).not.toContain('*')
    expect(out).toContain('voter suppression')
    expect(out).toContain('Prohibiting political subdivisions')
  })

  it('also strips HTML summaries (Gemini sometimes returns <ul>/<li> instead of markdown)', () => {
    const html = '<p>Requires counties to do X.</p><ul><li>Prohibits <strong>voter suppression</strong></li><li>Caps fees at $25,000</li></ul>'
    const out = stripMarkdown(html)
    expect(out).not.toMatch(/[<>*]/)
    expect(out).toBe('Requires counties to do X. Prohibits voter suppression Caps fees at $25,000')
  })
})
