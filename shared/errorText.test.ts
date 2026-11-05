import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { errorText } from './errorText'

describe('errorText', () => {
  it("is a plain error's message", () => {
    expect(errorText(new Error('boom'))).toBe('boom')
  })

  it('joins every message down the cause chain, outermost first', () => {
    // The shape Drizzle throws: its own "Failed query" wrapper, with D1's error as the cause.
    const d1 = new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.')
    const wrapped = new Error('Failed query: select 1', { cause: d1 })
    expect(errorText(wrapped)).toBe(
      'Failed query: select 1 | caused by: D1_ERROR: D1 DB is overloaded. Requests queued for too long.',
    )
  })

  it('follows a chain more than one cause deep', () => {
    const err = new Error('a', { cause: new Error('b', { cause: new Error('c') }) })
    expect(errorText(err)).toBe('a | caused by: b | caused by: c')
  })

  it('includes a cause that is not an Error', () => {
    expect(errorText(new Error('outer', { cause: 'inner reason' }))).toBe('outer | caused by: inner reason')
  })

  it('stops at a cycle instead of looping', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as { cause?: unknown }).cause = b
    expect(errorText(a)).toBe('a | caused by: b')
  })

  it("names an error whose message is empty, so the line isn't blank", () => {
    expect(errorText(new TypeError(''))).toBe('TypeError')
  })

  it('stringifies a thrown non-Error', () => {
    expect(errorText('just a string')).toBe('just a string')
    expect(errorText(42)).toBe('42')
    expect(errorText(undefined)).toBe('undefined')
    expect(errorText(null)).toBe('null')
  })

  it('reads the message off a thrown plain object with one', () => {
    expect(errorText({ message: 'from an object' })).toBe('from an object')
  })
})

// Workers Logs drops an Error argument's message and keeps only its stack
// frames, so `console.error('[x] failed:', err)` reaches the dashboard as
// "[x] failed:     at D1PreparedQuery…" with no reason. Every worker log of a
// caught error must pass errorText(err) as well.
describe('worker error logs keep the message', () => {
  const roots = ['central/src', 'api/src'].map(r => join(__dirname, '..', r))
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) return files(p)
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
    })
  // A console.error/warn call (possibly spanning lines) whose last argument is a bare identifier.
  const call = /console\.(?:error|warn)\(((?:[^()]|\([^()]*\))*)\)/g
  const bareLastArg = /,\s*([A-Za-z_$][\w$]*)\s*,?\s*$/

  it('passes errorText(err) alongside every caught error it logs', () => {
    const offenders: string[] = []
    for (const file of roots.flatMap(files)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(call)) {
        const args = m[1]
        const last = args.match(bareLastArg)?.[1]
        if (!last || !/^(e|err|error|cause|reason|ex)$/.test(last)) continue
        if (args.includes(`errorText(${last})`)) continue
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${relative(join(__dirname, '..'), file)}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
