import { describe, it, expect } from 'vitest'
import { importUid, importEventHash, type ImportRow } from './calendarImport'

const row: ImportRow = { title: 'Filing period', date: '2026-05-14', details: 'Through May 29', time: null, location: null, url: null }

describe('import identity', () => {
  it('uid is stable for same date+title, ignoring details', async () => {
    const a = await importUid(row)
    const b = await importUid({ ...row, details: 'changed' })
    expect(a).toBe(b)
    expect(a).toMatch(/^import-[0-9a-f]{64}@example\.com$/)
  })
  it('uid changes when title changes', async () => {
    expect(await importUid(row)).not.toBe(await importUid({ ...row, title: 'Other' }))
  })
  it('eventHash changes when any content changes', async () => {
    expect(await importEventHash(row)).not.toBe(await importEventHash({ ...row, details: 'changed' }))
  })
})
