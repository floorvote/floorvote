import { describe, it, expect } from 'vitest'
import {
  isLimsBillId, isLimsSessionId, isLimsDocId, limsBillId, limsSessionId, limsDocId,
  limsNumberFromBillId, limsRollCallId,
} from '../../src/lib/lims-ids'

describe('lims-ids', () => {
  it('maps LIMS ids into their reserved ranges and recognises them', () => {
    expect(limsBillId('B26-0400')).toBe(1_012_600_400)
    expect(isLimsBillId(limsBillId('B26-0400')!)).toBe(true)
    expect(isLimsSessionId(limsSessionId(26))).toBe(true)
    expect(isLimsDocId(limsDocId(224385))).toBe(true)
  })

  it('does not claim LegiScan-sized ids', () => {
    for (const id of [1, 2253, 1_950_000, 3_400_000, 999_999_999]) {
      expect(isLimsBillId(id)).toBe(false)
      expect(isLimsSessionId(id)).toBe(false)
      expect(isLimsDocId(id)).toBe(false)
    }
  })

  it('keeps doc ids out of the bill range', () => {
    expect(isLimsBillId(limsDocId(1))).toBe(false)
    expect(isLimsDocId(limsBillId('B26-0001')!)).toBe(false)
  })

  it('stays within JS safe integers', () => {
    expect(Number.isSafeInteger(limsDocId(999_999_999))).toBe(true)
    expect(Number.isSafeInteger(limsRollCallId(limsBillId('AG99-99999')!, 99))).toBe(true)
  })

  it('round-trips every prefix LIMS uses and keeps them distinct', () => {
    const numbers = ['B26-0400', 'PR26-0808', 'CER26-0205', 'CA26-1018', 'GBM26-0061', 'REPROG26-0153',
      'HFA26-0008', 'HN26-0171', 'HR26-0157', 'RC26-0256', 'ANC26-0050', 'AU26-0045', 'CFO26-0014',
      'IG26-0076', 'AG26-0029', 'B8-0001']
    const ids = numbers.map(n => limsBillId(n))
    expect(new Set(ids).size).toBe(numbers.length)
    for (const [i, n] of numbers.entries()) {
      expect(isLimsBillId(ids[i]!)).toBe(true)
      expect(limsNumberFromBillId(ids[i]!)).toBe(n)
    }
  })

  it('refuses numbers it cannot encode', () => {
    expect(limsBillId('XYZ26-0001')).toBeNull()
    expect(limsBillId('B26')).toBeNull()
    expect(limsBillId('B260-0001')).toBeNull()
  })
})
