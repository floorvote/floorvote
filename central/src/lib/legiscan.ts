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
