import { describe, it, expect } from 'vitest'
import { findViolations } from './timestamp-write-guard'

describe('findViolations', () => {
  it('flags a bare toISOString stored write', () => {
    const src = `await db.update(users).set({ lastActive: new Date().toISOString() })`
    expect(findViolations('f.ts', src)).toHaveLength(1)
  })

  it('allows a date-only slice', () => {
    const src = `const today = new Date().toISOString().slice(0, 10)`
    expect(findViolations('f.ts', src)).toHaveLength(0)
  })

  it('allows a response meta payload', () => {
    const src = `return c.json({ meta: { generatedAt: new Date().toISOString() } })`
    expect(findViolations('f.ts', src)).toHaveLength(0)
  })

  it('allows an explicit ignore comment', () => {
    const src = `const x = new Date().toISOString() // ts-write-ok: email body`
    expect(findViolations('f.ts', src)).toHaveLength(0)
  })
})
