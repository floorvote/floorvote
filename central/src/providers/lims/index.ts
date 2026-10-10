import { getBulkData, getCouncilPeriods, getLegislationDetails, getMembers, type LimsBulkRecord, type LimsCouncilPeriod } from './client'
import { buildLimsBill, bulkHash, clean, councilPeriodName, DC_STATE_ID, effectiveChangeHash, indexPeople, LIMS_STATE, LIMS_STATUS_LABELS, limsStatusCode, toMasterListEntry } from './map'
import { limsBillId, limsPeopleId, limsSessionId } from './ids'
import { limsCategories } from './config'
import type { Provider, ProviderImport, ProviderPerson, ProviderRecord, SyncSession } from '../sdk'

/**
 * The DC Council's Legislative Information Management System (client.ts,
 * map.ts).
 *
 * A session is a Council Period. Each full pass pulls BulkData for the
 * configured categories of the period (one call per category); the ingest
 * then adds LegislationDetails for each queued bill (map.ts). Ids are packed
 * into ranges LegiScan never reaches (ids.ts), so they are minted here rather
 * than from central's id table. Calls are logged as `lims:<op>`, which the
 * dashboard leaves out of the LegiScan budget.
 */

/** Final statuses: nothing further arrives in LegislationDetails. */
const SETTLED_STATUSES = ['Official Law', 'Withdrawn', 'Failed', 'Disapproved', 'Deemed Disapproved', 'Expired', 'Approved', 'Deemed Approved']
  .map(limsStatusCode)
  .concat(limsStatusCode(''))  // oversight notices: details add nothing
const MEMBER_BIO_URL = 'https://dccouncil.gov/councilmembers/'

/** LIMS category id for each measure-number prefix (GET LegislationCategories). */
const CATEGORY_BY_PREFIX: Record<string, number> = {
  B: 1, PR: 6, CER: 6, CA: 12, GBM: 13, REPROG: 14, HFA: 15,
  RC: 16, ANC: 16, AU: 16, CFO: 16, IG: 16, HN: 18, HR: 19, AG: 26,
}

export const lims: Provider<'LIMS_API_KEY' | 'LIMS_STATES' | 'LIMS_CATEGORIES'> = {
  id: 'lims',
  envKeys: ['LIMS_API_KEY', 'LIMS_STATES', 'LIMS_CATEGORIES'],
  states: [LIMS_STATE],
  configured: env => !!env.LIMS_API_KEY,
  statesEnvKey: 'LIMS_STATES',
  // LIMS answers 429 above about two concurrent requests.
  ingestQueue: 'LIMS_INGESTOR_QUEUE',

  /**
   * The current Council Period, plus the previous one while it is within a
   * year of ending. Council Periods change every two years.
   */
  async listSessions(_state, ctx) {
    const periods = await getCouncilPeriods(ctx.env.LIMS_API_KEY!, () => ctx.logCall('lims:CouncilPeriods', {}))
    const cp = pickCurrentPeriod(periods, ctx.today)
    if (!cp) return []
    const listed = [limsSession(cp, 0)]
    const previous = periods.find(p => p.councilPeriodId === cp.councilPeriodId - 1)
    if (previous && Number(previous.endDate.slice(0, 4)) >= Number(ctx.today.slice(0, 4)) - 1) {
      listed.push(limsSession(previous, 1))
    }
    return listed
  },

  /**
   * Members of every Council Period whose measures central holds, not just the
   * current one: a bill from an earlier period (the previous period, or one
   * imported with lims-import) names sponsors who may have left the Council.
   * The current period goes last, so its record wins where a name repeats.
   */
  async listPeople(sessions, ctx) {
    const current = sessions.find(s => s.prior === 0)
    const periodIds = [...new Set(sessions.filter(s => s !== current).map(councilPeriodOf))]
      .sort((a, b) => a - b)
    if (current) periodIds.push(councilPeriodOf(current))
    const people: ProviderPerson[] = []
    for (const councilPeriodId of periodIds) {
      const members = await getMembers(councilPeriodId, ctx.env.LIMS_API_KEY!,
        () => ctx.logCall('lims:Members', { councilPeriodId }))
      for (const m of members) {
        people.push({
          people_id: limsPeopleId(m.id),
          state_id: DC_STATE_ID,
          role: clean(m.title) || 'Councilmember',
          name: clean(m.name),
          first_name: clean(m.firstName) || null,
          middle_name: clean(m.middleName) || null,
          last_name: clean(m.lastName) || null,
          // LIMS people have no LegiScan profile; this is their sponsor link.
          bio: { social: { biography: MEMBER_BIO_URL } },
        })
      }
    }
    return people
  },

  /**
   * The current Council Period, and the previous one for a year after it ends:
   * acts passed late in a period finish Mayoral and Congressional review after
   * it.
   */
  selectSessions(sessions, today) {
    const year = Number(today.slice(0, 4))
    const current = sessions.find(r => r.prior === 0 && r.yearStart <= year && year <= r.yearEnd)
      ?? sessions.find(r => r.prior === 0)
    if (!current) return []
    return [current, ...sessions.filter(r => r.prior === 1 && r.yearEnd >= year - 1)]
  },

  async snapshot(session, ctx) {
    const councilPeriodId = councilPeriodOf(session)
    // One call per category, serially: LIMS rejects concurrent bursts.
    const records: ProviderRecord[] = []
    for (const categoryId of limsCategories(ctx.env)) {
      const rows = await getBulkData(categoryId, councilPeriodId, ctx.env.LIMS_API_KEY!,
        () => ctx.logCall('lims:BulkData', { categoryId, councilPeriodId }))
      for (const rec of rows) {
        const record = await limsRecord(rec)
        if (record) records.push(record)
      }
    }
    return { records }
  },

  async toEntry(record, stored, ctx) {
    const rec = record.raw as LimsBulkRecord
    return toMasterListEntry(rec, record.billId, await effectiveChangeHash(rec, record.hash, ctx.today), stored.description, ctx.today)
  },

  /**
   * The stored BulkData record plus a fresh LegislationDetails call (one LIMS
   * call), mapped together.
   */
  async fetchMeasure({ billId, sessionId, nativeKey, record, session }, ctx) {
    const apiKey = ctx.env.LIMS_API_KEY
    if (!apiKey) throw new Error(`bill ${billId} is a LIMS bill but LIMS_API_KEY is not set`)
    if (!record || !nativeKey || sessionId === null) throw new Error(`bill ${billId} has no stored LIMS record; the LIMS sync has not seen it`)

    const rec = record.raw as LimsBulkRecord
    const details = await getLegislationDetails(nativeKey, apiKey,
      () => ctx.logCall('lims:LegislationDetails', { number: nativeKey }))

    // LIMS member ids grow over time: in ascending order the latest record for a
    // name is indexed last and wins, and members who left stay findable.
    const members = await ctx.people()
    const byKey = indexPeople(members.map(m => ({ peopleId: m.peopleId, name: m.name, role: m.role ?? '' })))

    // The same change_hash the sync compares against (see effectiveChangeHash).
    const hash = await effectiveChangeHash(rec, record.hash, ctx.today)
    const measure = await buildLimsBill(rec, details, billId, hash, {
      session: {
        session_id: sessionId,
        session_name: session?.sessionName ?? `Council Period ${/^[A-Z]+(\d+)-/.exec(nativeKey)?.[1] ?? ''}`,
        year_start: session?.yearStart ?? 0,
        year_end: session?.yearEnd ?? 0,
      },
      people: byKey,
      today: ctx.today,
    })
    return { measure, details }
  },

  /**
   * Measures from any Council Period. The scheduled sync covers only the
   * current period and, for a year, the previous one; this is how a team pulls
   * in older measures it still works from (e.g. B25-0345, the Secure DC
   * Omnibus) without importing the whole period. One BulkData call per
   * (period, category) group.
   */
  async importMeasures(numbers, ctx) {
    const apiKey = ctx.env.LIMS_API_KEY!
    const result: ProviderImport = { invalid: [], notFound: [], sessions: [] }

    // Group by (Council Period, category): one BulkData call each.
    const groups = new Map<string, { cp: number; category: number; numbers: Set<string> }>()
    for (const raw of numbers) {
      const number = clean(raw).toUpperCase()
      const m = /^([A-Z]+)(\d{1,2})-(\d{1,5})$/.exec(number)
      const category = m ? CATEGORY_BY_PREFIX[m[1]] : undefined
      if (!m || !category || limsBillId(number) === null) { result.invalid.push(raw); continue }
      const key = `${m[2]}:${category}`
      const g = groups.get(key) ?? { cp: Number(m[2]), category, numbers: new Set<string>() }
      // Normalise the sequence to LIMS's four-digit form ("B25-345" → "B25-0345").
      g.numbers.add(`${m[1]}${m[2]}-${m[3].padStart(4, '0')}`)
      groups.set(key, g)
    }
    if (groups.size === 0) return result

    const periods = new Map((await getCouncilPeriods(apiKey, () => ctx.logCall('lims:CouncilPeriods', {})))
      .map(p => [p.councilPeriodId, p]))
    for (const g of groups.values()) {
      const cp = periods.get(g.cp)
      if (!cp) { result.notFound.push(...g.numbers); continue }
      const rows = await getBulkData(g.category, g.cp, apiKey,
        () => ctx.logCall('lims:BulkData', { categoryId: g.category, councilPeriodId: g.cp, reason: 'import' }))
      const wanted = rows.filter(r => g.numbers.has(clean(r.legislationNumber)))
      const found = new Set(wanted.map(r => clean(r.legislationNumber)))
      result.notFound.push(...[...g.numbers].filter(n => !found.has(n)))
      const records = (await Promise.all(wanted.map(limsRecord))).filter((r): r is ProviderRecord => r !== null)
      // A period central has never seen is created as a prior session, so the
      // daily sync leaves it out.
      const session = limsSession(cp, 1, cp.endDate.slice(0, 10) < ctx.today ? 1 : 0)
      result.sessions.push({ state: LIMS_STATE, session, records, numbers: [...found] })
    }
    return result
  },

  /**
   * LegislationDetails can change while the bulk record does not: a committee
   * report is filed after its mark-up, a vote is recorded, a hearing is
   * cancelled. With three passes a day this is at most 150 extra LIMS calls a day.
   */
  detailsRefresh: { maxAge: '-2 days', perPass: 50, settledStatuses: SETTLED_STATUSES },

  statusLabels: LIMS_STATUS_LABELS,
}

/** A BulkData row as a provider record, or null for a measure number ids.ts cannot encode. */
async function limsRecord(rec: LimsBulkRecord): Promise<ProviderRecord | null> {
  const billId = limsBillId(rec.legislationNumber)
  if (billId === null) {
    console.warn(`[sync-lims] skipping unrecognised measure number "${rec.legislationNumber}"`)
    return null
  }
  return { billId, nativeKey: clean(rec.legislationNumber), raw: rec, hash: await bulkHash(rec) }
}

/** A session's Council Period, from its tag ("CP26", as `limsSession` writes it). */
function councilPeriodOf(session: { sessionTag: string }): number {
  const m = /^CP(\d+)$/.exec(session.sessionTag)
  if (!m) throw new Error(`[lims] session tag "${session.sessionTag}" names no Council Period`)
  return Number(m[1])
}

function pickCurrentPeriod(periods: LimsCouncilPeriod[], today: string): LimsCouncilPeriod | null {
  const inRange = periods.find(p => p.startDate.slice(0, 10) <= today && today <= p.endDate.slice(0, 10))
  return inRange ?? [...periods].sort((a, b) => b.councilPeriodId - a.councilPeriodId)[0] ?? null
}

/** The session for a Council Period. */
function limsSession(cp: LimsCouncilPeriod, prior: 0 | 1, sineDie: 0 | 1 = 0): SyncSession {
  return {
    session_id: limsSessionId(cp.councilPeriodId),
    session_name: councilPeriodName(cp),
    state_id: DC_STATE_ID,
    year_start: Number(cp.startDate.slice(0, 4)),
    year_end: Number(cp.endDate.slice(0, 4)),
    session_tag: `CP${cp.councilPeriodId}`,
    prior,
    sine_die: sineDie,
  }
}
