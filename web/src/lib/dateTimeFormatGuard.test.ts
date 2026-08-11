import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'

// Drift guard: all human-readable date/time display must route through the
// shared helpers so the calendar, popovers, agenda, Feed, and sidebar
// stay identical.
//   dates → lib/calendarDate.ts (eventDateLabel / formatDateHeader / formatMonthDay)
//   times → lib/hearingTime.ts (formatHearingTime / formatHearingTimeShort)
// Ad-hoc `.toLocaleDateString(` / `.toLocaleTimeString(` in any other file is
// banned — that's how non-standard dates/times creep in. (`.toLocaleString()`
// is fine; it's used for number grouping, not dates.)
const ALLOWED = new Set(['calendarDate.ts'])
const BANNED = /\.toLocale(Date|Time)String\s*\(/

// Anchor to this file, not to process.cwd(): the suite has to scan the same
// directories whether it is invoked from web/ or from the repo root (the root
// vitest.config.ts runs web as a project). Matches the other drift guards.
const here = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(here, '../..')
const ROOTS = [
  resolve(WEB_DIR, 'src'),
  resolve(WEB_DIR, '..', 'shared'),
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('date/time formatting drift guard', () => {
  it('routes all date/time display through the shared helpers', () => {
    const offenders = ROOTS
      .flatMap(sourceFiles)
      .filter(f => !ALLOWED.has(basename(f)) && BANNED.test(readFileSync(f, 'utf8')))
      .map(f => f.replace(WEB_DIR, '.'))

    expect(
      offenders,
      `Format dates/times with the shared helpers (lib/calendarDate, lib/hearingTime, shared/feedUtils), `
      + `not ad-hoc toLocaleDateString/toLocaleTimeString:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
