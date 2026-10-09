import type { Env } from '../types'

/**
 * The provider interface, and every shape that crosses the boundary between
 * core and a provider.
 *
 * A provider is where central gets a state's legislative data: LegiScan by
 * default, or a legislature's own feed. It knows one API and how to map what
 * that API returns into the shapes below. Core decides what to sync and when,
 * and does the writing to D1 and R2, keyword matching, and tenant
 * notification. Two things hold that line. ESLint lets provider code import
 * only `./sdk` (which re-exports this file), and lets core reach a provider
 * only through the registry in `./index`. And `ctx.env` carries only the env
 * keys a provider declares, so it never holds central's database, buckets, or
 * queues.
 *
 * The shapes are LegiScan's, since it was the first provider. Every provider
 * maps into them. Every id in them (`bill_id`, `session_id`, `doc_id`, and the
 * `billId` and `sessionId` core passes in) is a central id. For LegiScan,
 * central ids equal LegiScan's own. A provider whose native ids differ maps
 * between the two.
 */
export interface Provider<K extends ProviderEnvKey = ProviderEnvKey> {
  /** Stable id. Never shown to members. */
  readonly id: string

  /**
   * The env keys this provider reads, such as its API key. `ctx.env` holds
   * these and nothing else.
   */
  readonly envKeys: readonly K[]

  /** Every session the provider lists for a state, current and prior. */
  listSessions(state: string, ctx: ProviderContext<K>): Promise<SyncSession[]>

  /**
   * One entry per measure in a session, with enough to keyword-match it and a
   * `change_hash` that moves whenever the measure does. Drives the full pass.
   */
  listMeasures(session: SessionRef, ctx: ProviderContext<K>): Promise<SyncEntry[]>

  /**
   * The cheap form of `listMeasures`: each measure's id, number, and change
   * hash, nothing else. Drives the raw pass, which re-fetches tracked measures
   * whose hash moved between full passes. Without it, a provider's sessions
   * skip their raw-pass hours and sync in full passes only.
   */
  listChangeHashes?(session: SessionRef, ctx: ProviderContext<K>): Promise<SyncHashEntry[]>

  /** One measure's full record. */
  fetchMeasure(measure: MeasureRef, ctx: ProviderContext<K>): Promise<CentralMeasure>

  /**
   * The provider's own copy of one text document (`MeasureText.doc_id`), for
   * when the state's link won't yield it. Core checks the bytes against the
   * declared type, size, and `text_hash` before storing them. Omitted when the
   * provider keeps no copies of documents.
   */
  fetchDocument?(docId: number, ctx: ProviderContext<K>): Promise<ProviderDocument>

  /** Labels for the status codes this provider writes to `bills.status`, as the bill API sends them. */
  readonly statusLabels: Readonly<Record<number, string>>

  /**
   * Labels for the old and new values of a `status_change` record, when they
   * differ from `statusLabels`. Defaults to `statusLabels`.
   */
  readonly statusChangeLabels?: Readonly<Record<number, string>>

  /** A sponsor's profile page on the provider's site, for a person record with no link of its own. */
  personUrl?(person: { state: string; name: string; peopleId: number }): string
}

/** A key of central's env a provider may declare in `envKeys`. */
export type ProviderEnvKey = Extract<keyof Env, string>

/** What core hands a provider on every call. */
export interface ProviderContext<K extends ProviderEnvKey = ProviderEnvKey> {
  /** The env keys the provider declared in `envKeys`, frozen. Nothing else. */
  env: Readonly<Pick<Env, K>>
  /**
   * Record one outbound API call in `api_call_log`, which the dashboard counts
   * against the monthly call budget. Call it once per request actually sent
   * (pass it as `rateLimitedFetch`'s `onRequest`), not once per intent.
   */
  logCall(callType: string, params: Record<string, unknown>): void
}

/** A session as central stores it, handed to the list methods. */
export interface SessionRef {
  sessionId: number
  state: string
  /** The session's tag, from `SyncSession.session_tag` ('' when the provider gave none). */
  sessionTag: string
  yearStart: number
  yearEnd: number
}

/** A measure as central knows it, handed to `fetchMeasure`. */
export interface MeasureRef {
  billId: number
  /** The measure's session, when central already has a row for the measure. */
  sessionId: number | null
  /**
   * The provider's own key for the measure. Not set yet: central starts
   * recording native keys when a provider mints its own ids.
   */
  nativeKey?: string
}

/** A document's bytes, from the provider's own copy (`Provider.fetchDocument`). */
export interface ProviderDocument {
  bytes: ArrayBuffer
  /** Media type, when the provider records one. */
  mime?: string
  /** Size in bytes, as the provider declares it. */
  size?: number
}

/** One session, as `listSessions` returns it. The flags are 1 for yes. */
export interface SyncSession {
  session_id: number
  session_name: string
  year_start: number
  year_end: number
  /** The provider's numeric id for the state, when it has one. */
  state_id?: number
  /** A short label for the session, when the provider has one. */
  session_tag?: string
  prefile?: number
  sine_die?: number  // 1 = adjourned
  prior?: number     // 1 = not the current session for this state
  special?: number
}

/** One measure in a session's list, as `listMeasures` returns it. */
export interface SyncEntry {
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

/** One measure's change hash, as `listChangeHashes` returns it. */
export type SyncHashEntry = Pick<SyncEntry, 'bill_id' | 'number' | 'change_hash'>

interface MeasureText {
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

interface MeasureSponsor {
  people_id: number
  name: string
  party: string
  role: string
  role_id: number
  district: string
  sponsor_type_id: number  // 1=Primary, 2=Co-Sponsor, 3=Joint Sponsor
  sponsor_order: number
  // Each sponsor carries the full person record (LegiScan's getBill embeds one
  // in getPerson's shape). The ingest persists these into `people` so names
  // resolve without a separate bulk seed.
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

interface MeasureHistoryEntry {
  date: string
  action: string
  chamber: string
  chamber_id: number
  importance: number  // 1=major, 2=minor
}

interface MeasureSast {
  type_id: number
  type: string            // "Same As", "Carry Over", etc.
  sast_bill_number: string
  sast_bill_id: number
}

interface MeasureVote {
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

export interface MeasureCalendarEntry {
  type_id: number
  type: string
  date: string
  time: string
  location: string
  description: string
  event_hash: string
}

interface MeasureAmendment {
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

interface MeasureSupplement {
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

interface MeasureSubject {
  subject_id: number
  subject_name: string
}

/** One measure's full record, as `fetchMeasure` returns it: the shape the ingest writes. */
export interface CentralMeasure {
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
  sponsors: MeasureSponsor[]
  history: MeasureHistoryEntry[]
  sasts: MeasureSast[]
  subjects: MeasureSubject[]
  votes: MeasureVote[]
  texts: MeasureText[]
  calendar: MeasureCalendarEntry[]
  amendments: MeasureAmendment[]
  supplements: MeasureSupplement[]
}
