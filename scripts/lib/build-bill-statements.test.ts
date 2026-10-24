import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBillStatements, esc, num } from './build-bill-statements'

// Fixture mirrors the shape returned by LegiScan's getBill / bulk JSON.
// Every child collection has at least one entry so the "writes everything"
// invariant test can check all expected tables get an INSERT.
const completeBill = {
  bill_id: 12345,
  change_hash: 'abc123',
  session_id: 2154,
  state: 'WI',
  state_id: 50,
  bill_number: 'AB35',
  bill_type: 'B',
  bill_type_id: '1',
  body: 'A',
  body_id: 26,
  current_body: 'A',
  current_body_id: 26,
  title: 'Sample bill title',
  description: 'A description with an apostrophe\'s special handling',
  status: 1,
  status_date: '2026-01-15',
  url: 'https://legiscan.com/WI/bill/AB35/2025',
  state_link: 'https://docs.legis.wisconsin.gov/2025/proposals/ab35',
  progress: [{ date: '2026-01-15', event: 1 }],
  committee: { committee_id: 99, chamber: 'A', chamber_id: 26, name: 'Elections' },
  history: [
    { date: '2026-01-15', action: 'Introduced', chamber: 'A', chamber_id: 26, importance: 1 },
    { date: '2026-02-01', action: 'Referred to committee', chamber: 'A', chamber_id: 26, importance: 1 },
  ],
  sponsors: [
    { people_id: 5001, sponsor_type_id: 1, sponsor_order: 1 },
    { people_id: 5002, sponsor_type_id: 2, sponsor_order: 2 },
  ],
  texts: [
    { doc_id: 1000, date: '2026-01-15', type: 'Introduced', type_id: 1, mime: 'text/html', mime_id: 1, url: 'u', state_link: 'sl', text_size: 1024, text_hash: 'th' },
  ],
  supplements: [
    { supplement_id: 537244, date: '0000-00-00', type_id: 1, type: 'Fiscal Note', title: 'Fiscal Note', description: 'AB35: Fiscal Estimate', mime: 'application/pdf', mime_id: 2, url: 'su', state_link: 'sl', supplement_size: 142643, supplement_hash: 'sh' },
  ],
  amendments: [
    { amendment_id: 600001, adopted: 0, chamber: 'A', date: '2026-02-15', title: 'Amendment 1', description: 'first amendment', mime: 'application/pdf', url: 'au', state_link: 'asl', amendment_size: 500, amendment_hash: 'ah' },
    { amendment_id: 600002, adopted: 1, chamber: 'A', date: '2026-02-20', title: 'Amendment 2', description: 'second amendment', mime: 'application/pdf', url: 'au2', state_link: 'asl2', amendment_size: 600, amendment_hash: 'ah2' },
  ],
  sasts: [
    { type_id: 1, type: 'Same As', sast_bill_number: 'SB35', sast_bill_id: 12346 },
  ],
  subjects: [
    { subject_id: 100, subject_name: 'Elections' },
  ],
  referrals: [
    { date: '2026-01-16', committee_id: 99, chamber: 'A', chamber_id: 26, name: 'Elections' },
  ],
  calendar: [
    { type_id: 1, event_hash: 'ev1', type: 'Hearing', date: '2026-02-10', time: '10:00', location: 'Room 412', description: 'Public hearing' },
  ],
  votes: [
    { roll_call_id: 800000, date: '2026-03-01', desc: 'Final passage', yea: 60, nay: 40, nv: 0, absent: 0, total: 100, passed: 1, chamber: 'A', chamber_id: 26, url: 'vu', state_link: 'vsl' },
  ],
}

describe('esc / num helpers', () => {
  it('esc returns NULL for null/undefined and escapes single quotes', () => {
    expect(esc(null)).toBe('NULL')
    expect(esc(undefined)).toBe('NULL')
    expect(esc('a')).toBe("'a'")
    expect(esc("it's")).toBe("'it''s'")
  })

  it('num returns NULL for null/undefined and stringifies numbers', () => {
    expect(num(null)).toBe('NULL')
    expect(num(undefined)).toBe('NULL')
    expect(num(0)).toBe('0')
    expect(num(-7)).toBe('-7')
  })

  // L1: the bulk JSON is `any`-typed and num() values are interpolated into SQL
  // WITHOUT quoting (unlike esc()). A non-numeric value must throw, never pass
  // through raw — otherwise a crafted bulk file injects SQL via a numeric column.
  it('num throws on non-finite / non-numeric input (SQL-injection guard)', () => {
    expect(() => num(NaN)).toThrow()
    expect(() => num(Infinity)).toThrow()
    expect(() => num(-Infinity)).toThrow()
    expect(() => num('1); DROP TABLE bills;--' as unknown as number)).toThrow()
    expect(() => num('not a number' as unknown as number)).toThrow()
  })

  it('num coerces a clean numeric string to its canonical number', () => {
    expect(num('42' as unknown as number)).toBe('42')
  })
})

describe('buildBillStatements', () => {
  it('writes every expected child table when the bill includes all collections', () => {
    const stmts = buildBillStatements(completeBill, 'WI', 2154)
    const joined = stmts.join('\n')

    // This is the §B6 invariant: a complete bill from getBill must produce
    // an INSERT into every collection-backed table. If LegiScan adds a new
    // collection, add a fixture entry above and extend this list.
    const expectedTables = [
      'bills',
      'committees',
      'bill_history',
      'bill_sponsors',
      'bill_texts',
      'bill_supplements',
      'bill_amendments',
      'bill_sasts',
      'bill_subjects',
      'bill_referrals',
      'bill_calendar',
      'roll_calls',
    ]
    for (const table of expectedTables) {
      expect(joined, `missing INSERT INTO ${table}`).toContain(`INTO ${table}`)
    }
  })

  it('writes one INSERT per amendment with the correct columns', () => {
    const stmts = buildBillStatements(completeBill, 'WI', 2154)
    const amendmentStmts = stmts.filter(s => s.includes('INTO bill_amendments'))

    expect(amendmentStmts).toHaveLength(2)
    expect(amendmentStmts[0]).toContain('INSERT OR REPLACE INTO bill_amendments')
    expect(amendmentStmts[0]).toContain('600001')
    expect(amendmentStmts[0]).toContain("'Amendment 1'")
    expect(amendmentStmts[1]).toContain('600002')
    expect(amendmentStmts[1]).toContain("'Amendment 2'")
  })

  it('skips amendments cleanly when the bill has none', () => {
    const stmts = buildBillStatements({ ...completeBill, amendments: [] }, 'WI', 2154)
    expect(stmts.some(s => s.includes('INTO bill_amendments'))).toBe(false)
    // Bills row still gets written
    expect(stmts[0]).toContain('INSERT OR REPLACE INTO bills')
  })

  it('handles a minimal bill (no child collections at all)', () => {
    const minimal = {
      bill_id: 1,
      change_hash: 'h',
      bill_number: 'HB1',
      title: 'Minimal',
      description: null,
      status: 1,
    }
    const stmts = buildBillStatements(minimal, 'RI', 100)
    // Just the bills row, nothing else
    expect(stmts).toHaveLength(1)
    expect(stmts[0]).toContain('INSERT OR REPLACE INTO bills')
  })

  it('writes a committees row for every committee a referral names, once each', () => {
    const stmts = buildBillStatements({
      ...completeBill,
      referrals: [
        ...completeBill.referrals,
        { date: '2026-02-03', committee_id: 120, chamber: 'S', chamber_id: 27, name: 'Judiciary' },
        { date: '2026-02-04', committee_id: 0, chamber: 'S', chamber_id: 27, name: 'Rules' },
      ],
    }, 'WI', 2154)
    const committeeStmts = stmts.filter(s => s.includes('INTO committees'))
    // The pending committee (99) is also the first referral: one row for it.
    expect(committeeStmts).toHaveLength(2)
    expect(committeeStmts[0]).toContain('VALUES (99,')
    expect(committeeStmts[1]).toContain("VALUES (120, 'WI', 2154, 'S', 27, 'Judiciary', 'legiscan')")
    expect(committeeStmts[1]).toContain('ON CONFLICT(committee_id) DO UPDATE')
    expect(committeeStmts[1]).toContain('excluded.session_id >= committees.session_id')
  })

  it('handles committee being an empty array (not an object) without writing committees', () => {
    // LegiScan returns committee:[] for bills with no committee; the script must
    // treat that as "no committee" rather than crashing.
    const stmts = buildBillStatements({ ...completeBill, committee: [], referrals: [] }, 'WI', 2154)
    expect(stmts.some(s => s.includes('INTO committees'))).toBe(false)
    // bills row should still have NULL pending_committee_id (column present, value NULL)
    expect(stmts[0]).toContain('INTO bills')
  })

  it('escapes single quotes in bill description to prevent SQL injection', () => {
    const stmts = buildBillStatements(completeBill, 'WI', 2154)
    const billsRow = stmts[0]
    // Original had "apostrophe's"; SQL-escaped to "apostrophe''s"
    expect(billsRow).toContain("apostrophe''s")
  })

  it('falls back to sessionId arg when bill.session_id is missing', () => {
    const noSession = { ...completeBill, session_id: undefined }
    const stmts = buildBillStatements(noSession, 'WI', 2154)
    expect(stmts[0]).toContain(', 2154, ')
  })

  it('falls back to state arg when bill.state is missing', () => {
    const noState = { ...completeBill, state: undefined }
    const stmts = buildBillStatements(noState, 'OR', 2154)
    expect(stmts[0]).toContain("'OR'")
  })
})

describe('the seeded calendar', () => {
  // Central's real schema: every central migration, in filename order.
  const migrated = () => {
    const db = new DatabaseSync(':memory:')
    const dir = join(__dirname, '../../central/migrations')
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, file), 'utf8'))
    return db
  }
  const bill = {
    ...completeBill,
    calendar: [
      { type_id: 1, event_hash: 'ev1', type: 'Hearing', date: '2026-02-10', time: '10:00', location: 'Room 412', description: 'Public hearing' },
      { type_id: 3, event_hash: 'ev2', type: 'Markup Session', date: '2026-02-17', time: '10:00', location: 'Room 412', description: 'Executive session' },
    ],
  }
  const seed = (db: DatabaseSync) => { for (const s of buildBillStatements(bill, 'WI', 2154)) db.exec(s) }
  const calendar = (db: DatabaseSync) => db.prepare('SELECT event_hash, cancelled_at FROM bill_calendar ORDER BY event_hash').all()

  it('writes every entry of a bill central holds no calendar for', () => {
    const db = migrated()
    seed(db)
    expect(calendar(db)).toEqual([{ event_hash: 'ev1', cancelled_at: null }, { event_hash: 'ev2', cancelled_at: null }])
  })

  it('leaves a calendar central already holds alone when seeded again, so nothing cancelled comes back', () => {
    const db = migrated()
    seed(db)
    // The ingest has since cancelled the markup, and keeps its row.
    db.exec(`UPDATE bill_calendar SET cancelled_at = '2026-02-15 12:00:00' WHERE event_hash = 'ev2'`)
    db.exec(`DELETE FROM bill_calendar WHERE event_hash = 'ev1'`)
    db.exec(`INSERT INTO bill_calendar (id, bill_id, type_id, event_hash, description, identity_key) VALUES ('ingest-row', 12345, 1, 'ev1', 'Public hearing', '1|public hearing')`)
    seed(db)
    expect(calendar(db)).toEqual([{ event_hash: 'ev1', cancelled_at: null }, { event_hash: 'ev2', cancelled_at: '2026-02-15 12:00:00' }])
  })
})

describe('the seeded detail marker', () => {
  // The bulk seed writes a bill's full detail, so it records the change it is
  // at as the detail's (central migration 0041), as an ingest does. Otherwise
  // central reads every seeded stub as never fetched, and its first view spends
  // a getBill on detail central already holds (central/src/lib/stubRefresh.ts).
  const migrated = () => {
    const db = new DatabaseSync(':memory:')
    const dir = join(__dirname, '../../central/migrations')
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, file), 'utf8'))
    return db
  }
  const seed = (db: DatabaseSync) => { for (const s of buildBillStatements(completeBill, 'WI', 2154)) db.exec(s) }
  const marker = (db: DatabaseSync) => db.prepare(
    'SELECT change_hash, detail_hash, detail_requested_hash, detail_requested_at FROM bills WHERE bill_id = 12345').get()

  it("marks the seeded detail as fetched at the dump's change", () => {
    const db = migrated()
    seed(db)
    expect(marker(db)).toEqual({ change_hash: 'abc123', detail_hash: 'abc123', detail_requested_hash: null, detail_requested_at: null })
  })

  it('leaves a re-seeded bill current at the dump, with no refresh claim left over', () => {
    const db = migrated()
    seed(db)
    // Since the seed: the sync moved the bill on, and a view claimed a refresh of that change.
    db.exec(`UPDATE bills SET change_hash = 'def456', detail_requested_hash = 'def456', detail_requested_at = '2026-03-01 12:00:00' WHERE bill_id = 12345`)
    seed(db)
    expect(marker(db)).toEqual({ change_hash: 'abc123', detail_hash: 'abc123', detail_requested_hash: null, detail_requested_at: null })
  })
})

describe('a re-seeded bill', () => {
  // A seed run over bills central already ingested must not undo the ingest:
  // a text it stored keeps its stored copy, and the bill's history and
  // sponsors aren't written a second time under the seed's own ids.
  const migrated = () => {
    const db = new DatabaseSync(':memory:')
    const dir = join(__dirname, '../../central/migrations')
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, file), 'utf8'))
    return db
  }
  const seed = (db: DatabaseSync, bill: any = completeBill) => { for (const s of buildBillStatements(bill, 'WI', 2154)) db.exec(s) }
  const text = (db: DatabaseSync) => db.prepare(
    'SELECT r2_key, fetch_error, fetch_attempted_at, text_hash, date FROM bill_texts WHERE doc_id = 1000').get()
  const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE bill_id = 12345`).get() as any).n

  it('keeps a stored text, its download record, and its hash', () => {
    const db = migrated()
    seed(db)
    db.exec(`UPDATE bill_texts SET r2_key = 'bills/legiscan-12345/texts/1000.html', fetch_attempted_at = '2026-02-01 00:00:00' WHERE doc_id = 1000`)
    seed(db)
    expect(text(db)).toEqual({ r2_key: 'bills/legiscan-12345/texts/1000.html', fetch_error: null, fetch_attempted_at: '2026-02-01 00:00:00', text_hash: 'th', date: '2026-01-15' })
  })

  it("updates a stored text's details from the dump", () => {
    const db = migrated()
    seed(db)
    db.exec(`UPDATE bill_texts SET r2_key = 'k', fetch_attempted_at = '2026-02-01 00:00:00' WHERE doc_id = 1000`)
    seed(db, { ...completeBill, texts: [{ ...completeBill.texts[0], date: '2026-01-16' }] })
    expect(text(db)).toMatchObject({ r2_key: 'k', date: '2026-01-16' })
  })

  it('drops the stored copy when the dump names a different text hash, so the new version downloads', () => {
    const db = migrated()
    seed(db)
    db.exec(`UPDATE bill_texts SET r2_key = 'k', fetch_error = 'old error', fetch_attempted_at = '2026-02-01 00:00:00' WHERE doc_id = 1000`)
    seed(db, { ...completeBill, texts: [{ ...completeBill.texts[0], text_hash: 'th2' }] })
    expect(text(db)).toEqual({ r2_key: null, fetch_error: null, fetch_attempted_at: null, text_hash: 'th2', date: '2026-01-15' })
  })

  it("replaces an ingest's history and sponsors instead of adding to them", () => {
    const db = migrated()
    // What an ingest writes: its own ids.
    db.exec(`INSERT INTO bill_history (id, bill_id, date, action, chamber, chamber_id, importance, seq) VALUES ('uuid-1', 12345, '2026-01-15', 'Introduced', 'A', 26, 1, 0), ('uuid-2', 12345, '2026-02-01', 'Referred to committee', 'A', 26, 1, 1)`)
    db.exec(`INSERT INTO bill_sponsors (id, bill_id, people_id, sponsor_type_id, sponsor_order, committee_sponsor) VALUES ('uuid-3', 12345, 5001, 1, 1, 0), ('uuid-4', 12345, 5002, 2, 2, 0)`)
    seed(db)
    expect(count(db, 'bill_history')).toBe(completeBill.history.length)
    expect(count(db, 'bill_sponsors')).toBe(completeBill.sponsors.length)
  })

  it('writes history and sponsors once when seeded twice', () => {
    const db = migrated()
    seed(db)
    seed(db)
    expect(count(db, 'bill_history')).toBe(completeBill.history.length)
    expect(count(db, 'bill_sponsors')).toBe(completeBill.sponsors.length)
  })

  it("replaces an ingest's companions, subjects, and referrals instead of adding to them", () => {
    const db = migrated()
    db.exec(`INSERT INTO bill_sasts (id, bill_id, type_id, type, sast_bill_number, sast_bill_id) VALUES ('uuid-5', 12345, ${completeBill.sasts[0].type_id}, '${completeBill.sasts[0].type}', '${completeBill.sasts[0].sast_bill_number}', ${completeBill.sasts[0].sast_bill_id})`)
    db.exec(`INSERT INTO bill_subjects (id, bill_id, subject_id, subject_name) VALUES ('uuid-6', 12345, ${completeBill.subjects[0].subject_id}, 'x')`)
    db.exec(`INSERT INTO bill_referrals (id, bill_id, date, committee_id, chamber, chamber_id, name) VALUES ('uuid-7', 12345, '${completeBill.referrals[0].date}', ${completeBill.referrals[0].committee_id}, 'A', 26, 'x')`)
    seed(db)
    expect(count(db, 'bill_sasts')).toBe(completeBill.sasts.length)
    expect(count(db, 'bill_subjects')).toBe(completeBill.subjects.length)
    expect(count(db, 'bill_referrals')).toBe(completeBill.referrals.length)
  })

  it('leaves companions, subjects, and referrals alone when the dump leaves them out', () => {
    const db = migrated()
    seed(db)
    const { sasts: _a, subjects: _b, referrals: _c, ...withoutThem } = completeBill
    seed(db, withoutThem)
    expect(count(db, 'bill_sasts')).toBe(completeBill.sasts.length)
    expect(count(db, 'bill_subjects')).toBe(completeBill.subjects.length)
    expect(count(db, 'bill_referrals')).toBe(completeBill.referrals.length)
  })

  it.each([
    ['the dump has no hash', { text_hash: null }, 'th'],
    ['the dump has an empty hash', { text_hash: '' }, 'th'],
  ])('keeps the stored copy when %s, and the stored hash', (_label, change, kept) => {
    const db = migrated()
    seed(db)
    db.exec(`UPDATE bill_texts SET r2_key = 'k' WHERE doc_id = 1000`)
    seed(db, { ...completeBill, texts: [{ ...completeBill.texts[0], ...change }] })
    expect(text(db)).toMatchObject({ r2_key: 'k', text_hash: kept })
  })

  it('keeps the stored copy when central held no hash for it', () => {
    const db = migrated()
    seed(db)
    db.exec(`UPDATE bill_texts SET r2_key = 'k', text_hash = NULL WHERE doc_id = 1000`)
    seed(db)
    expect(text(db)).toMatchObject({ r2_key: 'k', text_hash: 'th' })
  })

  it('leaves history and sponsors alone when the dump leaves them out', () => {
    const db = migrated()
    seed(db)
    const { history: _h, sponsors: _s, ...withoutThem } = completeBill
    seed(db, withoutThem)
    expect(count(db, 'bill_history')).toBe(completeBill.history.length)
    expect(count(db, 'bill_sponsors')).toBe(completeBill.sponsors.length)
  })

  it("leaves another bill's history and sponsors alone", () => {
    const db = migrated()
    db.exec(`INSERT INTO bill_history (id, bill_id, date, action, chamber, chamber_id, importance, seq) VALUES ('other', 999, '2026-01-15', 'Introduced', 'A', 26, 1, 0)`)
    db.exec(`INSERT INTO bill_sponsors (id, bill_id, people_id, sponsor_type_id, sponsor_order, committee_sponsor) VALUES ('other', 999, 5001, 1, 1, 0)`)
    seed(db)
    expect((db.prepare('SELECT COUNT(*) n FROM bill_history WHERE bill_id = 999').get() as any).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) n FROM bill_sponsors WHERE bill_id = 999').get() as any).n).toBe(1)
  })
})
