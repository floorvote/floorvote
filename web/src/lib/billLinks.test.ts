import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { BILL_FILTER_DEFS, CUSTOM_FIELD_KEY_PREFIX } from '../../../shared/billFilter'

// Every link to a filtered Bills list is built with the shared serialize (`billsListPath`), never written out by
// hand: a hand-written `/bills?status=` is a second place that names a filter's key and its value's encoding, and the
// next change to either misses it. This reads the source of the web, the API (the digest emails), and shared/.

const ROOT = join(__dirname, '..', '..', '..')
const SOURCE_DIRS = ['web/src', 'api/src', 'shared']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '__tests__' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line)
// `/bills?` followed by one of the filter's keys and `=`: a filter written into a path. The keys come from the shared
// definitions, so a filter added later is covered. A request built from a variable (`/bills?${params}`) is not a link.
const KEYS = [...BILL_FILTER_DEFS.filter(d => d.kind !== 'custom-field').map(d => d.name), CUSTOM_FIELD_KEY_PREFIX]
const HAND_BUILT = new RegExp(`/bills\\?(${KEYS.join('|')})`)

describe('links to the Bills page', () => {
  const files = SOURCE_DIRS.flatMap(dir => sourceFiles(join(ROOT, dir)))

  it('reads source files from the web, the API, and shared', () => {
    const names = files.map(f => relative(ROOT, f))
    expect(names).toContain('web/src/components/Sidebar.tsx')
    expect(names).toContain('api/src/lib/digestEmail.ts')
    expect(names).toContain('shared/billFilter.ts')
    expect(names.some(n => n.endsWith('.test.ts') || n.endsWith('.test.tsx'))).toBe(false)
  })

  it('are not written by hand: none names a filter key after /bills?', () => {
    const offenders = files.flatMap(file => readFileSync(file, 'utf8').split('\n')
      .flatMap((line, i) => !isComment(line) && HAND_BUILT.test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : []))
    expect(offenders).toEqual([])
  })

  it('are built with billsListPath: each file that links to a filtered list imports it', () => {
    for (const file of ['web/src/components/Sidebar.tsx', 'web/src/components/FeedActivityRow.tsx', 'web/src/pages/BillDetail.tsx', 'web/src/App.tsx', 'api/src/lib/digestEmail.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(/billsListPath/)
    }
  })
})
