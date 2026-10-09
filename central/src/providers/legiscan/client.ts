import { rateLimitedFetch, type CentralMeasure, type SyncEntry } from '../sdk'

const BASE_URL = 'https://api.legiscan.com/'

/**
 * LegiScan enforces a ~2 requests/second sliding window as of October 1, 2026.
 * Pace at 1.5/sec for headroom rather than riding the ceiling.
 */
const LEGISCAN_RATE_PER_SEC = 1.5

export interface LegiscanSession {
  session_id: number
  session_name: string
  year_start: number
  year_end: number
  state_id?: number
  session_tag?: string
  sine_die?: number  // 1 = adjourned
  prior?: number     // 1 = not the current session for this state
  special?: number
  sort_order?: number
}

/**
 * `onRequest`, where threaded through, fires once per actual outbound HTTP
 * attempt (see `rateLimitedFetch`). Call sites use it for quota logging so the
 * log records egress, not intent.
 */
async function legiscanFetch<T extends Record<string, unknown>>(
  op: string,
  params: Record<string, string>,
  apiKey: string,
  onRequest?: () => void,
): Promise<T> {
  const url = new URL(BASE_URL)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('op', op)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await rateLimitedFetch(url.toString(), undefined, {
    ratePerSec: LEGISCAN_RATE_PER_SEC,
    bucketKey: 'legiscan',
    onRequest,
  })
  if (!res.ok) throw new Error(`LegiScan HTTP ${res.status}`)
  const data = (await res.json()) as { status: string } & T
  if (data.status !== 'OK') throw new Error(`LegiScan API error: ${JSON.stringify(data)}`)
  return data
}

export async function getMasterList(
  state: string,
  apiKey: string,
  onRequest?: () => void,
): Promise<SyncEntry[]> {
  const data = await legiscanFetch<{ masterlist: Record<string, unknown> }>(
    'getMasterList',
    { state },
    apiKey,
    onRequest,
  )
  return Object.values(data.masterlist).filter(
    (v): v is SyncEntry => typeof v === 'object' && v !== null && 'bill_id' in v,
  )
}

export async function getBill(
  billId: number,
  apiKey: string,
  onRequest?: () => void,
): Promise<CentralMeasure> {
  const data = await legiscanFetch<{ bill: CentralMeasure }>('getBill', { id: String(billId) }, apiKey, onRequest)
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
export async function getBillText(
  docId: number,
  apiKey: string,
  onRequest?: () => void,
): Promise<LegiscanBillText> {
  const data = await legiscanFetch<{ text: LegiscanBillText }>('getBillText', { id: String(docId) }, apiKey, onRequest)
  return data.text
}

interface MasterListRawEntry {
  bill_id: number
  number: string
  change_hash: string
  title: string
  description: string
}

export async function getMasterListBySession(
  sessionId: number,
  apiKey: string,
  onRequest?: () => void,
): Promise<SyncEntry[]> {
  const data = await legiscanFetch<{ masterlist: Record<string, unknown> }>(
    'getMasterList',
    { id: String(sessionId) },
    apiKey,
    onRequest,
  )
  return Object.values(data.masterlist).filter(
    (v): v is SyncEntry => typeof v === 'object' && v !== null && 'bill_id' in v,
  )
}

export async function getMasterListRaw(
  sessionId: number,
  apiKey: string,
  onRequest?: () => void,
): Promise<MasterListRawEntry[]> {
  const data = await legiscanFetch<{ masterlist: Record<string, unknown> }>(
    'getMasterListRaw',
    { id: String(sessionId) },
    apiKey,
    onRequest,
  )
  return Object.values(data.masterlist).filter(
    (v): v is MasterListRawEntry => typeof v === 'object' && v !== null && 'bill_id' in v,
  )
}

export async function getSessionList(
  state: string,
  apiKey: string,
  onRequest?: () => void,
): Promise<LegiscanSession[]> {
  const data = await legiscanFetch<{
    sessions: Record<string, unknown>
  }>('getSessionList', { state }, apiKey, onRequest)
  return Object.values(data.sessions).flatMap((v, index) => {
    if (typeof v !== 'object' || v === null || !('session_id' in v)) return []
    return [{ ...(v as LegiscanSession), sort_order: index }]
  })
}

/** One session's weekly bulk dataset, as listed by `getDatasetList`. */
export interface LegiscanDatasetEntry {
  session_id: number
  dataset_hash: string
  dataset_date?: string
  dataset_size?: number
  /** Required by getDatasetRaw. */
  access_key: string
}

/** Every bulk dataset LegiScan publishes for a state, one per session. */
export async function getDatasetList(
  state: string,
  apiKey: string,
  onRequest?: () => void,
): Promise<LegiscanDatasetEntry[]> {
  const data = await legiscanFetch<{ datasetlist: Record<string, unknown> }>(
    'getDatasetList',
    { state },
    apiKey,
    onRequest,
  )
  return Object.values(data.datasetlist).filter(
    (v): v is LegiscanDatasetEntry =>
      typeof v === 'object' && v !== null && 'session_id' in v && 'access_key' in v && 'dataset_hash' in v,
  )
}

/**
 * One session's bulk dataset ZIP (JSON format), as a raw binary stream.
 *
 * `getDatasetRaw` is `getDataset` without the base64 JSON envelope, so the
 * caller can unzip it as it downloads instead of holding the whole archive
 * (tens of MB for a large state) in memory. An error still comes back as a
 * LegiScan JSON body, so a JSON response is read and thrown.
 */
export async function getDatasetRaw(
  sessionId: number,
  accessKey: string,
  apiKey: string,
  onRequest?: () => void,
): Promise<ReadableStream<Uint8Array>> {
  const url = new URL(BASE_URL)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('op', 'getDatasetRaw')
  url.searchParams.set('id', String(sessionId))
  url.searchParams.set('access_key', accessKey)
  url.searchParams.set('format', 'json')

  const res = await rateLimitedFetch(url.toString(), undefined, {
    ratePerSec: LEGISCAN_RATE_PER_SEC,
    bucketKey: 'legiscan',
    onRequest,
  })
  if (!res.ok) throw new Error(`LegiScan HTTP ${res.status}`)
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    throw new Error(`LegiScan API error: ${(await res.text()).slice(0, 500)}`)
  }
  if (!res.body) throw new Error('LegiScan getDatasetRaw returned no body')
  return res.body
}
