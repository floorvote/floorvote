import { describe, it, expect } from 'vitest'
import { DEMO_SEEDS, resolveDemoSeed } from '../../src/lib/demoSeeds'

describe('lake-michigan seed registration', () => {
  it('is registered under its slug', () => {
    const s = DEMO_SEEDS['lake-michigan']
    expect(s).toBeDefined()
    expect(s.slug).toBe('lake-michigan')
    expect(resolveDemoSeed('lake-michigan')).toBe(s)
  })

  it('is a multi-state seed covering the four states plus Congress', () => {
    expect(DEMO_SEEDS['lake-michigan'].stateCoverage).toEqual(['MI', 'WI', 'IL', 'IN', 'US'])
  })

  it('names the organization without the Demo prefix (the machinery adds it)', () => {
    const n = DEMO_SEEDS['lake-michigan'].associationName
    expect(n).toBe('Lake Michigan Alliance')
    expect(n).not.toContain('Demo')
  })

  it('carries one session per covered jurisdiction, with LegiScan identifiers', () => {
    const ids = DEMO_SEEDS['lake-michigan'].sessions.data.map(s => s.identifier).sort()
    // WI is 2197 (2025-2026 Regular Session), NOT 2264 (May 2026 special session).
    expect(ids).toEqual(['2176', '2183', '2197', '2199', '2234'])
  })

  it('tells the visitor it is read-only and fictional', () => {
    const b = DEMO_SEEDS['lake-michigan'].bannerText
    expect(b).toMatch(/read-only/i)
    expect(b).toMatch(/fictional/i)
  })

  it('ships no keyword that is empty or duplicated', () => {
    const k = DEMO_SEEDS['lake-michigan'].keywords
    expect(k.length).toBeGreaterThan(10)
    expect(k.every(x => x.trim().length > 0)).toBe(true)
    expect(new Set(k).size).toBe(k.length)
  })

  it('offers the standard position vocabulary', () => {
    expect(DEMO_SEEDS['lake-michigan'].positionVocabulary)
      .toEqual(['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'])
  })

  it('leaves the optional widgets off so a visitor can turn them on', () => {
    const m = DEMO_SEEDS['lake-michigan'].modules
    expect(m['waiting-for-vote']).toBe(false)
    expect(m['upcoming-hearings']).toBe(false)
    expect(m['calendar']).toBe(true)
  })
})
