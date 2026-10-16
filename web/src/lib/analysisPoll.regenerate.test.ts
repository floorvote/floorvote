import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollForAnalysis, analysisOutcomeMessage, regenerateOutcomeMessage } from './analysisPoll'

// Regenerate re-analyzes the bill whose analysis the page shows (#563), which
// on a pulled companion's page is another bill, and the group can change while
// the run is queued.

describe('pollForAnalysis: the bill the page shows moves while it runs', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves "moved" when the page shows another bill\'s analysis than the one it re-analyzes', async () => {
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce({ aiProcessedAt: 'OLD', aiSkipReason: null, textStatus: 'in_r2', analysisBillId: 'a190' })
      .mockResolvedValueOnce({ aiProcessedAt: 'COMPANION', aiSkipReason: null, textStatus: 'in_r2', analysisBillId: 'b1713' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: 'OLD', expectedBillId: 'a190', intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toBe('moved')
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
  })

  it('reads a moved bill before a new analysis time, so another bill\'s fresher analysis is never called ours', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: 'NEWER', aiSkipReason: null, textStatus: 'in_r2', analysisBillId: 'b1713' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: 'OLD', expectedBillId: 'a190', intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe('moved')
  })

  it('reads a moved bill before a skip reason and a missing text', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: null, aiSkipReason: 'pdf_too_large', textStatus: 'no_texts', analysisBillId: 'b1713' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: null, expectedBillId: 'a190', intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe('moved')
  })

  it('still resolves "analyzed" while the shown bill is the one being re-analyzed', async () => {
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce({ aiProcessedAt: 'OLD', aiSkipReason: null, textStatus: 'in_r2', analysisBillId: 'a190' })
      .mockResolvedValueOnce({ aiProcessedAt: 'NEW', aiSkipReason: null, textStatus: 'in_r2', analysisBillId: 'a190' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: 'OLD', expectedBillId: 'a190', intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toBe('analyzed')
  })

  it('does not call a snapshot with no analysis bill moved, as from an older server', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: 'NEW', aiSkipReason: null, textStatus: 'in_r2' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: 'OLD', expectedBillId: 'a190', intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe('analyzed')
  })

  it('never reports "moved" when no bill is expected', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: 'NEW', aiSkipReason: null, textStatus: 'in_r2', analysisBillId: 'b1713' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: 'OLD', intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe('analyzed')
  })
})

describe('regenerateOutcomeMessage', () => {
  const own = { billNumber: 'A190', other: false }
  const other = { billNumber: 'S1713', other: true }

  it('says nothing when this bill\'s own analysis arrived', () => {
    expect(regenerateOutcomeMessage('analyzed', own)).toBeNull()
  })

  it('keeps the existing copy for this bill\'s own failures', () => {
    expect(regenerateOutcomeMessage('no_texts', own)).toBe(analysisOutcomeMessage('no_texts'))
    expect(regenerateOutcomeMessage('skipped', own)).toBe(analysisOutcomeMessage('skipped'))
    expect(regenerateOutcomeMessage('timeout', own)).toBe(analysisOutcomeMessage('timeout'))
    expect(regenerateOutcomeMessage('timeout', own, 30_000)).toBe(analysisOutcomeMessage('timeout', 30_000))
  })

  it('names the other bill that was re-analyzed', () => {
    const msg = regenerateOutcomeMessage('analyzed', other)
    expect(msg).toContain('S1713')
    expect(msg).toMatch(/re-analyzed/i)
    expect(msg).toMatch(/summary comes from/i)
  })

  it('names the other bill when it has no text, when AI skipped it, and when it timed out', () => {
    expect(regenerateOutcomeMessage('no_texts', other)).toContain('S1713')
    expect(regenerateOutcomeMessage('no_texts', other)).toMatch(/no published bill text/i)
    expect(regenerateOutcomeMessage('skipped', other)).toContain('S1713')
    expect(regenerateOutcomeMessage('skipped', other)).toMatch(/couldn't analyze/i)
    expect(regenerateOutcomeMessage('timeout', other)).toContain('S1713')
    expect(regenerateOutcomeMessage('timeout', other)).toMatch(/\b3 minutes\b/)
    expect(regenerateOutcomeMessage('timeout', other, 30_000)).toMatch(/30 seconds/)
  })

  it('says the group changed when the shown bill moved, naming the bill that was re-analyzed', () => {
    const msg = regenerateOutcomeMessage('moved', other)
    expect(msg).toMatch(/group changed/i)
    expect(msg).toContain('S1713')
    expect(msg).toMatch(/different bill/i)
  })

  it('says the group changed for this bill\'s own run too, without a bill number', () => {
    const msg = regenerateOutcomeMessage('moved', own)
    expect(msg).toMatch(/group changed/i)
    expect(msg).toMatch(/different bill/i)
    expect(analysisOutcomeMessage('moved')).toMatch(/group changed/i)
  })

  it('falls back to a plain phrase when the other bill has no number', () => {
    expect(regenerateOutcomeMessage('analyzed', { billNumber: null, other: true })).toMatch(/Re-analyzed the bill this page's summary comes from/)
  })
})
