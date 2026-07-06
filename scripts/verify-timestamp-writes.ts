#!/usr/bin/env tsx
/**
 * verify-timestamp-writes.ts (G1) — walks api/src + central/src and fails (exit 1)
 * if `new Date().toISOString()` is used where it would land in a stored timestamp
 * column. Run from the nightly repo-health routine. Usage: npx tsx scripts/verify-timestamp-writes.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { findViolations } from './lib/timestamp-write-guard'

const ROOTS = ['api/src', 'central/src']

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(p)
  }
  return acc
}

function main(): void {
  const repoRoot = path.resolve(__dirname, '..')
  const violations = ROOTS.flatMap((root) =>
    walk(path.join(repoRoot, root)).flatMap((f) =>
      findViolations(path.relative(repoRoot, f), fs.readFileSync(f, 'utf8'))
    )
  )
  if (violations.length > 0) {
    console.error(`Timestamp-write guard: ${violations.length} stored-timestamp ISO write(s) found.`)
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`)
    console.error('\nStored timestamp columns must use the column default or sql`(datetime(\'now\'))` / nowDb().')
    console.error('If this is a non-stored use, add `// ts-write-ok: <reason>` to the line.')
    process.exit(1)
  }
  console.log('Timestamp-write guard: clean.')
}

main()
