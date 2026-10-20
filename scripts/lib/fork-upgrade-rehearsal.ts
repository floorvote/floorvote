import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The fork upgrade rehearsal (docs/internal/fork-upgrade.md): a copy of a
 * downstream fork's central or instance database takes every upstream
 * migration it hasn't applied, as wrangler would apply them, and the checks
 * below compare it before and after. It runs on copies only, in memory, and
 * writes nothing anywhere unless asked to save the result.
 *
 * What it can't do is run upstream's code: the DC sync, the LIMS re-ingest,
 * and the body events mirror. central/test/cron/fork-upgrade.test.ts and
 * api/test/migrations/forkUpgrade.test.ts rehearse those on a fork's
 * recorded data.
 */

export type DbKind = 'central' | 'instance'

/** A migration file, named as wrangler records it in d1_migrations. */
export interface MigrationFile {
  name: string
  sql: string
}

export interface Check {
  ok: boolean
  /** What holds, worded as a pass. */
  name: string
  /** Why it failed, or what to look at. */
  detail?: string
}

export interface RehearsalReport {
  kind: DbKind
  label: string
  /** Applied names no upstream file has: the fork's own migrations. */
  forkMigrations: string[]
  /** Every migration the rehearsal applied, in order. */
  applied: string[]
  /** Of those, the ones that aren't upstream's: the fork's own, or a sign of a stale or wrong upstream ref. */
  appliedOwn: string[]
  /** The upstream migration that failed, if one did. Nothing after it ran. */
  failed?: { name: string; error: string }
  /** Tables, and table.column, a database migrated from upstream alone doesn't have. */
  forkTables: string[]
  forkColumns: string[]
  checks: Check[]
  /** What to expect after deploying, worked out from the data. */
  notes: string[]
}

/** DC ids from LIMS were packed into these ranges, which migration 0025 reads. */
const LIMS_ID_MIN = 1_000_000_000
const LIMS_ID_MAX = 2_000_000_000

const rowsOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Wrangler's order: by leading number, then by name (so 0021_a before 0021_b, 0900 after 0099). */
export function compareMigrationNames(a: string, b: string): number {
  const na = parseInt(a.split('_')[0], 10)
  const nb = parseInt(b.split('_')[0], 10)
  if (na !== nb && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  if (na !== nb && Number.isFinite(na)) return -1
  if (na !== nb && Number.isFinite(nb)) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The migration file names in `folder` (relative to the repo root) at a git
 * ref: upstream's own files. Throws with git's error when the ref or folder
 * can't be read.
 */
export function upstreamNamesAt(repoRoot: string, ref: string, folder: string): string[] {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'ls-tree', '--name-only', `${ref}:${folder}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.split('\n').filter(n => n.endsWith('.sql'))
  } catch (err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr?.toString().trim()
    throw new Error(`git can't read ${folder} at ${ref}${stderr ? `: ${stderr}` : err instanceof Error ? `: ${err.message}` : ''}`)
  }
}

/** Every .sql file in a migrations folder, in the order wrangler applies them. */
export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort(compareMigrationNames)
    .map(name => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * A database to rehearse on: a SQL dump (`wrangler d1 export`), loaded into
 * memory, or a SQLite file, copied into memory. The file itself is only read:
 * a SQLite file is opened read-only (so not even a WAL checkpoint writes to
 * it) and snapshotted with VACUUM INTO to a temporary file, which is read in.
 */
export function openCopy(path: string): DatabaseSync {
  const bytes = readFileSync(path)
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false })
  if (bytes.subarray(0, 16).toString('latin1') === 'SQLite format 3\0') {
    const tmp = mkdtempSync(join(tmpdir(), 'fork-rehearsal-'))
    const snapshot = join(tmp, 'copy.sqlite')
    try {
      const source = new DatabaseSync(path, { readOnly: true })
      source.exec(`VACUUM INTO ${sqlString(snapshot)}`)
      source.close()
      loadSqlite(db, snapshot)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } else {
    db.exec(bytes.toString('utf8'))
  }
  // D1 enforces foreign keys, so the migrations run with them on.
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/** Every table, row, and index of a SQLite file, into `db`. */
function loadSqlite(db: DatabaseSync, path: string) {
  db.exec(`ATTACH DATABASE ${sqlString(path)} AS source`)
  const objects = db.prepare(`SELECT type, name, sql FROM source.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC, rowid`).all() as { type: string; name: string; sql: string }[]
  for (const o of objects.filter(o => o.type === 'table')) {
    db.exec(o.sql)
    db.exec(`INSERT INTO main."${o.name}" SELECT * FROM source."${o.name}"`)
  }
  const seq = db.prepare(`SELECT 1 FROM source.sqlite_master WHERE name = 'sqlite_sequence'`).get()
  if (seq) db.exec(`DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM source.sqlite_sequence`)
  for (const o of objects.filter(o => o.type !== 'table')) db.exec(o.sql)
  db.exec('DETACH DATABASE source')
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`

function tables(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name`).all() as { name: string }[]).map(r => r.name)
}
function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(r => r.name)
}
function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
}
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return hasTable(db, table) && columns(db, table).includes(column)
}
function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0)
}
/** A central setting, or an instance's association_config value. */
function setting(db: DatabaseSync, key: string, table: 'settings' | 'association_config' = 'settings'): string | null {
  if (!hasTable(db, table)) return null
  const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}
function rows(db: DatabaseSync, sql: string, ...params: (string | number)[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[]
}
/** A fingerprint of some columns of every row, in rowid order. */
function fingerprint(db: DatabaseSync, table: string, cols: string[]): { rows: number; hash: string } {
  const list = rows(db, `SELECT ${cols.map(q).join(', ')} FROM ${q(table)} ORDER BY rowid`)
  return { rows: list.length, hash: createHash('sha256').update(JSON.stringify(list)).digest('hex') }
}

/**
 * Every table and column upstream's migrations ever create, applied one at a
 * time to an empty database, including ones a later migration renames or
 * drops (lims_records, source_records). What a fork's database has beyond
 * these is its own.
 */
function upstreamSchema(migrations: MigrationFile[]): Map<string, Set<string>> {
  const db = new DatabaseSync(':memory:')
  const seen = new Map<string, Set<string>>()
  for (const m of migrations) {
    db.exec(m.sql)
    for (const t of tables(db)) {
      const cols = seen.get(t) ?? new Set<string>()
      for (const c of columns(db, t)) cols.add(c)
      seen.set(t, cols)
    }
  }
  return seen
}

/** SQL with comments removed, so a name in prose isn't read as DDL. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/**
 * Pending upstream DDL that meets a table or column the copy already has. An
 * ADD COLUMN, a rename onto a taken name, or a plain CREATE TABLE fails on
 * it, and a CREATE TABLE IF NOT EXISTS quietly keeps the copy's table, which
 * is fine only when it has the same columns as upstream's (a fork's
 * lims_records, say).
 */
function collisions(db: DatabaseSync, pending: MigrationFile[], upstream: Map<string, Set<string>>): string[] {
  const out: string[] = []
  const id = '["`]?(\\w+)["`]?'
  const create = new RegExp(`^CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${id}\\s*\\(`, 'i')
  const drop = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${id}`, 'i')
  const addColumn = new RegExp(`^ALTER\\s+TABLE\\s+${id}\\s+ADD\\s+(?:COLUMN\\s+)?${id}`, 'i')
  const renameColumn = new RegExp(`^ALTER\\s+TABLE\\s+${id}\\s+RENAME\\s+COLUMN\\s+\\w+\\s+TO\\s+${id}`, 'i')
  const renameTable = new RegExp(`^ALTER\\s+TABLE\\s+${id}\\s+RENAME\\s+TO\\s+${id}`, 'i')
  for (const m of pending) {
    // A table the migration drops first may be created or renamed onto
    // again: the usual way to rebuild a table in SQLite.
    const dropped = new Set<string>()
    for (const statement of stripComments(m.sql).split(';').map(s => s.trim())) {
      let match: RegExpMatchArray | null
      if ((match = statement.match(drop))) dropped.add(match[1])
      else if ((match = statement.match(create))) {
        const [, ifNotExists, t] = match
        if (dropped.has(t) || !hasTable(db, t)) continue
        const theirs = [...(upstream.get(t) ?? [])].sort().join(', ')
        const ours = columns(db, t).sort().join(', ')
        if (!ifNotExists) out.push(`${m.name} creates table ${t}, which the copy already has`)
        else if (theirs !== ours) out.push(`${m.name} creates table ${t} if it doesn't exist, and the copy's ${t} has other columns (${ours}, where upstream's has ${theirs})`)
      } else if ((match = statement.match(addColumn))) {
        if (!dropped.has(match[1]) && hasColumn(db, match[1], match[2])) out.push(`${m.name} adds ${match[1]}.${match[2]}, which the copy already has`)
      } else if ((match = statement.match(renameColumn))) {
        if (!dropped.has(match[1]) && hasColumn(db, match[1], match[2])) out.push(`${m.name} renames a column of ${match[1]} to ${match[2]}, which the copy already has`)
      } else if ((match = statement.match(renameTable))) {
        if (!dropped.has(match[2]) && hasTable(db, match[2])) out.push(`${m.name} renames a table to ${match[2]}, which the copy already has`)
      }
    }
  }
  return out
}

interface Snapshot {
  counts: Map<string, number>
  forkTables: Map<string, { rows: number; hash: string }>
  forkColumns: Map<string, { rows: number; hash: string }>
  central?: {
    dcBills: Map<number, string>
    calendar: Map<string, string>
    limsRecords: number[]
    legiscanLimit: string | null
    /** Each ownership row as `state provider`, sorted. Empty before the ownership table, or while it holds none. */
    ownership: string[]
  }
  instance?: {
    calendar: Map<string, { id: string; sequence: number; status: string; source: string }>
    bills: Map<string, string>
    links: number
  }
}

function snapshot(db: DatabaseSync, kind: DbKind, forkTables: string[], forkColumns: string[]): Snapshot {
  const s: Snapshot = {
    counts: new Map(tables(db).map(t => [t, count(db, `SELECT COUNT(*) AS n FROM ${q(t)}`)])),
    forkTables: new Map(forkTables.map(t => [t, fingerprint(db, t, columns(db, t))])),
    forkColumns: new Map(),
  }
  const byTable = new Map<string, string[]>()
  for (const tc of forkColumns) {
    const [t, c] = tc.split('.')
    byTable.set(t, [...(byTable.get(t) ?? []), c])
  }
  for (const [t, cols] of byTable) s.forkColumns.set(t, fingerprint(db, t, cols))
  if (kind === 'central') {
    s.central = {
      dcBills: new Map(rows(db, `SELECT bill_id, bill_number, session_id FROM bills WHERE state = 'DC'`)
        .map(r => [Number(r.bill_id), `${r.bill_number} in session ${r.session_id}`])),
      calendar: new Map(rows(db, `SELECT c.id, c.bill_id, c.type_id, c.date, c.description, c.event_hash FROM bill_calendar c JOIN bills b ON b.bill_id = c.bill_id WHERE b.state = 'DC'`)
        .map(r => [String(r.id), JSON.stringify([r.bill_id, r.type_id, r.date, r.description, r.event_hash])])),
      limsRecords: hasTable(db, 'lims_records') ? rows(db, 'SELECT bill_id FROM lims_records').map(r => Number(r.bill_id)) : [],
      legiscanLimit: setting(db, 'legiscan_monthly_limit'),
      ownership: ownershipRows(db),
    }
  } else {
    s.instance = {
      calendar: new Map(rows(db, 'SELECT id, uid, sequence, status, source FROM calendar_events')
        .map(r => [String(r.uid), { id: String(r.id), sequence: Number(r.sequence), status: String(r.status), source: String(r.source) }])),
      bills: new Map(rows(db, 'SELECT id, external_id FROM bills').map(r => [String(r.id), String(r.external_id ?? '')])),
      links: danglingLinks(db),
    }
  }
  return s
}

function ownershipRows(db: DatabaseSync): string[] {
  return hasTable(db, 'state_providers') ? rows(db, 'SELECT state, provider FROM state_providers ORDER BY state').map(r => `${r.state} ${r.provider}`) : []
}

/**
 * Rows of a fork's own features that point at an instance's bill or calendar
 * event that isn't there. The OCA fork's CRM, team links, and deep analyses
 * point at them by id, and nothing upstream does may break that.
 */
function danglingLinks(db: DatabaseSync): number {
  const targets = `SELECT id FROM bills UNION SELECT id FROM calendar_events`
  let n = 0
  if (hasColumn(db, 'crm_contacts', 'bill_id')) n += count(db, `SELECT COUNT(*) AS n FROM crm_contacts WHERE bill_id IS NOT NULL AND bill_id NOT IN (SELECT id FROM bills)`)
  if (hasColumn(db, 'team_links', 'subject_id')) n += count(db, `SELECT COUNT(*) AS n FROM team_links WHERE subject_id NOT IN (${targets})`)
  if (hasColumn(db, 'deep_analyses', 'subject_id')) n += count(db, `SELECT COUNT(*) AS n FROM deep_analyses WHERE subject_id NOT IN (${targets})`)
  return n
}

function sameFingerprints(before: Map<string, { rows: number; hash: string }>, after: Map<string, { rows: number; hash: string }>): string[] {
  const changed: string[] = []
  for (const [t, f] of before) {
    const g = after.get(t)
    if (!g) changed.push(`${t} is gone`)
    else if (g.hash !== f.hash) changed.push(`${t} changed (${f.rows} rows before, ${g.rows} after)`)
  }
  return changed
}

export interface RehearsalOptions {
  /** The states the fork will claim for LIMS after deploying. Default DC. */
  claimStates?: string[]
  /**
   * The names of upstream's own migration files. Default: every file in
   * `migrations`. Pass them when the folder also holds the fork's own files
   * (cherry-picked onto an upgrade branch), or those count as upstream's and
   * the fork's tables and columns go unchecked.
   */
  upstreamNames?: Iterable<string>
}

/**
 * Rehearse a migrations folder on one database copy. `migrations` is the
 * folder for this kind of database (central/migrations or
 * api/migrations) on the branch to deploy. The copy is changed in place, so
 * it can be saved after.
 */
export function rehearse(db: DatabaseSync, kind: DbKind, label: string, migrations: MigrationFile[], opts: RehearsalOptions = {}): RehearsalReport {
  const report: RehearsalReport = { kind, label, forkMigrations: [], applied: [], appliedOwn: [], forkTables: [], forkColumns: [], checks: [], notes: [] }
  const check = (ok: boolean, name: string, detail?: string) => { report.checks.push(detail && !ok ? { ok, name, detail } : { ok, name }) }

  if (!hasTable(db, 'd1_migrations')) {
    check(false, 'The copy records its applied migrations', 'It has no d1_migrations table. Export the database wrangler migrated, with `wrangler d1 export`.')
    return report
  }
  const appliedNames = rows(db, 'SELECT name FROM d1_migrations ORDER BY id').map(r => String(r.name))
  const upstreamNames = new Set(opts.upstreamNames ?? migrations.map(m => m.name))
  report.forkMigrations = appliedNames.filter(n => !upstreamNames.has(n))
  const pending = migrations.filter(m => !appliedNames.includes(m.name))
  report.appliedOwn = pending.filter(m => !upstreamNames.has(m.name)).map(m => m.name)
  if (report.appliedOwn.length > 0) {
    report.notes.push(`Pending files that aren't upstream's, applied as your own: ${report.appliedOwn.join(', ')}. If any isn't yours, the upstream ref is stale or wrong.`)
  }

  const upstream = upstreamSchema(migrations.filter(m => upstreamNames.has(m.name)))
  report.forkTables = tables(db).filter(t => !upstream.has(t))
  report.forkColumns = tables(db).filter(t => upstream.has(t))
    .flatMap(t => columns(db, t).filter(c => !upstream.get(t)!.has(c)).map(c => `${t}.${c}`))

  const clash = collisions(db, pending, upstream)
  check(clash.length === 0, 'No pending upstream migration creates a table or column the copy already has', clash.join('. '))

  if (kind === 'central') {
    // Bills instances track that aren't in LIMS's id ranges: LegiScan's.
    // Upstream refuses a claim of DC for LIMS while there are any, and
    // nothing else gives DC to LIMS, so DC would stay on LegiScan.
    const states = (opts.claimStates ?? ['DC']).map(s => s.toUpperCase())
    for (const state of states) {
      const legiscan = hasColumn(db, 'bills', 'provider') ? `b.provider = 'legiscan'` : hasColumn(db, 'bills', 'source') ? `b.source = 'legiscan'` : `(b.bill_id < ${LIMS_ID_MIN} OR b.bill_id >= ${LIMS_ID_MAX})`
      const n = count(db, `SELECT COUNT(DISTINCT b.bill_id) AS n FROM bills b JOIN bill_tenants bt ON bt.bill_id = b.bill_id WHERE b.state = ? AND ${legiscan}`, state)
      check(n === 0, `No LegiScan bill in ${state} is linked to an instance, so a claim of ${state} for LIMS won't be refused`,
        `${n} are. Upstream refuses a claim of ${state} for LIMS while LegiScan has tracked bills there. ${state} would stay on LegiScan. See "If Something Goes Wrong" in docs/internal/fork-upgrade.md.`)
    }
  }

  const before = snapshot(db, kind, report.forkTables, report.forkColumns)
  for (const m of pending) {
    try {
      db.exec('BEGIN')
      db.exec(m.sql)
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name)
      db.exec('COMMIT')
      report.applied.push(m.name)
    } catch (err) {
      db.exec('ROLLBACK')
      report.failed = { name: m.name, error: err instanceof Error ? err.message : String(err) }
      check(false, 'Every upstream migration applies', `${m.name} failed: ${report.failed.error}. Nothing after it ran.`)
      return report
    }
  }
  check(true, `Every upstream migration applies (${report.applied.length} pending)`)
  const after = snapshot(db, kind, report.forkTables, report.forkColumns)

  const tablesChanged = sameFingerprints(before.forkTables, after.forkTables)
  check(tablesChanged.length === 0, `The fork's own tables are untouched${report.forkTables.length ? ` (${report.forkTables.join(', ')})` : ''}`, tablesChanged.join('. '))
  const columnsChanged = sameFingerprints(before.forkColumns, after.forkColumns)
  check(columnsChanged.length === 0, `The fork's own columns are untouched${report.forkColumns.length ? ` (${report.forkColumns.join(', ')})` : ''}`, columnsChanged.join('. '))
  // lims_records is copied into provider_records, then dropped (0025 to 0029).
  const shrunk = [...before.counts].filter(([t, n]) => t !== 'lims_records' && (after.counts.get(t) ?? 0) < n)
    .map(([t, n]) => `${t}: ${n} rows before, ${after.counts.get(t) ?? 0} after`)
  check(shrunk.length === 0, 'No shared table lost rows', shrunk.join('. '))

  if (kind === 'central') centralChecks(db, before, report, check, (opts.claimStates ?? ['DC']).map(s => s.toUpperCase()))
  else instanceChecks(db, before, report, check)
  return report
}

function centralChecks(db: DatabaseSync, before: Snapshot, report: RehearsalReport, check: (ok: boolean, name: string, detail?: string) => void, claimStates: string[]) {
  const b = before.central!
  if (b.legiscanLimit === '30000' && setting(db, 'legiscan_monthly_limit') === '10000') {
    report.notes.push('The dashboard\'s LegiScan budget drops from 30,000 to 10,000 calls a month (0020_legiscan_limit_10k), LegiScan\'s free tier since October 1, 2026. Set it back on the dashboard if you pay for more.')
  }
  const now = new Map(rows(db, `SELECT bill_id, bill_number, session_id, provider FROM bills WHERE state = 'DC'`).map(r => [Number(r.bill_id), r]))
  const lost = [...b.dcBills].filter(([id, was]) => !now.has(id) || `${now.get(id)!.bill_number} in session ${now.get(id)!.session_id}` !== was).map(([id, was]) => `${id} (${was})`)
  check(lost.length === 0, `Every DC bill keeps its id, number, and session (${b.dcBills.size})`, `Changed or gone: ${lost.slice(0, 10).join(', ')}`)
  const notLims = [...now.values()].filter(r => Number(r.bill_id) >= LIMS_ID_MIN && Number(r.bill_id) < LIMS_ID_MAX && r.provider !== 'lims').map(r => r.bill_id)
  check(notLims.length === 0, 'Every DC bill in LIMS\'s id ranges is LIMS\'s', `Not marked lims: ${notLims.slice(0, 10).join(', ')}`)

  const calendar = new Map(rows(db, `SELECT c.id, c.bill_id, c.type_id, c.date, c.description, c.event_hash, c.identity_key, c.cancelled_at FROM bill_calendar c JOIN bills b ON b.bill_id = c.bill_id WHERE b.state = 'DC'`).map(r => [String(r.id), r]))
  const moved = [...b.calendar].filter(([id, was]) => {
    const r = calendar.get(id)
    return !r || JSON.stringify([r.bill_id, r.type_id, r.date, r.description, r.event_hash]) !== was || r.identity_key !== null || r.cancelled_at !== null
  }).map(([id]) => id)
  check(moved.length === 0, `Every DC bill calendar entry keeps its row, so instances keep its UID (${b.calendar.size})`, `Changed: ${moved.slice(0, 10).join(', ')}`)

  if (b.limsRecords.length > 0) {
    const copied = new Set(rows(db, `SELECT bill_id FROM provider_records WHERE provider = 'lims'`).map(r => Number(r.bill_id)))
    const missing = b.limsRecords.filter(id => !copied.has(id))
    check(missing.length === 0, `Every lims_records row is in provider_records (${b.limsRecords.length})`, `Missing: ${missing.slice(0, 10).join(', ')}`)
  }
  const sessions = rows(db, `SELECT session_id, provider, session_tag FROM sessions WHERE state = 'DC' AND session_id >= ${LIMS_ID_MIN} AND session_id < ${LIMS_ID_MAX}`)
  const badSessions = sessions.filter(s => s.provider !== 'lims' || !/^CP\d+$/.test(String(s.session_tag)))
  check(badSessions.length === 0, `Every DC Council Period session is LIMS's, tagged with its period (${sessions.length})`, JSON.stringify(badSessions.slice(0, 5)))

  // Only an operator's claim writes an ownership row (upstream no longer seeds
  // one from an env var), so a fork older than the ownership table ends the
  // upgrade with none, and its states are LegiScan's until it claims them.
  const owners = ownershipRows(db)
  const unclaimed = claimStates.join(' and ')
  check(owners.join('\n') === b.ownership.join('\n'), `Upstream's migrations write no ownership row, so ${unclaimed} ${claimStates.length === 1 ? 'is' : 'are'} LegiScan's until ${claimStates.length === 1 ? 'it is' : 'they are'} claimed`,
    `Rows before: ${b.ownership.join(', ') || 'none'}. After: ${owners.join(', ') || 'none'}.`)
  report.notes.push(owners.length === 0
    ? `No ownership rows. Right after deploying central, and before the next top of the hour, claim ${unclaimed} for LIMS: ${claimStates.map(s => `POST /api/admin/state-providers/${s}`).join(' and ')}, each with {"provider":"lims"}. Nothing else writes the row. Confirm it with GET /api/admin/state-providers.`
    : `Ownership rows already present: ${owners.map(o => o.replace(' ', ' → ')).join(', ')}.`)
  // Slugs never change once assigned, and the first cron tick slugs every
  // session. LegiScan's DC sessions go first while DC has no row, so a claim
  // after that tick leaves the current Council Period with "-2" for good.
  const legiscanSessions = count(db, `SELECT COUNT(*) AS n FROM sessions WHERE state = 'DC' AND provider = 'legiscan'`)
  if (legiscanSessions > 0) {
    report.notes.push(`${legiscanSessions} LegiScan DC session${legiscanSessions === 1 ? '' : 's'} in this central. Claim DC for LIMS before the first cron tick after deploying: a claim after it leaves DC's session URLs on LegiScan's sessions for good, and the current Council Period gets "-2".`)
  }
  if (hasTable(db, 'council_events')) {
    report.notes.push(`council_events (${count(db, 'SELECT COUNT(*) AS n FROM council_events')} rows) stays. Upstream's body_events replaces it, and it can be dropped by hand once upstream's calendar sync runs.`)
  }
  report.notes.push('After the deploy, re-ingest each instance\'s DC bills from LIMS: POST /api/admin/reingest-tenant/<tenant>?provider=lims&confirm=true.')
}

function instanceChecks(db: DatabaseSync, before: Snapshot, report: RehearsalReport, check: (ok: boolean, name: string, detail?: string) => void) {
  const b = before.instance!
  const now = new Map(rows(db, 'SELECT id, uid, sequence, status, source, kind FROM calendar_events').map(r => [String(r.uid), r]))
  const changed: string[] = []
  let refiled = 0
  for (const [uid, was] of b.calendar) {
    const r = now.get(uid)
    if (!r) { changed.push(`${uid} is gone`); continue }
    if (String(r.id) !== was.id || Number(r.sequence) !== was.sequence || String(r.status) !== was.status) changed.push(uid)
    // 0079 files a fork's deadline rows as bill entries of kind deadline.
    else if (was.source === 'deadline' && r.source === 'hearing' && r.kind === 'deadline') refiled++
    else if (String(r.source) !== was.source) changed.push(`${uid} moved from ${was.source} to ${r.source}`)
  }
  check(changed.length === 0, `Every calendar event keeps its id, UID, SEQUENCE, and status (${b.calendar.size})`, changed.slice(0, 10).join(', '))
  const bills = new Map(rows(db, 'SELECT id, external_id FROM bills').map(r => [String(r.id), String(r.external_id ?? '')]))
  const billChanges = [...b.bills].filter(([id, ext]) => bills.get(id) !== ext).map(([id]) => id)
  check(billChanges.length === 0, `Every bill keeps its id and central id (${b.bills.size})`, billChanges.slice(0, 10).join(', '))
  const dangling = danglingLinks(db)
  check(dangling <= b.links, 'Every bill and event the fork\'s own rows point at is still there', `${dangling - b.links} more dangling than before`)

  if (refiled > 0) report.notes.push(`${rowsOf(refiled, 'deadline row')} from the fork's DC calendar ${refiled === 1 ? 'is a bill entry' : 'are bill entries'} of kind deadline now (0079), under the same UIDs.`)
  const unprioritized = count(db, `SELECT COUNT(*) AS n FROM calendar_events e JOIN bills b ON b.id = e.bill_id WHERE e.source = 'hearing' AND e.kind = 'deadline' AND b.priority IS NULL`)
  if (unprioritized > 0) report.notes.push(`${unprioritized === 1 ? '1 deadline of a bill' : `${unprioritized} deadlines of bills`} with no priority leave${unprioritized === 1 ? 's' : ''} the calendar and ICS feed, as those bills' hearings do. ${unprioritized === 1 ? 'It stays' : 'Each stays'} on the bill page.`)
  const council = [...b.calendar.values()].filter(c => c.source === 'council').length
  if (council > 0) report.notes.push(`${rowsOf(council, 'Council calendar row')} wait${council === 1 ? 's' : ''} for upstream's hourly body events mirror, which takes over each one in its window under its UID.`)
  if (setting(db, 'event_rules', 'association_config') === null) {
    report.notes.push(setting(db, 'council_calendar_rules', 'association_config') !== null
      ? 'The team\'s Council calendar settings (council_calendar_rules) become its event rules within an hour of the upgrade, once central lists its committees. Until then every Council event shows.'
      : 'The team has no Council calendar settings, so it sees every Council event, where it saw none, until an admin chooses event rules on the settings page.')
  }
  const expired = hasColumn(db, 'bills', 'status_stage') ? count(db, `SELECT COUNT(*) AS n FROM bills WHERE status = 'Expired'`) : 0
  if (expired > 0) report.notes.push(`${rowsOf(expired, 'Expired bill')} ${expired === 1 ? 'is' : 'are'} staged enacted now (0078), as central's LIMS vocabulary sends them.`)
}

/** The report as text, one line per check. */
export function formatReport(r: RehearsalReport): string {
  const lines = [`${r.kind === 'central' ? 'Central' : 'Instance'}: ${r.label}`]
  lines.push(`  The fork's own migrations: ${r.forkMigrations.length ? r.forkMigrations.join(', ') : 'none'}`)
  const upstreamApplied = r.applied.filter(n => !r.appliedOwn.includes(n))
  lines.push(`  Upstream migrations applied: ${upstreamApplied.length ? `${upstreamApplied[0]} through ${upstreamApplied[upstreamApplied.length - 1]} (${upstreamApplied.length})` : 'none'}`)
  if (r.appliedOwn.length) lines.push(`  Your own migrations applied: ${r.appliedOwn.join(', ')}`)
  for (const c of r.checks) {
    lines.push(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) lines.push(`        ${c.detail}`)
  }
  for (const n of r.notes) lines.push(`  Note: ${n}`)
  return lines.join('\n')
}

export const passed = (r: RehearsalReport) => r.checks.every(c => c.ok)
