import { describe, it, expect } from 'vitest'
import { renderSampleEmail, ALL_SAMPLE_EMAIL_TYPES, SAMPLE_ASSOC_NAME } from '../../src/lib/sampleEmails'
import { color } from '../../../shared/tokens'

// One guardrail for ALL email types. Every type in the SampleEmailType registry
// is rendered here and checked against the shared shell contract + snapshotted.
// Adding a new email type (registry case in sampleEmails.ts) auto-enrolls it —
// so a new type physically cannot ship without passing these invariants and
// getting a reviewable snapshot. This is what keeps the emails from drifting.

const APP = 'https://sample.test'

describe('email conformance — every sample type shares the shell contract', () => {
  for (const type of ALL_SAMPLE_EMAIL_TYPES) {
    describe(type, () => {
      const { subject, html } = renderSampleEmail(type, APP)

      it('is a full HTML doc on the 560px gray shell', () => {
        expect(html).toContain('<!DOCTYPE html>')
        expect(html).toContain('width="560"')
        expect(html).toContain(color.surfaceSubtle) // #f8fafc gray backdrop
      })

      it('carries the FloorVote wordmark and the instance name', () => {
        expect(html).toContain('#1e3a5f') // wordmark navy "Floor"
        expect(html).toContain(color.accentAmber) // wordmark honey "Vote"
        expect(html).toContain(SAMPLE_ASSOC_NAME)
      })

      it('has a bordered footer and a non-empty subject', () => {
        expect(html).toContain('border-top:1px solid')
        expect(subject.length).toBeGreaterThan(0)
      })

      it('uses the blue CTA button (navy reserved for chips) with no arrow glyph in buttons', () => {
        expect(html).toContain(`background:${color.accentBlue}`) // #3b82f6, not navy
        expect(html).not.toContain('→</a>')
      })

      it('matches its committed snapshot', () => {
        expect(html).toMatchSnapshot()
      })
    })
  }
})

describe('email date ranges are consistently spaced (en-dash with spaces)', () => {
  it('week-ahead range uses " – "', () => {
    const { html } = renderSampleEmail('week-ahead', APP)
    expect(html).toContain('June 15 – June 19')
  })
  it('digest range uses " – "', () => {
    const { html } = renderSampleEmail('digest', APP)
    expect(html).toMatch(/\w+ \d+ – \w+ \d+/)
  })
})
