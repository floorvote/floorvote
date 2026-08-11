const BASE_URL = 'https://api.legiscan.com/'

export interface MasterListEntry {
  bill_id: number
  number: string
  change_hash: string
  title: string
  description: string
  status?: number
  status_date?: string
  last_action?: string
  last_action_date?: string
  url?: string
}

interface BillTextMeta {
  doc_id: number
  date: string
  type: string
  type_id: number
  mime: string
  mime_id: number
  url: string
  state_link: string
  text_size: number
  text_hash: string
  alt_bill_text: number
  alt_mime: string
  alt_mime_id: number
  alt_state_link: string
  alt_text_size: number
  alt_text_hash: string
}

export interface LegiscanSession {
  session_id: number
  session_name: string
  year_start: number
  year_end: number
  sine_die?: number  // 1 = adjourned
  prior?: number     // 1 = not the current session for this state
  special?: number
  sort_order?: number
}

interface LegiscanSponsor {
  people_id: number
  name: string
  party: string
  role: string
  role_id: number
  district: string
  sponsor_type_id: number  // 1=Primary, 2=Co-Sponsor, 3=Joint Sponsor
  sponsor_order: number
  // getBill embeds the full person record on each sponsor (same shape as
  // getPerson). We persist these into `people` at ingest so names resolve
  // without a separate bulk seed.
  person_hash?: string
  party_id?: string
  state_id?: number
  first_name?: string
  middle_name?: string
  last_name?: string
  suffix?: string
  nickname?: string
  ftm_eid?: number
  votesmart_id?: number
  opensecrets_id?: string
  knowwho_pid?: number
  ballotpedia?: string
  bioguide_id?: string
  bio?: {
    social?: {
      biography?: string
    }
  }
}

interface LegiscanHistoryEntry {
  date: string
  action: string
  chamber: string
  chamber_id: number
  importance: number  // 1=major, 2=minor
}

interface LegiscanSast {
  type_id: number
  type: string            // "Same As", "Carry Over", etc.
  sast_bill_number: string
  sast_bill_id: number
}

interface LegiscanVoteSummary {
  roll_call_id: number
  date: string
  desc: string
  yea: number
  nay: number
  nv: number
  absent: number
  total: number
  passed: number
  chamber: string
  chamber_id: number
  url: string
  state_link: string
}

export interface LegiscanCalendarEntry {
  type_id: number
  type: string
  date: string
  time: string
  location: string
  description: string
  event_hash: string
}

interface LegiscanAmendment {
  amendment_id: number
  adopted: number
  chamber: string
  date: string
  title: string
  description: string
  mime: string
  url: string
  state_link: string
  amendment_size: number
  amendment_hash: string
}

interface LegiscanSupplement {
  supplement_id: number
  date: string
  type_id: number
  type: string
  title: string
  description: string
  mime: string
  url: string
  state_link: string
  supplement_size: number
  supplement_hash: string
}

interface LegiscanSubject {
  subject_id: number
  subject_name: string
}

export interface LegiscanBill {
  bill_id: number
  bill_number: string
  title: string
  description: string
  state: string
  state_id: number
  change_hash: string
  status: number
  status_date: string
  bill_type: string
  bill_type_id: string
  body: string
  body_id: number
  current_body: string
  current_body_id: number
  url: string
  state_link: string
  pending_committee_id: number
  session_id: number
  session: { session_id: number; session_name: string; year_start: number; year_end: number }
  committee: { committee_id: number; chamber: string; chamber_id: number; name: string } | null | []
  referrals: { date: string; committee_id: number; chamber: string; chamber_id: number; name: string }[]
  progress: { date: string; event: number }[]
  sponsors: LegiscanSponsor[]
  history: LegiscanHistoryEntry[]
  sasts: LegiscanSast[]
  subjects: LegiscanSubject[]
  votes: LegiscanVoteSummary[]
  texts: BillTextMeta[]
  calendar: LegiscanCalendarEntry[]
  amendments: LegiscanAmendment[]
  supplements: LegiscanSupplement[]
}

async function legiscanFetch<T extends Record<string, unknown>>(
  op: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<T> {
  const url = new URL(BASE_URL)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('op', op)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`LegiScan HTTP ${res.status}`)
  const data = (await res.json()) as { status: string } & T
  if (data.status !== 'OK') throw new Error(`LegiScan API error: ${JSON.stringify(data)}`)
  return data
}

export async function getMasterList(state: string, apiKey: string): Promise<MasterListEntry[]> {
  const data = await legiscanFetch<{ masterlist: Record<string, unknown> }>(
    'getMasterList',
    { state },
    apiKey,
  )
  return Object.values(data.masterlist).filter(
    (v): v is MasterListEntry => typeof v === 'object' && v !== null && 'bill_id' in v,
  )
}

export async function getBill(billId: number, apiKey: string): Promise<LegiscanBill> {
  const data = await legiscanFetch<{ bill: LegiscanBill }>('getBill', { id: String(billId) }, apiKey)
  return data.bill
}

/** One bill-text document, as returned by `getBillText`. `doc` is base64. */
export interface LegiscanBillText {
  doc_id: number
  bill_id: number
  date: string
  type: string
  type_id: number
  mime: string
  mime_id: number
  text_size: number
  text_hash: string
  /** base64-encoded document bytes */
  doc: string
}

/**
 * Fetch one bill-text document from LegiScan, base64-encoded.
 *
 * This is the fallback for when a state's own `state_link` won't give us the
 * document — some legislature sites answer non-browser clients with their SPA
 * shell or an outright block, and LegiScan's mirror can 403. Keyed on **doc_id,
 * not bill_id**, so a bill with four text versions costs four calls: quota-wise
 * this is the expensive path, which is why it is only used after a direct fetch
 * has been tried and rejected.
 */
export async function getBillText(docId: number, apiKey: string): Promise<LegiscanBillText> {
  const data = await legiscanFetch<{ text: LegiscanBillText }>('getBillText', { id: String(docId) }, apiKey)
  return data.text
}

interface MasterListRawEntry {
  bill_id: number
  number: string
  change_hash: string
  title: string
  description: string
}

export async function getMasterListBySession(sessionId: number, apiKey: string): Promise<MasterListEntry[]> {
  const data = await legiscanFetch<{ masterlist: Record<string, unknown> }>(
    'getMasterList',
    { id: String(sessionId) },
    apiKey,
  )
  return Object.values(data.masterlist).filter(
    (v): v is MasterListEntry => typeof v === 'object' && v !== null && 'bill_id' in v,
  )
}

export async function getMasterListRaw(sessionId: number, apiKey: string): Promise<MasterListRawEntry[]> {
  const data = await legiscanFetch<{ masterlist: Record<string, unknown> }>(
    'getMasterListRaw',
    { id: String(sessionId) },
    apiKey,
  )
  return Object.values(data.masterlist).filter(
    (v): v is MasterListRawEntry => typeof v === 'object' && v !== null && 'bill_id' in v,
  )
}

export async function getSessionList(state: string, apiKey: string): Promise<LegiscanSession[]> {
  const data = await legiscanFetch<{
    sessions: Record<string, unknown>
  }>('getSessionList', { state }, apiKey)
  return Object.values(data.sessions).flatMap((v, index) => {
    if (typeof v !== 'object' || v === null || !('session_id' in v)) return []
    return [{ ...(v as LegiscanSession), sort_order: index }]
  })
}
