import { describe, it, expect } from 'vitest'
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

  it('handles committee being an empty array (not an object) without writing committees', () => {
    // LegiScan returns committee:[] for bills with no committee; the script must
    // treat that as "no committee" rather than crashing.
    const stmts = buildBillStatements({ ...completeBill, committee: [] }, 'WI', 2154)
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
