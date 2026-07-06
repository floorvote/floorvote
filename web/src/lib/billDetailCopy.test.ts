import { describe, it, expect } from 'vitest'
import { getNoAnalysisMessage } from './billDetailCopy'

describe('getNoAnalysisMessage', () => {
  describe('monitoring-only (matchType=null)', () => {
    it('with text_status=no_texts: explains no text and lists what is kept current', () => {
      const msg = getNoAnalysisMessage({ matchType: null, textStatus: 'no_texts' })
      expect(msg).toContain("doesn't match your keywords")
      expect(msg).toContain('Status and the latest action are kept current')
      expect(msg).toContain('No bill text published yet')
    })

    it('with text_status=available: lists what is and is not refreshed', () => {
      const msg = getNoAnalysisMessage({ matchType: null, textStatus: 'available' })
      expect(msg).toContain("doesn't match your keywords")
      expect(msg).toContain('Status and the latest action are kept current')
      expect(msg).toContain('Sponsors, full action history, and bill text are not')
    })

    it('with text_status=in_r2: same copy as available', () => {
      expect(getNoAnalysisMessage({ matchType: null, textStatus: 'in_r2' }))
        .toBe(getNoAnalysisMessage({ matchType: null, textStatus: 'available' }))
    })

    it('with text_status=not_checked: uses has-text copy (we do not assume no-text)', () => {
      expect(getNoAnalysisMessage({ matchType: null, textStatus: 'not_checked' }))
        .toContain('Sponsors, full action history, and bill text are not')
    })

    it('with text_status=null: uses has-text copy', () => {
      expect(getNoAnalysisMessage({ matchType: null, textStatus: null }))
        .toContain('Sponsors, full action history, and bill text are not')
    })

    it('regression guard: does NOT use the old overpromise wording', () => {
      // Old copy claimed sponsors and actions were "monitored and updated automatically",
      // which was false. Make sure that exact phrasing never returns for monitoring-only bills.
      for (const ts of ['available', 'in_r2', 'no_texts', 'not_checked', null] as const) {
        const msg = getNoAnalysisMessage({ matchType: null, textStatus: ts })
        expect(msg).not.toContain('sponsors, and actions')
        expect(msg).not.toContain('updated automatically')
      }
    })
  })

  describe('fully tracked (matchType=keyword|manual) without AI yet', () => {
    it('keyword-matched bill without text: shows the auto-runs message', () => {
      const msg = getNoAnalysisMessage({ matchType: 'keyword', textStatus: 'no_texts' })
      expect(msg).toContain('No published bill text yet')
      expect(msg).toContain('analysis will run automatically')
    })

    it('manually-promoted bill without text: same auto-runs message', () => {
      expect(getNoAnalysisMessage({ matchType: 'manual', textStatus: 'no_texts' }))
        .toBe(getNoAnalysisMessage({ matchType: 'keyword', textStatus: 'no_texts' }))
    })

    it('keyword-matched bill with text_status=not_checked: still uses the auto-runs message', () => {
      // Tracked bill without confirmed text — caller is expected to gate rendering separately
      // (the component returns null when text is confirmed), but the message itself is the
      // "waiting for text" variant.
      const msg = getNoAnalysisMessage({ matchType: 'keyword', textStatus: 'not_checked' })
      expect(msg).toContain('analysis will run automatically')
    })
  })

  describe('tracked bill with text present but no AI yet (stuck/in-flight state)', () => {
    it('returns the "text available, analysis pending" copy for a manual bill with text in R2', () => {
      const msg = getNoAnalysisMessage({ matchType: 'manual', textStatus: 'in_r2' })
      expect(msg).toMatch(/text is available/i)
      expect(msg).toMatch(/hasn't been analyzed/i)
      // Must NOT use the "no published text" copy, which would be a lie here.
      expect(msg).not.toMatch(/No published bill text yet/i)
      // Must NOT include the paradoxical "runs automatically… or run it now" hint —
      // by the time an admin reads this, the action is the adjacent button.
      expect(msg).not.toMatch(/automatically/i)
    })

    it('uses the same copy for textStatus "available" as for "in_r2"', () => {
      expect(getNoAnalysisMessage({ matchType: 'keyword', textStatus: 'available' }))
        .toBe(getNoAnalysisMessage({ matchType: 'keyword', textStatus: 'in_r2' }))
    })

    it('still returns the "no published text" copy for a tracked bill with no confirmed text', () => {
      expect(getNoAnalysisMessage({ matchType: 'keyword', textStatus: 'not_checked' }))
        .toMatch(/No published bill text yet/i)
    })

    it('permanent skip (pdf_too_large) still takes priority over the stuck copy', () => {
      const msg = getNoAnalysisMessage({ matchType: 'manual', textStatus: 'in_r2', aiSkipReason: 'pdf_too_large' })
      expect(msg).toMatch(/exceeds the length/i)
    })
  })
})
