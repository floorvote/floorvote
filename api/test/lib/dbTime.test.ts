import { describe, it, expect } from 'vitest'
import { nowDb } from '../../src/lib/dbTime'

describe('nowDb', () => {
  it('returns SQLite space format (YYYY-MM-DD HH:MM:SS, UTC, no T/Z/fraction)', () => {
    expect(nowDb()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('is UTC (matches the ISO instant to the second, space-swapped)', () => {
    expect(Math.abs(Date.parse(nowDb() + 'Z') - Date.now())).toBeLessThan(1500)
  })
})
