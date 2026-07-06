// Pure SQL-statement builders for the bulk-seed script. No Node-specific
// dependencies so this module can be unit-tested with vitest in a node env.
//
// Invariant: `buildBillStatements` must write every child collection that
// LegiScan's getBill response includes. New collections added to LegiscanBill
// must also be added here, and a test fixture row with that collection should
// be added to scripts/lib/build-bill-statements.test.ts.

export function esc(v: string | null | undefined): string {
  if (v == null) return 'NULL'
  return `'${String(v).replace(/'/g, "''")}'`
}

// Numeric SQL literal. Unlike esc(), the result is interpolated UNQUOTED, so a
// non-numeric value would become raw SQL. The bulk JSON is `any`-typed, so
// validate strictly: coerce, require finite, throw otherwise — never emit a raw
// non-number that could carry an injection.
export function num(v: number | null | undefined): string {
  if (v == null) return 'NULL'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) {
    throw new Error(`num(): expected a finite number, got ${JSON.stringify(v)}`)
  }
  return String(n)
}

// LegiScan bulk-JSON shape is loosely typed; we use `any` to mirror the script
// which has always parsed untyped JSON.
type LegiscanBillJson = any

/**
 * Build the SQL statements (as strings) needed to upsert one bill plus all its
 * child rows into the LegiScan central D1. The caller is responsible for
 * executing them (in a single d1 batch or chunked via wrangler).
 */
export function buildBillStatements(
  b: LegiscanBillJson,
  state: string,
  sessionId: number,
): string[] {
  const stmts: string[] = []

  let pendingCommitteeId: number | null = null
  if (b.committee && !Array.isArray(b.committee) && b.committee.committee_id) {
    pendingCommitteeId = b.committee.committee_id
  }

  // bills row — r2_key intentionally absent (NULL); ingestor fills it via skipFetch
  stmts.push(`INSERT OR REPLACE INTO bills (bill_id, change_hash, session_id, state, state_id, bill_number, bill_type, bill_type_id, body, body_id, current_body, current_body_id, title, description, status, status_date, completed, pending_committee_id, url, state_link, progress_json)
VALUES (${num(b.bill_id)}, ${esc(b.change_hash)}, ${num(b.session_id ?? sessionId)}, ${esc(b.state ?? state)}, ${num(b.state_id)}, ${esc(b.bill_number)}, ${esc(b.bill_type ?? 'B')}, ${esc(b.bill_type_id ?? '1')}, ${esc(b.body ?? '')}, ${num(b.body_id ?? 0)}, ${esc(b.current_body ?? '')}, ${num(b.current_body_id ?? 0)}, ${esc(b.title)}, ${esc(b.description)}, ${num(b.status ?? 1)}, ${esc(b.status_date)}, ${num(b.completed ?? 0)}, ${num(pendingCommitteeId)}, ${esc(b.url)}, ${esc(b.state_link)}, ${esc(b.progress ? JSON.stringify(b.progress) : null)});`)

  if (b.committee && !Array.isArray(b.committee) && b.committee.committee_id) {
    const c = b.committee
    stmts.push(`INSERT OR IGNORE INTO committees (committee_id, state, session_id, chamber, chamber_id, name)
VALUES (${num(c.committee_id)}, ${esc(b.state ?? state)}, ${num(b.session_id ?? sessionId)}, ${esc(c.chamber ?? '')}, ${num(c.chamber_id ?? 0)}, ${esc(c.name)});`)
  }

  for (let i = 0; i < (b.history ?? []).length; i++) {
    const h = b.history[i]
    stmts.push(`INSERT OR IGNORE INTO bill_history (id, bill_id, date, action, chamber, chamber_id, importance, seq)
VALUES (${esc(`${b.bill_id}-${i}`)}, ${num(b.bill_id)}, ${esc(h.date)}, ${esc(h.action)}, ${esc(h.chamber)}, ${num(h.chamber_id)}, ${num(h.importance ?? 1)}, ${num(i)});`)
  }

  for (let i = 0; i < (b.sponsors ?? []).length; i++) {
    const s = b.sponsors[i]
    stmts.push(`INSERT OR IGNORE INTO bill_sponsors (id, bill_id, people_id, sponsor_type_id, sponsor_order, committee_sponsor, committee_id)
VALUES (${esc(`${b.bill_id}-${s.people_id ?? 0}-${s.sponsor_order ?? i}`)}, ${num(b.bill_id)}, ${num(s.people_id)}, ${num(s.sponsor_type_id ?? 1)}, ${num(s.sponsor_order ?? i)}, ${num(s.committee_sponsor ?? 0)}, ${num(s.committee_id ?? null)});`)
  }

  for (const t of (b.texts ?? [])) {
    stmts.push(`INSERT OR REPLACE INTO bill_texts (doc_id, bill_id, date, type, type_id, mime, mime_id, url, state_link, text_size, text_hash, alt_bill_text, alt_mime, alt_mime_id, alt_state_link, alt_text_size, alt_text_hash)
VALUES (${num(t.doc_id)}, ${num(b.bill_id)}, ${esc(t.date)}, ${esc(t.type)}, ${num(t.type_id ?? 1)}, ${esc(t.mime ?? 'text/html')}, ${num(t.mime_id ?? 1)}, ${esc(t.url)}, ${esc(t.state_link)}, ${num(t.text_size)}, ${esc(t.text_hash)}, ${num(t.alt_bill_text ?? 0)}, ${esc(t.alt_mime)}, ${num(t.alt_mime_id)}, ${esc(t.alt_state_link)}, ${num(t.alt_text_size)}, ${esc(t.alt_text_hash)});`)
  }

  for (const s of (b.supplements ?? [])) {
    stmts.push(`INSERT OR REPLACE INTO bill_supplements (supplement_id, bill_id, date, type_id, type, title, description, mime, mime_id, url, state_link, supplement_size, supplement_hash)
VALUES (${num(s.supplement_id)}, ${num(b.bill_id)}, ${esc(s.date)}, ${num(s.type_id)}, ${esc(s.type)}, ${esc(s.title)}, ${esc(s.description)}, ${esc(s.mime)}, ${num(s.mime_id)}, ${esc(s.url)}, ${esc(s.state_link)}, ${num(s.supplement_size)}, ${esc(s.supplement_hash)});`)
  }

  for (const a of (b.amendments ?? [])) {
    stmts.push(`INSERT OR REPLACE INTO bill_amendments (amendment_id, bill_id, adopted, chamber, date, title, description, mime, url, state_link, amendment_size, amendment_hash)
VALUES (${num(a.amendment_id)}, ${num(b.bill_id)}, ${num(a.adopted ?? 0)}, ${esc(a.chamber)}, ${esc(a.date)}, ${esc(a.title)}, ${esc(a.description)}, ${esc(a.mime)}, ${esc(a.url)}, ${esc(a.state_link)}, ${num(a.amendment_size)}, ${esc(a.amendment_hash)});`)
  }

  for (const s of (b.sasts ?? [])) {
    stmts.push(`INSERT OR IGNORE INTO bill_sasts (id, bill_id, type_id, type, sast_bill_number, sast_bill_id)
VALUES (${esc(`${b.bill_id}-${s.sast_bill_id}-${s.type_id}`)}, ${num(b.bill_id)}, ${num(s.type_id)}, ${esc(s.type)}, ${esc(s.sast_bill_number)}, ${num(s.sast_bill_id)});`)
  }

  for (const s of (b.subjects ?? [])) {
    stmts.push(`INSERT OR IGNORE INTO bill_subjects (id, bill_id, subject_id, subject_name)
VALUES (${esc(`${b.bill_id}-${s.subject_id}`)}, ${num(b.bill_id)}, ${num(s.subject_id)}, ${esc(s.subject_name)});`)
  }

  for (const r of (b.referrals ?? [])) {
    stmts.push(`INSERT OR IGNORE INTO bill_referrals (id, bill_id, date, committee_id, chamber, chamber_id, name)
VALUES (${esc(`${b.bill_id}-${r.committee_id ?? 0}-${r.date ?? ''}`)}, ${num(b.bill_id)}, ${esc(r.date)}, ${num(r.committee_id)}, ${esc(r.chamber)}, ${num(r.chamber_id)}, ${esc(r.name)});`)
  }

  for (const c of (b.calendar ?? [])) {
    const calId = c.event_hash ?? `${c.type_id ?? 0}-${c.date ?? ''}-${c.time ?? ''}`
    stmts.push(`INSERT OR IGNORE INTO bill_calendar (id, bill_id, type_id, event_hash, type, date, time, location, description)
VALUES (${esc(`${b.bill_id}-${calId}`)}, ${num(b.bill_id)}, ${num(c.type_id)}, ${esc(c.event_hash)}, ${esc(c.type)}, ${esc(c.date)}, ${esc(c.time)}, ${esc(c.location)}, ${esc(c.description)});`)
  }

  for (const v of (b.votes ?? [])) {
    stmts.push(`INSERT OR IGNORE INTO roll_calls (roll_call_id, bill_id, date, description, yea, nay, nv, absent, total, passed, chamber, chamber_id, url, state_link)
VALUES (${num(v.roll_call_id)}, ${num(b.bill_id)}, ${esc(v.date)}, ${esc(v.desc)}, ${num(v.yea ?? 0)}, ${num(v.nay ?? 0)}, ${num(v.nv ?? 0)}, ${num(v.absent ?? 0)}, ${num(v.total ?? 0)}, ${num(v.passed ?? 0)}, ${esc(v.chamber)}, ${num(v.chamber_id)}, ${esc(v.url)}, ${esc(v.state_link)});`)
  }

  return stmts
}
