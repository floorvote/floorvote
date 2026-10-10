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

  /**
   * The states the provider can serve. Omitted when it can serve any state.
   * Which provider a state actually syncs from is core's state ownership table
   * (lib/stateProviders.ts), and a claim for a state not listed here is refused.
   */
  readonly states?: readonly string[]

  /**
   * Whether this deployment has what the provider needs to run, such as its
   * API key, judged from its own env keys. Omitted when it needs nothing. A
   * claim for a provider that isn't configured is refused, and its sync skips.
   */
  configured?(env: Readonly<Pick<Env, K>>): boolean

  /**
   * The env key that named the provider's states before the ownership table,
   * such as 'LIMS_STATES' (comma-separated). For one release, the first sync
   * writes an ownership row for each state it names that has no row, under the
   * same refusal rule as a claim. Goes away with that seeding.
   */
  readonly statesEnvKey?: K

  /** Every session the provider lists for a state, current and prior. */
  listSessions(state: string, ctx: ProviderContext<K>): Promise<SyncSession[]>

  /**
   * One entry per measure in a session, with enough to keyword-match it and a
   * `change_hash` that moves whenever the measure does. Drives the full pass.
   * A provider lists a session's measures either this way or with `snapshot`.
   */
  listMeasures?(session: SessionRef, ctx: ProviderContext<K>): Promise<SyncEntry[]>

  /**
   * The cheap form of `listMeasures`: each measure's id, number, and change
   * hash, nothing else. Drives the raw pass, which re-fetches tracked measures
   * whose hash moved between full passes. Without it, a provider's sessions
   * skip their raw-pass hours and sync in full passes only.
   */
  listChangeHashes?(session: SessionRef, ctx: ProviderContext<K>): Promise<SyncHashEntry[]>

  /**
   * One measure's full record. A provider that builds it from a per-measure
   * details response returns that response too.
   */
  fetchMeasure(measure: MeasureRef, ctx: ProviderContext<K>): Promise<CentralMeasure | MeasureWithDetails>

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

  /**
   * The provider's per-member vote datasets for a state, one per session, each
   * with a hash that changes whenever its contents do. With
   * `fetchVoteDataset`, drives the weekly per-member vote load: core compares
   * hashes and downloads only datasets that changed. Omitted when the
   * provider's measure records carry member votes themselves, or it has none.
   */
  listVoteDatasets?(state: string, ctx: ProviderContext<K>): Promise<VoteDataset[]>

  /**
   * One session's vote dataset, as the bytes of a ZIP archive, streamed so
   * core can read it as it downloads. Core reads `vote/*.json` entries, each
   * `{ roll_call: { roll_call_id, votes: [{ people_id, vote_id, vote_text }] } }`
   * (LegiScan's getRollCall shape), and `people/*.json` entries, each
   * `{ person: MeasurePerson }`, at any depth. It also expects `bill/*.json`
   * entries and fails a load that has none of the three.
   */
  fetchVoteDataset?(dataset: VoteDataset, ctx: ProviderContext<K>): Promise<ReadableStream<Uint8Array>>

  // Snapshot providers. A feed with no modified-since filter and no cheap
  // change list is read as a snapshot: every record of a session, raw, with a
  // hash. Core's snapshot sync (cron/sync-snapshots.ts) stores each changed
  // record and hands it back, to `toEntry` for the full pass and to
  // `fetchMeasure` for the ingest. Its sessions refresh through `listSessions`
  // once a day, and whenever none is due to sync.

  /** Which of the provider's stored sessions for a state to sync now. */
  selectSessions?<S extends StoredSession>(sessions: S[], today: string): S[]

  /** Every record the provider lists for one session, and any legislators the listing names. */
  snapshot?(session: SessionRef, ctx: ProviderContext<K>): Promise<ProviderSnapshot>

  /**
   * The full-pass entry for one record. `stored` is what central already holds
   * for the measure, which a listed record may lack.
   */
  toEntry?(record: ProviderRecord, stored: { description: string | null }, ctx: ProviderContext<K>): Promise<SyncEntry>

  /**
   * The provider's legislators, for core to upsert into `people` after a
   * session refresh. `sessions` are the sessions just listed and every other
   * session central holds this provider's measures in, so a sponsor who has
   * since left still resolves.
   */
  listPeople?(sessions: StoredSession[], ctx: ProviderContext<K>): Promise<ProviderPerson[]>

  /**
   * Specific measures by number, from any session, for an operator importing
   * measures the scheduled sync doesn't cover. Core creates each session that
   * is missing, stores the records, and tracks the measures for the instance.
   */
  importMeasures?(numbers: string[], ctx: ProviderContext<K>): Promise<ProviderImport>

  /**
   * The env key of a queue binding for this provider's ingests, for an API
   * that needs less concurrency than the shared ingestor queue allows. Core
   * falls back to INGESTOR_QUEUE when the binding is unset. The provider never
   * sees the queue itself.
   */
  readonly ingestQueue?: ProviderEnvKey

  /**
   * For a provider whose per-measure details can change while its listed
   * record doesn't: core re-queues tracked measures not in a settled status
   * once their details are older than `maxAge` (an SQLite datetime modifier,
   * such as '-2 days'), at most `perPass` per pass. The settled statuses move
   * to the vocabulary's terminal flags in #291.
   */
  readonly detailsRefresh?: { maxAge: string; perPass: number; settledStatuses: readonly number[] }
}

/** One session's vote dataset, as `listVoteDatasets` lists it. */
export interface VoteDataset {
  sessionId: number
  /** Changes whenever the dataset's contents do. */
  hash: string
  /** The provider's handle for fetching it, such as an access key. Opaque to core. */
  key: string
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
  /** Today's date (YYYY-MM-DD, UTC), by core's clock. */
  today: string
  /**
   * Central ids for the provider's own keys of one kind (such as 'bill',
   * 'session', 'person', or 'doc'), minted from central's id table on first
   * sight and the same ever after. For a provider whose native ids aren't
   * integers, or could collide with another provider's.
   */
  ids(kind: string, nativeKeys: readonly string[]): Promise<Map<string, number>>
  /**
   * The people core has stored for this provider, by central id ascending, for
   * resolving the names its records use.
   */
  people(): Promise<{ peopleId: number; name: string; role: string | null }[]>
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
  /** The provider's own key for the measure, from the record core stored for a snapshot provider. */
  nativeKey?: string
  /** A snapshot provider's stored record for the measure, and its hash. */
  record?: { raw: unknown; hash: string }
  /** The measure's session row, when central has one. */
  session?: StoredSession
}

/** `fetchMeasure`'s result for a provider that also fetched a per-measure details response. */
export interface MeasureWithDetails {
  measure: CentralMeasure
  /**
   * The details response, whole (null when the provider found none). Core
   * stores it beside the measure's listed record, so a field the mapping
   * ignores today can be added later without fetching again, and records
   * when it was fetched, for `detailsRefresh`.
   */
  details: unknown
}

/** A session as central stores it, with what `selectSessions` and `listPeople` read. */
export interface StoredSession extends SessionRef {
  sessionName: string
  /** 1 when the session is no longer current. */
  prior: number
}

/**
 * One record a snapshot provider lists: the measure's central id, the
 * provider's own key for it, the record as listed, and a hash that moves
 * whenever the record does.
 */
export interface ProviderRecord {
  billId: number
  nativeKey: string
  raw: unknown
  hash: string
}

/** What `snapshot` returns. */
export interface ProviderSnapshot {
  records: ProviderRecord[]
  /** Legislators the listing names, for core to upsert into `people`. */
  people?: ProviderPerson[]
}

/**
 * A legislator as a provider lists them, for core to upsert into `people`
 * under the provider's id. A field left undefined is left alone on an existing
 * row, and null clears it.
 */
export interface ProviderPerson {
  people_id: number
  name: string
  state_id?: number
  role?: string
  role_id?: number
  first_name?: string | null
  middle_name?: string | null
  last_name?: string | null
  bio?: MeasurePerson['bio']
}

/** What `importMeasures` returns. */
export interface ProviderImport {
  /** Numbers that aren't any of the provider's measure numbers, as given. */
  invalid: string[]
  /** Numbers the provider looked for and didn't find. */
  notFound: string[]
  /**
   * What it found, by session, with the numbers found there. A session may
   * have no records, and core creates it anyway.
   */
  sessions: { state: string; session: SyncSession; records: ProviderRecord[]; numbers: string[] }[]
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
  /**
   * The provider's own page for the bill. LegiScan masterlists don't carry it
   * (getBill fills it later); LIMS sets it so monitor stubs link out too.
   */
  state_link?: string
  /** Bill type label, when the provider's list carries one (LIMS: "Emergency Bill", "Permanent Bill", ...). */
  bill_type?: string
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

/**
 * A legislator, in LegiScan's getPerson shape. Each sponsor carries one, and a
 * vote dataset holds one per `people/*.json` file. Core persists these into
 * `people` (lib/people.ts) so names resolve without a separate bulk seed.
 */
export interface MeasurePerson {
  people_id: number
  name: string
  party: string
  role: string
  role_id: number
  district: string
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

interface MeasureSponsor extends MeasurePerson {
  sponsor_type_id: number  // 1=Primary, 2=Co-Sponsor, 3=Joint Sponsor
  sponsor_order: number
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
  /**
   * Per-member votes. getBill never returns these (LegiScan needs a getRollCall
   * per vote); providers that include them inline, such as DC LIMS, set this and
   * the ingestor writes roll_call_votes. vote_id follows LegiScan: 1 Yea, 2 Nay,
   * 3 NV, 4 Absent.
   */
  member_votes?: { people_id: number | null; vote_id: number; vote_text: string }[]
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
