#!/usr/bin/env tsx
/**
 * Rehearse moving a fork's production onto upstream, against copies of its
 * databases. Each copy takes every upstream migration it hasn't applied, in
 * memory, as wrangler would apply them, and the rehearsal checks that the
 * fork's own tables and columns, its DC bill ids, and its calendar rows come
 * through unchanged (scripts/lib/fork-upgrade-rehearsal.ts). Nothing is
 * written anywhere unless you pass --save. docs/internal/fork-upgrade.md is the
 * guide this is step 2 of.
 *
 * Export copies first (read-only on your account), from a checkout of your
 * fork's production branch, so wrangler finds your database bindings:
 *
 *   cd central && npx wrangler d1 export <central-db> --remote --env legiscan --output ../central.sql
 *   cd api && npx wrangler d1 export <tenant-db> --remote --env <tenant> --output ../tenant-<tenant>.sql
 *
 * Then, from a checkout of the branch you will deploy (upstream's main, with
 * your own commits cherry-picked onto it), after `git fetch upstream`:
 *
 *   npx tsx scripts/rehearse-fork-upgrade.ts --central central.sql --instance tenant-oca.sql [--instance ...]
 *
 * Options:
 *   --central <file>      a central copy: a `wrangler d1 export` SQL dump, or a SQLite file
 *   --instance <file>     an instance copy, the same way (repeat for each instance)
 *   --claim-states <list> the states you will claim for LIMS after deploying (default DC).
 *                         Each is checked for LegiScan bills instances track, which
 *                         would make upstream refuse the claim. (--lims-states is the
 *                         old name.)
 *   --upstream-ref <ref>  the git ref whose migration files are upstream's (default
 *                         upstream/main). Every other file in the folders is your own,
 *                         so the tables and columns your files create are checked too.
 *                         It exits 1 if git can't read the ref. On a plain upstream
 *                         checkout, with none of your files, pass HEAD.
 *   --save <dir>          also write each migrated copy there as a SQLite file, to inspect
 *
 * Exits 1 if any check fails. The dumps hold your data: keep them, and the
 * saved copies, off shared machines, and delete them when you're done.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { formatReport, openCopy, passed, readMigrations, rehearse, upstreamNamesAt, type DbKind } from './lib/fork-upgrade-rehearsal'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const FOLDERS: Record<DbKind, string> = {
  central: 'central/migrations',
  instance: 'api/migrations',
}
const DEFAULT_REF = 'upstream/main'

const copies: { kind: DbKind; path: string }[] = []
let claimStates = ['DC']
let saveDir: string | null = null
let upstreamRef: string | null = null
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const value = () => {
    const v = argv[++i]
    if (!v) throw new Error(`${a} needs a value`)
    return v
  }
  if (a === '--central') copies.push({ kind: 'central', path: value() })
  else if (a === '--instance' || a === '--tenant') copies.push({ kind: 'instance', path: value() })
  else if (a === '--claim-states' || a === '--lims-states') claimStates = value().split(',').map(s => s.trim()).filter(Boolean)
  else if (a === '--save') saveDir = value()
  else if (a === '--upstream-ref') upstreamRef = value()
  else if (a === '--help' || a === '-h') copies.length = 0
  else throw new Error(`unknown argument ${a} (see --help)`)
}
if (copies.length === 0) {
  console.log('Usage: npx tsx scripts/rehearse-fork-upgrade.ts --central central.sql --instance tenant.sql [--instance ...] [--claim-states DC] [--upstream-ref upstream/main] [--save dir]')
  console.log('See docs/internal/fork-upgrade.md.')
  process.exit(argv.length === 0 ? 1 : 0)
}

const savedPath = (path: string) => join(saveDir!, `${basename(path).replace(/\.[^.]+$/, '')}.upgraded.sqlite`)
if (saveDir) {
  const taken = copies.map(c => savedPath(c.path)).filter(p => existsSync(p))
  if (taken.length > 0) {
    console.error(`--save would overwrite ${taken.join(', ')}. Remove ${taken.length === 1 ? 'it' : 'them'}, or save somewhere else.`)
    process.exit(1)
  }
}

// Which files are upstream's: those at the upstream ref. Every other file in
// the folders is the fork's own, so its tables and columns are checked too.
// On a plain upstream checkout, --upstream-ref HEAD says every file is upstream's.
const upstreamNames = new Map<DbKind, string[]>()
for (const kind of new Set(copies.map(c => c.kind))) {
  try {
    upstreamNames.set(kind, upstreamNamesAt(REPO_ROOT, upstreamRef ?? DEFAULT_REF, FOLDERS[kind]))
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}`)
    console.error(`The rehearsal needs upstream's migration names to tell your own files from upstream's. Run git fetch upstream, or pass --upstream-ref <ref> naming the upstream commit you built this branch from (--upstream-ref HEAD on a plain upstream checkout).`)
    process.exit(1)
  }
}

let ok = true
for (const { kind, path } of copies) {
  const db = openCopy(path)
  const report = rehearse(db, kind, basename(path), readMigrations(join(REPO_ROOT, FOLDERS[kind])), { claimStates, upstreamNames: upstreamNames.get(kind) })
  console.log(formatReport(report))
  console.log('')
  ok &&= passed(report)
  if (saveDir) {
    mkdirSync(saveDir, { recursive: true })
    const out = savedPath(path)
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
    console.log(`Saved the migrated copy to ${out}\n`)
  }
  db.close()
}
console.log(ok
  ? 'Every check passed. Next: "Deploy" in docs/internal/fork-upgrade.md.'
  : 'Some checks failed. Each says what to look at. Fix them before deploying (docs/internal/fork-upgrade.md).')
process.exit(ok ? 0 : 1)
