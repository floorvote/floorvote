import { describe, it, expect } from 'vitest'
import {
  isLimsBillId, isLimsSessionId, isLimsDocId, limsBillId, limsSessionId, limsDocId,
} from '../../src/lib/lims-ids'

describe('lims-ids', () => {
  it('maps LIMS ids into their reserved ranges and recognises them', () => {
    expect(limsBillId(60460)).toBe(1_000_060_460)
    expect(isLimsBillId(limsBillId(60460))).toBe(true)
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
    expect(isLimsDocId(limsBillId(1))).toBe(false)
  })

  it('stays within JS safe integers', () => {
    expect(Number.isSafeInteger(limsDocId(999_999_999))).toBe(true)
  })
})
