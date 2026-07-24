import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseIconAllowlist } from '../../../shared/emailIcons'

// Repo root from this test file (web/src/lib/materialSymbolsSubset.test.ts).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// The web app loads Material Symbols as a SUBSETTED font: web/index.html requests
// only the glyphs named in `icon_names=…`. An icon rendered in code but absent
// from that subset silently degrades to its raw ligature text (e.g. "warning"
// instead of the ⚠ glyph). This test keeps the two in sync for STATIC usages;
// dynamic names (e.g. <MaterialIcon name={row.iconName}/>) can't be checked here.
const allowlist = new Set(parseIconAllowlist(readFileSync(join(ROOT, 'web/index.html'), 'utf8')))

// Match `class(Name)="… material-symbols-outlined …" …>ligature<`, capturing a
// literal ligature name. Skips `>{expr}<` (dynamic) since it isn't [a-z0-9_].
const ICON_SPAN = /material-symbols-outlined[^>]*>\s*([a-z0-9_]+)\s*</g

function walkTsx(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsx(p))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

const usedIcons = new Set<string>()
for (const file of walkTsx(join(ROOT, 'web/src'))) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(ICON_SPAN)) usedIcons.add(m[1])
}

describe('Material Symbols icon subset stays in sync', () => {
  it('parses a non-empty allowlist from index.html', () => {
    expect(allowlist.size).toBeGreaterThan(0)
  })

  it('finds the static icons actually used in web/src', () => {
    // Guards against a broken scanner silently passing the check below.
    expect(usedIcons.size).toBeGreaterThan(0)
  })

  it('every static material-symbols icon used in web/src is in the index.html subset', () => {
    const missing = [...usedIcons].filter(name => !allowlist.has(name)).sort()
    expect(missing, `icons rendered in code but missing from web/index.html icon_names: ${missing.join(', ')}`).toEqual([])
  })
})
