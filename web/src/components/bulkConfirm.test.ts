import { describe, it, expect } from 'vitest'
import { promotableCount, bulkConfirmMessage } from './bulkConfirm'

describe('promotableCount', () => {
  const ids = (m: (string | null)[]) => m.map((matchType, i) => ({ id: String(i), priority: null, position: null, matchType }))

  it('is 0 when not setting a priority', () => {
    expect(promotableCount({ mode: 'ids', selectedBills: ids([null, null]), nullMatchCount: null, stagedPriority: undefined })).toBe(0)
  })
  it('is 0 when clearing priority', () => {
    expect(promotableCount({ mode: 'ids', selectedBills: ids([null]), nullMatchCount: null, stagedPriority: null })).toBe(0)
  })
  it('counts null-match selected bills in ids mode', () => {
    expect(promotableCount({ mode: 'ids', selectedBills: ids([null, 'keyword', null]), nullMatchCount: null, stagedPriority: 'high' })).toBe(2)
  })
  it('uses nullMatchCount in filter mode', () => {
    expect(promotableCount({ mode: 'filter', selectedBills: [], nullMatchCount: 7, stagedPriority: 'low' })).toBe(7)
  })
})

describe('bulkConfirmMessage', () => {
  it('omits warning when promotableCount is 0', () => {
    const msg = bulkConfirmMessage({ count: 3, lines: '• Priority → High', promotableCount: 0 })
    expect(msg).toContain('Apply changes to 3 bills?')
    expect(msg).not.toContain('promoted')
  })
  it('includes warning when promotableCount > 0', () => {
    const msg = bulkConfirmMessage({ count: 3, lines: '• Priority → High', promotableCount: 2 })
    expect(msg).toContain('2 of these bills will be promoted to full tracking')
    expect(msg).toContain('queued for AI analysis')
    expect(msg).not.toContain('⚠️')
    expect(msg).not.toContain('LegiScan quota')
  })
})
