import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The cost docs say what claim links add to each analysis, with the date it
// was measured (#570). A number with no date goes stale without anyone noticing.

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '../../docs/content/overview/how-much-does-it-cost.md'), 'utf8')

/** The paragraphs that mention claim links. */
const claimLinksText = page.split(/\n\s*\n/).filter(p => /claim links/i.test(p)).join('\n\n')

describe('the cost docs: claim links', () => {
  it('has a section on claim links under AI bill summaries', () => {
    const aiSection = page.slice(page.indexOf('### AI bill summaries'), page.indexOf('## LegiScan'))
    expect(aiSection).toMatch(/claim links/i)
  })

  it('gives the measured addition: about 490 output tokens per analysis', () => {
    expect(claimLinksText).toMatch(/about 490 (additional |more |extra )?output tokens/i)
    expect(claimLinksText).toMatch(/per analysis/i)
  })

  it('dates the measurement, October 2026', () => {
    expect(claimLinksText).toMatch(/measured in October 2026/i)
  })

  it('says admins can turn claim links off in Settings', () => {
    expect(claimLinksText).toMatch(/turn (them|claim links) off/i)
  })

  it('gives the figure only once, so it cannot drift from itself', () => {
    expect(page.match(/490/g)).toHaveLength(1)
  })
})
