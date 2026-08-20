import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollForAnalysis, analysisOutcomeMessage, DEFAULT_ANALYSIS_TIMEOUT_MS } from './analysisPoll'

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

  it('treats an unchanged non-null skip reason as still running', async () => {
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce({ aiProcessedAt: 'OLD', aiSkipReason: 'pdf_too_large', textStatus: 'in_r2' })
      .mockResolvedValueOnce({ aiProcessedAt: 'NEW', aiSkipReason: 'pdf_too_large', textStatus: 'in_r2' })
    const p = pollForAnalysis({
      fetchSnapshot,
      baselineProcessedAt: 'OLD',
      baselineSkipReason: 'pdf_too_large',
      intervalMs: 1000,
      timeoutMs: 60000,
    })
    await vi.advanceTimersByTimeAsync(2500)
    // The pre-existing skip must not short-circuit the run that then succeeds.
    await expect(p).resolves.toBe('analyzed')
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
  })

  it('resolves "skipped" when the skip reason changes off a non-null baseline', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: 'OLD', aiSkipReason: 'ai_error', textStatus: 'in_r2' })
    const p = pollForAnalysis({
      fetchSnapshot,
      baselineProcessedAt: 'OLD',
      baselineSkipReason: 'pdf_too_large',
      intervalMs: 1000,
      timeoutMs: 60000,
    })
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe('skipped')
  })

  it('resolves "timeout" once the deadline passes', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ aiProcessedAt: null, aiSkipReason: null, textStatus: 'in_r2' })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: null, intervalMs: 1000, timeoutMs: 3000 })
    await vi.advanceTimersByTimeAsync(6000)
    await expect(p).resolves.toBe('timeout')
  })

  it('counts fetch latency toward the deadline, not just the interval', async () => {
    // 900ms per fetch on top of a 1000ms interval means the 3000ms deadline is
    // reached on the second tick. Accumulating intervalMs instead would give
    // this run a third tick and a real wall-clock wait well past the stated
    // timeout.
    const fetchSnapshot = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 900))
      return { aiProcessedAt: null, aiSkipReason: null, textStatus: 'in_r2' }
    })
    const p = pollForAnalysis({ fetchSnapshot, baselineProcessedAt: null, intervalMs: 1000, timeoutMs: 3000 })
    await vi.advanceTimersByTimeAsync(10000)
    await expect(p).resolves.toBe('timeout')
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
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
    // Derived from the default timeout rather than hardcoded, so shortening the
    // default cannot leave the copy claiming a wait that never happened.
    const minutes = Math.round(DEFAULT_ANALYSIS_TIMEOUT_MS / 60_000)
    expect(analysisOutcomeMessage('timeout')).toMatch(new RegExp(`${minutes} minutes`))
  })

  it('reports the caller-supplied timeout instead of the default', () => {
    expect(analysisOutcomeMessage('timeout', 30_000)).toMatch(/30 seconds/)
    expect(analysisOutcomeMessage('timeout', 60_000)).toMatch(/1 minute\b/)
    expect(analysisOutcomeMessage('timeout', 10 * 60_000)).toMatch(/10 minutes/)
  })
})
