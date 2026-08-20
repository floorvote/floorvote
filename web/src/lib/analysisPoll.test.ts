import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollForAnalysis, analysisOutcomeMessage } from './analysisPoll'

describe('pollForAnalysis', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves "analyzed" when aiProcessedAt moves off the baseline', async () => {
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce({ aiProcessedAt: null, aiSkipReason: null, textStatus: 'in_r2' })
      .mockResolvedValueOnce({ aiProcessedAt: '2026-08-20T00:00:00Z', aiSkipReason: null, textStatus: 'in_r2' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: null, intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toBe('analyzed')
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
  })

  it('treats an unchanged non-null baseline as still running', async () => {
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce({ aiProcessedAt: 'SAME', aiSkipReason: null, textStatus: 'in_r2' })
      .mockResolvedValueOnce({ aiProcessedAt: 'NEW', aiSkipReason: null, textStatus: 'in_r2' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: 'SAME', intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toBe('analyzed')
  })

  it('resolves "no_texts" when the provider has no published text', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: null, aiSkipReason: null, textStatus: 'no_texts' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: null, intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe('no_texts')
  })

  it('resolves "skipped" when AI permanently failed', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: null, aiSkipReason: 'pdf_too_large', textStatus: 'in_r2' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: null, intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe('skipped')
  })

  it('resolves "timeout" once the deadline passes', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: null, aiSkipReason: null, textStatus: 'in_r2' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: null, intervalMs: 1000, timeoutMs: 3000 })
    await vi.advanceTimersByTimeAsync(6000)
    await expect(p).resolves.toBe('timeout')
  })

  it('keeps polling when a snapshot fetch throws', async () => {
    const fetchSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ aiProcessedAt: 'done', aiSkipReason: null, textStatus: 'in_r2' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: null, intervalMs: 1000, timeoutMs: 60000 })
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toBe('analyzed')
  })
})

describe('analysisOutcomeMessage', () => {
  it('says nothing when analysis arrived', () => {
    expect(analysisOutcomeMessage('analyzed')).toBeNull()
  })

  it('explains a missing bill text instead of blaming elapsed time', () => {
    const msg = analysisOutcomeMessage('no_texts')
    expect(msg).toMatch(/no published bill text/i)
    expect(msg).not.toMatch(/minutes/i)
  })

  it('explains a permanent AI skip', () => {
    expect(analysisOutcomeMessage('skipped')).toMatch(/couldn't analyze/i)
  })

  it('only mentions elapsed time for a real timeout', () => {
    expect(analysisOutcomeMessage('timeout')).toMatch(/3 minutes/)
  })
})
