import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// One name per filter (#699): a filter is called by its one name in the URL, the code, and the API response. These
// are the names each layer used to give the same filters, so finding one in the source means a layer still calls a
// filter by a name of its own. This reads the source of the web, the API, and shared/, comments included.

const ROOT = join(__dirname, '..', '..', '..')
const SOURCE_DIRS = ['web/src', 'api/src', 'shared']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const OLD_NAMES: Array<[name: string, pattern: RegExp]> = [
  ...['filterStatuses', 'filterStages', 'filterPriorities', 'filterPositions', 'filterYears', 'filterStates',
    'filterMinRelevance', 'unvotedOnly', 'selectedTags', 'cfFilters', 'matchAny', 'setCfFilter']
    .map((n): [string, RegExp] => [n, new RegExp(`\\b${n}\\b`, 'i')]),
  // The bill filter value's custom fields (and the bulk body's before it), now `field`.
  ['the value\'s cf', /\.cf\b(?!-)|\bcf\s*:\s/],
  // The custom field query key, now `field.<slug>`.
  ['the cf_ key', /(^|[^\w])cf_/],
]

describe('one name per filter', () => {
  const files = SOURCE_DIRS.flatMap(dir => sourceFiles(join(ROOT, dir)))

  it('reads source files from the web, the API, and shared', () => {
    const names = files.map(f => relative(ROOT, f))
    expect(names).toContain('web/src/hooks/useBillFilters.ts')
    expect(names).toContain('api/src/routes/billsApi/filterTable.ts')
    expect(names).toContain('shared/billFilter.ts')
  })

  it.each(OLD_NAMES)('finds no %s left', (_name, pattern) => {
    const offenders = files.flatMap(file => readFileSync(file, 'utf8').split('\n')
      .flatMap((line, i) => pattern.test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : []))
    expect(offenders).toEqual([])
  })
})
