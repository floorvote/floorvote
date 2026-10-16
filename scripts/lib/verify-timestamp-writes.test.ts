import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Runs the guard's CLI entry point the way CI and its docs do (tsx, ESM), so a
// startup crash like an unavailable `__dirname` fails here, not silently.

const ROOT = resolve(__dirname, '../..')
const TSX = resolve(ROOT, 'node_modules/.bin/tsx')
const ENTRY = 'scripts/verify-timestamp-writes.ts'

const tmpDirs: string[] = []
const makeTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ts-guard-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const run = (entry: string, cwd: string) => spawnSync(TSX, [entry], { cwd, encoding: 'utf8' })

// A throwaway repo holding copies of the entry point and its guard plus the given
// source files, so the guard scans fixtures instead of the real api/central code.
function fixtureRepo(files: Record<string, string>): string {
  const repo = makeTmp()
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), text)
  }
  for (const rel of [ENTRY, 'scripts/lib/timestamp-write-guard.ts']) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    copyFileSync(join(ROOT, rel), join(repo, rel))
  }
  // Mirror the root package.json's module type: without it tsx loads the copies
  // as CommonJS, where `__dirname` exists and the ESM crash can't reproduce.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module' }))
  mkdirSync(join(repo, 'api/src'), { recursive: true })
  mkdirSync(join(repo, 'central/src'), { recursive: true })
  for (const [rel, text] of Object.entries(files)) write(rel, text)
  return repo
}

describe('verify-timestamp-writes entry point', () => {
  it('starts and scans the real repo without crashing', () => {
    const r = run(ENTRY, ROOT)
    expect(r.stderr).not.toMatch(/ReferenceError|Error \[|at file:/)
    expect(`${r.stdout}${r.stderr}`).toMatch(/^Timestamp-write guard: (clean\.|\d+ stored-timestamp ISO write)/m)
    expect([0, 1]).toContain(r.status)
  })

  it('exits 0 and reports clean when no stored ISO writes exist', () => {
    const repo = fixtureRepo({
      'api/src/ok.ts': `const today = new Date().toISOString().slice(0, 10)\n`,
      'central/src/ok.ts': `export const x = 1\n`,
    })
    const r = run(join(repo, ENTRY), makeTmp())
    expect(r.stderr).toBe('')
    expect(r.stdout.trim()).toBe('Timestamp-write guard: clean.')
    expect(r.status).toBe(0)
  })

  it('exits 1 and lists each violation by repo-relative path and line, from any cwd', () => {
    const repo = fixtureRepo({
      'api/src/routes/users.ts': `import x from 'y'\nawait db.update(users).set({ lastActive: new Date().toISOString() })\n`,
      'central/src/nested/deep/sync.ts': `row.syncedAt = new Date().toISOString()\n`,
    })
    const r = run(join(repo, ENTRY), makeTmp())
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Timestamp-write guard: 2 stored-timestamp ISO write(s) found.')
    expect(r.stderr).toContain('api/src/routes/users.ts:2  await db.update(users).set({ lastActive: new Date().toISOString() })')
    expect(r.stderr).toContain('central/src/nested/deep/sync.ts:1  row.syncedAt = new Date().toISOString()')
    expect(r.stderr).toContain('// ts-write-ok: <reason>')
  })

  it('enforces the ts-write-ok marker: the same line passes with it and fails without it', () => {
    const marked = fixtureRepo({ 'api/src/mail.ts': `const sentAt = new Date().toISOString() // ts-write-ok: email body\n` })
    const unmarked = fixtureRepo({ 'api/src/mail.ts': `const sentAt = new Date().toISOString()\n` })
    expect(run(join(marked, ENTRY), makeTmp()).status).toBe(0)
    const r = run(join(unmarked, ENTRY), makeTmp())
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('api/src/mail.ts:1')
  })

  it('skips test files and non-TypeScript files', () => {
    const repo = fixtureRepo({
      'api/src/thing.test.ts': `row.at = new Date().toISOString()\n`,
      'central/src/legacy.js': `row.at = new Date().toISOString()\n`,
      'central/src/notes.md': `row.at = new Date().toISOString()\n`,
    })
    const r = run(join(repo, ENTRY), makeTmp())
    expect(r.stdout.trim()).toBe('Timestamp-write guard: clean.')
    expect(r.status).toBe(0)
  })
})
