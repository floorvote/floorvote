import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareMigrationNames, formatReport, openCopy, passed, readMigrations, rehearse, upstreamNamesAt, type DbKind } from './fork-upgrade-rehearsal'

// The rehearsal script at its seam: a copy of a fork's database in (built
// here from the fork fixtures the repo's rehearsal tests use, as its own
// migrations and code left it), the report out.
const ROOT = join(__dirname, '../..')
const FORK: Record<DbKind, { own: string; upstream: string; fixtures: string; rows: string }> = {
  central: { own: 'central/test/fixtures/fork/migrations-legiscan', upstream: 'central/migrations', fixtures: 'central/test/fixtures/fork', rows: 'central-rows.json' },
  instance: { own: 'api/test/fixtures/fork/migrations', upstream: 'api/migrations', fixtures: 'api/test/fixtures/fork', rows: 'tenant-rows.json' },
}
const upstreamMigrations = (kind: DbKind) => readMigrations(join(ROOT, FORK[kind].upstream))
/** Every migration file the fork's production applied. */
const forkFiles = (kind: DbKind) => (JSON.parse(readFileSync(join(ROOT, FORK[kind].fixtures, 'migrations.json'), 'utf8')) as { files: string[] }).files

/** The fork's production database, as wrangler and its code left it. */
function forkCopy(kind: DbKind): DatabaseSync {
  const f = FORK[kind]
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false })
  db.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`)
  for (const name of forkFiles(kind)) {
    const own = join(ROOT, f.own, name)
    db.exec(readFileSync(existsSync(own) ? own : join(ROOT, f.upstream, name), 'utf8'))
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
  }
  const { rows } = JSON.parse(readFileSync(join(ROOT, f.fixtures, f.rows), 'utf8')) as { rows: Record<string, Record<string, string | number | null>[]> }
  // Two tenant migrations turn foreign keys back on. The rows go in table by table, children before parents.
  db.exec('PRAGMA foreign_keys = OFF')
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list) {
      const cols = Object.keys(row)
      db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]))
    }
  }
  if (kind === 'central') {
    db.exec(`INSERT INTO council_directory (entry_key, kind, name) VALUES ('staffer', 'staff', 'Example Staffer')`)
    db.exec(`UPDATE people SET seated = 1`)
  } else {
    const bill = (db.prepare(`SELECT id FROM bills WHERE bill_number = 'B26-0769'`).get() as { id: string }).id
    const event = (db.prepare(`SELECT id FROM calendar_events WHERE uid = 'council-2405@lims.dccouncil.gov'`).get() as { id: string }).id
    db.prepare(`INSERT INTO crm_contacts (id, person_key, contact_date, kind, summary, bill_id) VALUES ('cc-1', 'cm:Zachary Parker', '2026-09-20', 'meeting', 'Talked.', ?)`).run(bill)
    db.prepare(`INSERT INTO team_links (id, subject_kind, subject_id, title, url) VALUES ('tl-1', 'event', ?, 'Testimony', 'https://docs.example.org/t')`).run(event)
  }
  return db
}

/** A plain SQL dump, the shape `wrangler d1 export` writes. */
function dump(db: DatabaseSync): string {
  const literal = (v: unknown) => v === null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
  const out = ['PRAGMA defer_foreign_keys=TRUE;']
  const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC, rowid`).all() as { type: string; name: string; sql: string }[]
  for (const o of objects.filter(o => o.type === 'table')) {
    out.push(`${o.sql};`)
    for (const row of db.prepare(`SELECT * FROM "${o.name}"`).all() as Record<string, unknown>[]) {
      out.push(`INSERT INTO "${o.name}" (${Object.keys(row).map(c => `"${c}"`).join(',')}) VALUES(${Object.values(row).map(literal).join(',')});`)
    }
  }
  for (const o of objects.filter(o => o.type !== 'table')) out.push(`${o.sql};`)
  return out.join('\n')
}

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fork-rehearsal-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the fork upgrade rehearsal', () => {
  it('passes a fork central, from a wrangler export, and lists what is the fork\'s own', () => {
    const path = join(dir, 'central.sql')
    writeFileSync(path, dump(forkCopy('central')))
    const report = rehearse(openCopy(path), 'central', 'central.sql', upstreamMigrations('central'))

    expect(report.checks.filter(c => !c.ok)).toEqual([])
    expect(passed(report)).toBe(true)
    expect(report.forkMigrations).toEqual(['0020_lims_records.sql', '0021_council_events.sql', '0022_council_directory.sql', '0023_council_history.sql', '0024_council_seated.sql'])
    expect(report.applied[0]).toBe('0020_legiscan_limit_10k.sql')
    expect(report.applied).toEqual(expect.arrayContaining(['0021_lims_records.sql', '0029_drop_lims_records.sql', '0037_body_events.sql']))
    expect(report.forkTables).toEqual(['council_changes', 'council_committee_history', 'council_committees', 'council_directory', 'council_events'])
    expect(report.forkColumns).toEqual(['people.term_start', 'people.term_end', 'people.seated'])
    expect(report.checks.map(c => c.name)).toEqual(expect.arrayContaining([
      'No LegiScan bill in DC is linked to an instance, so a claim of DC for LIMS won\'t be refused',
      'Every DC bill keeps its id, number, and session (7)',
      'Every DC bill calendar entry keeps its row, so instances keep its UID (7)',
      'Every lims_records row is in provider_records (7)',
    ]))
    const text = formatReport(report)
    expect(text).toMatch(/GET \/api\/admin\/state-providers/)
    // A fork older than the ownership table ends with DC's ownership by its claim, the only thing that writes the row.
    expect(report.checks.map(c => c.name)).toContain('Upstream\'s migrations write no ownership row, so DC is LegiScan\'s until it is claimed')
    expect(text).toMatch(/POST \/api\/admin\/state-providers\/DC/)
    expect(text).toMatch(/before the next top of the hour/)
    expect(text).not.toMatch(/LIMS_STATES|seed/)
    expect(text).toMatch(/council_events \(20 rows\) stays/)
    expect(text).toMatch(/reingest-tenant\/<tenant>\?provider=lims&confirm=true/)
    // The fork never changed its LegiScan budget from the old seed.
    expect(text).toMatch(/LegiScan budget drops from 30,000 to 10,000/)
  })

  it('passes a fork instance, from a SQLite file, and says what moves', () => {
    const path = join(dir, 'tenant.sqlite')
    forkCopy('instance').exec(`VACUUM INTO '${path}'`)
    const report = rehearse(openCopy(path), 'instance', 'tenant.sqlite', upstreamMigrations('instance'))

    expect(report.checks.filter(c => !c.ok)).toEqual([])
    expect(report.forkMigrations).toEqual(['0071_deep_analyses.sql', '0072_team_links.sql', '0074_council_crm.sql'])
    expect(report.forkTables).toEqual(['crm_contacts', 'crm_followups', 'crm_people', 'deep_analyses', 'team_links'])
    expect(report.notes).toEqual(expect.arrayContaining([
      expect.stringMatching(/^1 deadline row from the fork's DC calendar is a bill entry of kind deadline now \(0079\)/),
      expect.stringMatching(/^1 deadline of a bill with no priority leaves the calendar and ICS feed/),
      expect.stringMatching(/^9 Council calendar rows wait for upstream's hourly body events mirror/),
      expect.stringMatching(/^The team's Council calendar settings \(council_calendar_rules\) become its event rules within an hour/),
    ]))
    // The file was only read: it still records only the fork's migrations.
    expect(new DatabaseSync(path).prepare(`SELECT COUNT(*) AS n FROM d1_migrations`).get())
      .toEqual({ n: forkFiles('instance').length })
  })

  it('still checks the fork\'s own tables when its migrations are cherry-picked onto the branch, given upstream\'s names', () => {
    // An upgrade branch: upstream's folders plus the fork's files it keeps.
    const branch = (kind: DbKind, own: string[]) => [...upstreamMigrations(kind), ...readMigrations(join(ROOT, FORK[kind].own)).filter(m => own.includes(m.name))]
      .sort((a, b) => compareMigrationNames(a.name, b.name))
    const central = branch('central', ['0022_council_directory.sql', '0023_council_history.sql', '0024_council_seated.sql'])
    const instance = branch('instance', ['0071_deep_analyses.sql', '0072_team_links.sql', '0074_council_crm.sql'])
    const names = (kind: DbKind) => upstreamMigrations(kind).map(m => m.name)

    const c = rehearse(forkCopy('central'), 'central', 'central', central, { upstreamNames: names('central') })
    expect(c.checks.filter(x => !x.ok)).toEqual([])
    expect(c.forkMigrations).toEqual(['0020_lims_records.sql', '0021_council_events.sql', '0022_council_directory.sql', '0023_council_history.sql', '0024_council_seated.sql'])
    expect(c.forkTables).toEqual(['council_changes', 'council_committee_history', 'council_committees', 'council_directory', 'council_events'])
    expect(c.forkColumns).toEqual(['people.term_start', 'people.term_end', 'people.seated'])
    const i = rehearse(forkCopy('instance'), 'instance', 'instance', instance, { upstreamNames: names('instance') })
    expect(i.checks.filter(x => !x.ok)).toEqual([])
    expect(i.forkTables).toEqual(['crm_contacts', 'crm_followups', 'crm_people', 'deep_analyses', 'team_links'])

    // A pending file that isn't upstream's is applied as the fork's own, and said so.
    const withNew = [...instance, { name: '0900_oca_notes.sql', sql: 'CREATE TABLE oca_notes (id TEXT PRIMARY KEY)' }]
    const own = rehearse(forkCopy('instance'), 'instance', 'instance', withNew, { upstreamNames: names('instance') })
    expect(own.appliedOwn).toEqual(['0900_oca_notes.sql'])
    expect(own.notes).toContain('Pending files that aren\'t upstream\'s, applied as your own: 0900_oca_notes.sql. If any isn\'t yours, the upstream ref is stale or wrong.')
    const text = formatReport(own)
    // What the rehearsal applies of upstream's is every file in api/migrations the fork hasn't, in wrangler's order. Derived, so a new tenant migration doesn't break this.
    const fresh = upstreamMigrations('instance').map(m => m.name).filter(n => !forkFiles('instance').includes(n)).sort(compareMigrationNames)
    expect(text).toContain(`Upstream migrations applied: ${fresh[0]} through ${fresh[fresh.length - 1]} (${fresh.length})`)
    expect(text).toMatch(/Your own migrations applied: 0900_oca_notes\.sql/)

    // Without upstream's names, the cherry-picked files pass for upstream's and their tables go unchecked.
    const blind = rehearse(forkCopy('instance'), 'instance', 'instance', instance)
    expect(blind.forkMigrations).toEqual([])
    expect(blind.forkTables).toEqual([])
  })

  it('fails before upgrading when LegiScan bills in DC are tracked, since the claim of DC would be refused', () => {
    const db = forkCopy('central')
    db.exec(`INSERT INTO bills (bill_id, session_id, state, state_id, bill_number, change_hash, title) VALUES (2001234, 2100, 'DC', 51, 'B26-0001', 'h', 'From LegiScan')`)
    db.exec(`INSERT INTO bill_tenants (bill_id, tenant_id, match_type) VALUES (2001234, 'oca', 'keyword')`)
    const report = rehearse(db, 'central', 'central', upstreamMigrations('central'))
    expect(report.checks.filter(c => !c.ok)).toEqual([expect.objectContaining({
      name: 'No LegiScan bill in DC is linked to an instance, so a claim of DC for LIMS won\'t be refused',
      detail: expect.stringMatching(/^1 are\. Upstream refuses a claim of DC for LIMS while LegiScan has tracked bills there/),
    })])
  })

  it('takes the states to check from --claim-states, and notes the rows a copy already has', () => {
    const db = forkCopy('central')
    db.exec(`INSERT INTO bills (bill_id, session_id, state, state_id, bill_number, change_hash, title) VALUES (2001235, 2100, 'MD', 20, 'HB1', 'h', 'From LegiScan')`)
    db.exec(`INSERT INTO bill_tenants (bill_id, tenant_id, match_type) VALUES (2001235, 'oca', 'keyword')`)
    // Only the states the fork will claim are checked: MD's tracked bill is no problem for DC's claim.
    const dc = rehearse(db, 'central', 'central', upstreamMigrations('central'), { claimStates: ['DC'] })
    expect(dc.checks.filter(c => !c.ok)).toEqual([])
    const md = rehearse(forkCopy('central'), 'central', 'central', upstreamMigrations('central'), { claimStates: ['DC', 'MD'] })
    expect(md.checks.map(c => c.name)).toContain('No LegiScan bill in MD is linked to an instance, so a claim of MD for LIMS won\'t be refused')
  })

  it('warns when the central holds LegiScan DC sessions, whose slugs a late claim can leave with LegiScan for good', () => {
    const db = forkCopy('central')
    const quiet = rehearse(forkCopy('central'), 'central', 'central', upstreamMigrations('central'))
    expect(quiet.notes.filter(n => /LegiScan DC session/.test(n))).toEqual([])
    db.exec(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_title, session_name) VALUES (2050, 9, 'DC', 2025, 2026, '2025-2026 Council Period 26', '2025-2026 Council Period 26')`)
    const report = rehearse(db, 'central', 'central', upstreamMigrations('central'))
    expect(report.checks.filter(c => !c.ok)).toEqual([])
    expect(report.notes).toContainEqual(expect.stringMatching(/^1 LegiScan DC session\b.*Claim DC for LIMS before the first cron tick.*-2/))
  })

  it('reports ownership rows a copy already has, which the upgrade leaves as they are', () => {
    const db = forkCopy('central')
    // A copy that already ran the ownership table (a fork past #303).
    db.exec(readFileSync(join(ROOT, 'central/migrations/0030_state_providers.sql'), 'utf8'))
    db.exec(`INSERT INTO state_providers (state, provider, previous_provider) VALUES ('DC', 'lims', 'legiscan')`)
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0030_state_providers.sql')
    const report = rehearse(db, 'central', 'central', upstreamMigrations('central'))
    expect(report.checks.filter(c => !c.ok)).toEqual([])
    expect(report.notes).toContain('Ownership rows already present: DC → lims.')
  })

  it('names the upstream migration that meets a fork\'s own column, and stops there', () => {
    const db = forkCopy('central')
    // As if a fork migration had added a column upstream adds later.
    db.exec('ALTER TABLE bill_calendar ADD COLUMN event_id TEXT')
    const report = rehearse(db, 'central', 'central', upstreamMigrations('central'))
    expect(report.checks.find(c => c.name.startsWith('No pending upstream migration'))).toMatchObject({
      ok: false, detail: '0034_bill_calendar_identity.sql adds bill_calendar.event_id, which the copy already has',
    })
    expect(report.failed).toEqual({ name: '0034_bill_calendar_identity.sql', error: expect.stringMatching(/duplicate column name: event_id/) })
    expect(report.applied.at(-1)).toBe('0033_bill_history_video.sql')
  })

  it('flags a fork table that an upstream CREATE TABLE IF NOT EXISTS would quietly keep', () => {
    const db = forkCopy('central')
    db.exec('CREATE TABLE body_events (id INTEGER PRIMARY KEY, title TEXT)')
    const report = rehearse(db, 'central', 'central', upstreamMigrations('central'))
    expect(report.checks.find(c => c.name.startsWith('No pending upstream migration'))?.detail)
      .toMatch(/^0037_body_events\.sql creates table body_events if it doesn't exist, and the copy's body_events has other columns/)
  })

  it('reads upstream\'s migration names from a git ref, and says why when git can\'t', () => {
    expect(upstreamNamesAt(ROOT, 'HEAD', 'api/migrations').sort()).toEqual(upstreamMigrations('instance').map(m => m.name).sort())
    expect(() => upstreamNamesAt(ROOT, 'no-such-remote/main', 'api/migrations'))
      .toThrow(/^git can't read api\/migrations at no-such-remote\/main: .+/)
  })

  it('needs a copy wrangler migrated', () => {
    const report = rehearse(new DatabaseSync(':memory:'), 'central', 'empty', upstreamMigrations('central'))
    expect(passed(report)).toBe(false)
    expect(report.checks[0].detail).toMatch(/no d1_migrations table/)
  })

  it('orders migrations as wrangler does, by number then name', () => {
    const names = ['0900_oca_notes.sql', '0021_session_votes_dataset.sql', '0100_x.sql', '0021_lims_records.sql', '0099_y.sql']
    expect(names.sort(compareMigrationNames)).toEqual(['0021_lims_records.sql', '0021_session_votes_dataset.sql', '0099_y.sql', '0100_x.sql', '0900_oca_notes.sql'])
  })
})
