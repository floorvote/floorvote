import { sha256Hex, type CentralMeasure, type Provider, type ProviderRecord } from '../../../src/providers/sdk'
import { vocabulary } from './vocabulary'

/**
 * A provider for tests only: a made-up legislature in state ZZ whose feed is
 * one JSON array of records per session, like the MGA's. It exercises what
 * every provider shares (a snapshot, the mapping, extras, a field inventory,
 * and calendar entries with the feed's own event ids) with no network. Tests
 * set `exampleFeed.records` and add the provider to the registry with vi.mock.
 */
export interface ExampleRecord {
  Number: string
  Title: string
  Status: 'Introduced' | 'Enacted'
  Introduced: string
  Page: string
  LawNumber: string | null
  EffectiveDate: string | null
  Packet: string | null
  WithdrawnBy: string | null
  InternalId: number
  Attachments: { Name: string; Url: string; Size: number }[]
  /** Meetings with the measure on their agenda, each with the feed's own id. Removed ones stay listed, flagged. */
  Meetings?: { Id: string; Date: string; Title: string; Removed: boolean }[]
}

export const EXAMPLE_STATE = 'ZZ'
const SESSION = '2026'
const STATUS_CODES: Record<ExampleRecord['Status'], number> = { Introduced: 1, Enacted: 2 }

/** What the example feed returns for its one session. */
export const exampleFeed: { records: ExampleRecord[] } = { records: [] }

export const example: Provider = {
  id: 'example',
  displayName: 'Example Legislature',
  envKeys: [],
  states: [EXAMPLE_STATE],

  async listSessions(_state, ctx) {
    const ids = await ctx.ids('session', [SESSION])
    return [{ session_id: ids.get(SESSION)!, session_name: '2026 Session', session_tag: SESSION, year_start: 2026, year_end: 2026, prior: 0, sine_die: 0 }]
  },

  selectSessions: sessions => sessions,

  async snapshot(_session, ctx) {
    const ids = await ctx.ids('bill', exampleFeed.records.map(r => r.Number))
    const records = await Promise.all(exampleFeed.records.map(async (r): Promise<ProviderRecord> => ({
      billId: ids.get(r.Number)!, nativeKey: r.Number, raw: r, hash: await sha256Hex(JSON.stringify(r)),
    })))
    return { records }
  },

  async toEntry(record) {
    const r = record.raw as ExampleRecord
    return {
      bill_id: record.billId, number: r.Number, change_hash: record.hash, title: r.Title, description: r.Title,
      status: STATUS_CODES[r.Status], status_date: r.Introduced, state_link: r.Page, bill_type: 'B',
    }
  },

  async fetchMeasure({ billId, sessionId, record, session }) {
    if (!record || sessionId === null) throw new Error(`bill ${billId} has no stored example record`)
    const r = record.raw as ExampleRecord
    const measure: CentralMeasure = {
      bill_id: billId, bill_number: r.Number, title: r.Title, description: r.Title,
      state: EXAMPLE_STATE, state_id: 0, change_hash: record.hash,
      status: STATUS_CODES[r.Status], status_date: r.Introduced,
      bill_type: 'B', bill_type_id: '1', body: 'C', body_id: 0, current_body: 'C', current_body_id: 0,
      url: r.Page, state_link: r.Page, pending_committee_id: 0,
      session_id: sessionId,
      session: { session_id: sessionId, session_name: session?.sessionName ?? '2026 Session', year_start: 2026, year_end: 2026 },
      committee: null, referrals: [], progress: [], sponsors: [],
      history: [{ date: r.Introduced, action: 'Introduced', chamber: 'C', chamber_id: 0, importance: 1 }],
      sasts: [], subjects: [], votes: [], texts: [], amendments: [], supplements: [],
      calendar: await Promise.all((r.Meetings ?? []).map(async m => ({
        type_id: 1, type: 'Meeting', date: m.Date, time: '', location: '', description: m.Title,
        event_hash: (await sha256Hex(`${m.Date}|${m.Title}`)).slice(0, 32),
        event_id: m.Id,
        ...(m.Removed ? { cancelled: true } : {}),
      }))),
      extras: { lawNumber: r.LawNumber, effectiveDate: r.EffectiveDate, packet: r.Packet, withdrawnBy: r.WithdrawnBy },
    }
    return measure
  },

  vocabulary,
}
