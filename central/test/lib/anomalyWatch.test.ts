import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const listTrackedD1Dbs = vi.fn()
const fetchDailyRowsRead = vi.fn()
vi.mock('../../src/lib/d1Analytics', () => ({
  listTrackedD1Dbs: (...a: any[]) => listTrackedD1Dbs(...a),
  fetchDailyRowsRead: (...a: any[]) => fetchDailyRowsRead(...a),
}))

const sendOpsAlert = vi.fn(async () => {})
vi.mock('../../src/lib/jobAlert', () => ({
  sendOpsAlert: (...a: any[]) => sendOpsAlert(...a),
}))

import { runAnomalyWatch } from '../../src/lib/anomalyWatch'

const env = (over: Record<string, unknown> = {}) =>
  ({ CF_ANALYTICS_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct', ALERT_EMAILS: 'a@e.com', ...over }) as any

// build a per-day series ending today, oldest first
function series(values: number[]): { date: string; rowsRead: number }[] {
  return values.map((rowsRead, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, rowsRead }))
}

beforeEach(() => {
  listTrackedD1Dbs.mockReset()
  fetchDailyRowsRead.mockReset()
  sendOpsAlert.mockReset()
  sendOpsAlert.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('runAnomalyWatch', () => {
  it('no-ops when CF_ANALYTICS_TOKEN unset', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runAnomalyWatch(env({ CF_ANALYTICS_TOKEN: undefined }))
    expect(listTrackedD1Dbs).not.toHaveBeenCalled()
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('no-ops when CF_ACCOUNT_ID unset', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runAnomalyWatch(env({ CF_ACCOUNT_ID: undefined }))
    expect(listTrackedD1Dbs).not.toHaveBeenCalled()
  })

  it('flags a demo-shaped spike (10M x7, 237M latest) and alerts once', async () => {
    listTrackedD1Dbs.mockResolvedValue([{ id: 'd1', name: 'floorvote-demo' }])
    fetchDailyRowsRead.mockResolvedValue({
      d1: series([10e6, 10e6, 10e6, 10e6, 10e6, 10e6, 10e6, 237e6]),
    })
    await runAnomalyWatch(env())
    expect(sendOpsAlert).toHaveBeenCalledOnce()
    const msg = sendOpsAlert.mock.calls[0][1]
    expect(msg.subject).toContain('floorvote-demo')
    expect(msg.text).toContain('floorvote-demo')
  })

  it('does NOT flag a steady series (44M x8)', async () => {
    listTrackedD1Dbs.mockResolvedValue([{ id: 'd1', name: 'floorvote-ri' }])
    fetchDailyRowsRead.mockResolvedValue({
      d1: series([44e6, 44e6, 44e6, 44e6, 44e6, 44e6, 44e6, 44e6]),
    })
    await runAnomalyWatch(env())
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('does NOT flag a 2M->30M jump (below the 50M floor)', async () => {
    listTrackedD1Dbs.mockResolvedValue([{ id: 'd1', name: 'floorvote-small' }])
    fetchDailyRowsRead.mockResolvedValue({
      d1: series([2e6, 2e6, 2e6, 2e6, 2e6, 2e6, 2e6, 30e6]),
    })
    await runAnomalyWatch(env())
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('alerts once listing only the flagged db when mixed', async () => {
    listTrackedD1Dbs.mockResolvedValue([
      { id: 'spike', name: 'floorvote-demo' },
      { id: 'calm', name: 'floorvote-ri' },
    ])
    fetchDailyRowsRead.mockResolvedValue({
      spike: series([10e6, 10e6, 10e6, 10e6, 10e6, 10e6, 10e6, 237e6]),
      calm: series([44e6, 44e6, 44e6, 44e6, 44e6, 44e6, 44e6, 44e6]),
    })
    await runAnomalyWatch(env())
    expect(sendOpsAlert).toHaveBeenCalledOnce()
    const msg = sendOpsAlert.mock.calls[0][1]
    expect(msg.text).toContain('floorvote-demo')
    expect(msg.text).not.toContain('floorvote-ri')
  })

  it('skips dbs with too few days of data', async () => {
    listTrackedD1Dbs.mockResolvedValue([{ id: 'd1', name: 'floorvote-new' }])
    fetchDailyRowsRead.mockResolvedValue({ d1: series([500e6]) })
    await runAnomalyWatch(env())
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('respects custom FACTOR / FLOOR from env', async () => {
    listTrackedD1Dbs.mockResolvedValue([{ id: 'd1', name: 'floorvote-x' }])
    fetchDailyRowsRead.mockResolvedValue({
      d1: series([1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 3e6]),
    })
    // factor 2, floor 1M -> latest 3M > max(2*1M, 1M)=2M -> flag
    await runAnomalyWatch(env({ D1_ANOMALY_FACTOR: '2', D1_ANOMALY_FLOOR: '1000000' }))
    expect(sendOpsAlert).toHaveBeenCalledOnce()
  })
})
