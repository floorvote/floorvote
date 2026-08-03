import { describe, it, expect } from 'vitest'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { SQL } from 'drizzle-orm'
import { buildSearchCondition, buildBillNumberBoost } from '../../src/routes/billsApi/query'
import { MAX_SEARCH_TOKENS } from '../../../shared/searchLimits'

const dialect = new SQLiteSyncDialect()
const paramCount = (s: SQL) => dialect.sqlToQuery(s).params.length

// Worst case: N single-token comma segments.
const commaBomb = Array.from({ length: 25 }, (_, i) => `term${i}`).join(', ')

describe('search param budget', () => {
  it('caps the token budget at 12', () => {
    expect(MAX_SEARCH_TOKENS).toBe(12)
  })

  it('WHERE-clause params stay within 5 × MAX_SEARCH_TOKENS', () => {
    const cond = buildSearchCondition(commaBomb)!
    expect(paramCount(cond)).toBeLessThanOrEqual(5 * MAX_SEARCH_TOKENS)
  })

  it('ORDER BY boost params stay within 1 × MAX_SEARCH_TOKENS', () => {
    const boost = buildBillNumberBoost(commaBomb)!
    expect(paramCount(boost)).toBeLessThanOrEqual(MAX_SEARCH_TOKENS)
  })

  it('total search-attributable params stay under the D1 100-param ceiling', () => {
    const cond = buildSearchCondition(commaBomb)!
    const boost = buildBillNumberBoost(commaBomb)!
    expect(paramCount(cond) + paramCount(boost)).toBeLessThanOrEqual(6 * MAX_SEARCH_TOKENS)
    expect(paramCount(cond) + paramCount(boost)).toBeLessThan(100)
  })

  it('buildBillNumberBoost is undefined for empty/degenerate queries', () => {
    expect(buildBillNumberBoost(undefined)).toBeUndefined()
    expect(buildBillNumberBoost(',,')).toBeUndefined()
  })
})
