import { describe, it, expect } from 'vitest'
import {
  limsBillId, limsSessionId, limsDocId, limsPeopleId, limsRollCallId,
  LIMS_BILL_ID_BASE, LIMS_DOC_ID_BASE, LIMS_PEOPLE_ID_BASE, LIMS_SESSION_ID_BASE,
} from '../../../src/providers/lims/ids'

// Each LIMS range is a billion ids wide, above anything LegiScan issues.
const inRange = (id: number, base: number) => id >= base && id < base + 1_000_000_000

describe('lims-ids', () => {
  it('mints LIMS ids into their reserved ranges', () => {
    expect(limsBillId('B26-0400')).toBe(1_012_600_400)
    expect(inRange(limsBillId('B26-0400')!, LIMS_BILL_ID_BASE)).toBe(true)
    expect(inRange(limsSessionId(26), LIMS_SESSION_ID_BASE)).toBe(true)
    expect(inRange(limsPeopleId(150), LIMS_PEOPLE_ID_BASE)).toBe(true)
    expect(inRange(limsDocId(224385), LIMS_DOC_ID_BASE)).toBe(true)
  })

  it('mints above LegiScan-sized ids', () => {
    for (const id of [limsBillId('B1-0001')!, limsSessionId(1), limsPeopleId(1), limsDocId(1)]) {
      expect(id).toBeGreaterThan(999_999_999)
    }
  })

  it('keeps doc ids out of the bill range', () => {
    expect(inRange(limsDocId(1), LIMS_BILL_ID_BASE)).toBe(false)
    expect(inRange(limsBillId('AG99-99999')!, LIMS_DOC_ID_BASE)).toBe(false)
  })

  it('stays within JS safe integers', () => {
    expect(Number.isSafeInteger(limsDocId(999_999_999))).toBe(true)
    expect(Number.isSafeInteger(limsRollCallId(limsBillId('AG99-99999')!, 99))).toBe(true)
  })

  it('mints a distinct bill id for every prefix LIMS uses', () => {
    const numbers = ['B26-0400', 'PR26-0808', 'CER26-0205', 'CA26-1018', 'GBM26-0061', 'REPROG26-0153',
      'HFA26-0008', 'HN26-0171', 'HR26-0157', 'RC26-0256', 'ANC26-0050', 'AU26-0045', 'CFO26-0014',
      'IG26-0076', 'AG26-0029', 'B8-0001']
    const ids = numbers.map(n => limsBillId(n))
    expect(new Set(ids).size).toBe(numbers.length)
    for (const id of ids) expect(inRange(id!, LIMS_BILL_ID_BASE)).toBe(true)
  })

  it('refuses numbers it cannot encode', () => {
    expect(limsBillId('XYZ26-0001')).toBeNull()
    expect(limsBillId('B26')).toBeNull()
    expect(limsBillId('B260-0001')).toBeNull()
  })
})
