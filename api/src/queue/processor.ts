import { and, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { processBill, type ProcessBillResult } from '../lib/llm'
import { filterTagsToTaxonomy } from '../lib/taxonomy'
import { centralFetch } from '../lib/centralFetch'
import { syncTitleKey } from '../lib/companionSuggestion'
import { recordDeliveryProbe } from '../lib/deliveryProbe'
import { loadAnalysisInputs, loadBillTextForAi } from '../lib/analysisInputs'
import { claimLinksEnabled, type ResolvedClaimSource } from '../lib/claimSources'
import { resolveClaimSources } from '../lib/claimResolution'
import { recordClaimSourcesCutOff } from '../lib/claimSourceCounts'
import { hearingUid } from '../lib/hearingUid'
import { matchesKeywords, billMatchText } from '../lib/keywords'
import { bills, associationConfig, feedEvents, billTexts, calendarEvents } from '../db/schema'
import { billSubjectStatements, syncBillSubjects } from '../lib/billSubjects'
import { billCommitteeStatements, syncBillCommittees, type CentralCommittee } from '../lib/billCommittees'
import { syncIdenticalCompanions } from '../lib/companionGroups'
import { pullCompanions } from '../lib/companionAnalysis'
import { nowDb } from '../lib/dbTime'
import { getNewMatchMinRelevance, newMatchesRowStatement } from '../lib/newMatch'
import { noteLegislativeEvent } from '../lib/noPriorityRow'
import { LEGACY_STATUS_ORDER, LEGISCAN_CODE_WORDS } from '../../../shared/legacyStatusOrder'
import { httpUrl } from '../../../shared/httpUrl'
import { handleForms, legacyHandle } from '../../../shared/billHandle'
import { resolveStoredHandle } from '../lib/storedHandle'
import type { AppDb, Env, TenantQueueMessage } from '../types'
import type { BatchItem } from 'drizzle-orm/batch'

class AiShedError extends Error {
  constructor(
    public readonly delaySeconds: number,
    /** Upstream HTTP status that caused the shed — 429 or 503. */
    public readonly status?: number,
    /** Short excerpt of the upstream body, which is what tells the two 429s apart. */
    public readonly detail?: string,
  ) {
    super('AI gateway shed — will redeliver')
  }
}

function isGeminiShed(err: unknown): boolean {
  const e = err as { status?: number } | undefined
  return e?.status === 429 || e?.status === 503
}

/**
 * Pull the status and a short body excerpt off a provider error.
 *
 * A 429 is ambiguous, and the two causes want opposite responses: transient
 * load shedding, where retrying with backoff is exactly right, and a hard quota
 * or credit wall, where every retry is another guaranteed failure and backoff
 * only delays the discovery. The status alone cannot separate them — the body
 * does ("prepayment credits are depleted" versus a rate-limit message) — so
 * capture enough of it to tell them apart while the incident is still live.
 *
 * This matters more than it looks: a shed writes no ai_error, so without this
 * a dead-lettered bill leaves no record anywhere of why it failed.
 */
function shedDetail(err: unknown): { status?: number; detail?: string } {
  const e = err as { status?: number; message?: unknown } | undefined
  const raw = typeof e?.message === 'string' ? e.message : String(err ?? '')
  return { status: e?.status, detail: raw.slice(0, 200) }
}

/**
 * Record a shed on the bill itself, so exhausting the retry budget is visible.
 *
 * A shed throws before the upsert, so it writes no bill row at all. That makes a
 * dead-lettered bill indistinguishable from one that was never queued: the table
 * looks untouched, no bill records a reason, and the only trace is a log line on
 * a queue-consumer invocation, which `wrangler tail` does not surface. A 116-bill
 * reprocess lost 56 bills that way without anything in the database changing.
 *
 * Writing on EVERY shed rather than only the last one is deliberate. A consumer
 * cannot see its own `max_retries` — it is wrangler config, and it varies per
 * tenant — so there is no reliable way to know which attempt is the final one.
 * Recording each attempt means the last one to run is the one that survives if
 * the message never comes back, which is the diagnostic we actually want.
 *
 * This is bookkeeping, not control flow: a failure here must never interfere with
 * the retry it is describing.
 *
 * LIMITATION: a shed throws before the upsert, so a bill with no row yet — a
 * first-time match that sheds on its very first analysis — has nothing to write
 * to, and the update matches zero rows. Those are still only visible in the logs.
 * The case this covers is the reprocess of bills that already exist, which is
 * where bills were actually being lost.
 */
/**
 * How long to hold a shed message before redelivering it.
 *
 * A shed is backpressure, so the useful question is how long the pipeline can
 * ride out a shedding window before the retry budget runs out. A fixed delay
 * answers that badly: at 60s with max_retries=10 the whole budget spans ten
 * minutes, and a provider shedding for longer than that dead-letters every
 * message in flight regardless of how many retries are configured. Raising the
 * retry count alone does not help much either — a UT reprocess with 10 retries
 * still dead-lettered roughly 360 messages in one burst.
 *
 * Doubling per attempt turns the same 10 retries into about five hours of
 * coverage. The cap keeps a single message from parking for a whole day, and
 * stays well inside Cloudflare's 0-86400s bound for delaySeconds.
 *
 * A zero base means "retry immediately" (the priority-to-standard tier fallback)
 * and is passed through untouched.
 */
const SHED_MAX_DELAY_SECONDS = 3600

export function shedRetryDelay(baseSeconds: number, attempts: number): number {
  if (baseSeconds <= 0) return 0
  const exponent = Math.max(0, attempts - 1)
  return Math.min(Math.round(baseSeconds * 2 ** exponent), SHED_MAX_DELAY_SECONDS)
}

async function recordShedAttempt(
  db: AppDb,
  billId: string,
  attempts: number,
  err: AiShedError,
): Promise<void> {
  const detail = err.detail ? ` — ${err.detail}` : ''
  const note = `AI provider shed (attempt ${attempts}, status ${err.status ?? 'unknown'}); will retry${detail}`
  try {
    // Deliberately does NOT touch lastAiTextHash, matching the transient-failure
    // branch of the upsert: the next pass must retry rather than dedup itself
    // into permanent silence. A later success clears aiError.
    await db.update(bills)
      .set({ aiAttemptedAt: nowDb(), aiError: note.slice(0, 300) })
      .where(inArray(bills.externalId, handleForms(billId)))
      .run()
  } catch (recordErr) {
    console.error(`[processor] could not record shed for ${billId}:`, recordErr)
  }
}

// AiSkipReason values mirror the column in api/migrations/0039_ai_skip_reason.sql.
// Add new reasons here and document them in the migration when new permanent-failure
// modes are discovered.
type AiSkipReason = 'pdf_too_large' | 'unreadable_document'

/**
 * Map an AI provider error to a permanent skip reason, or null if the error is
 * transient/unknown (in which case we let the normal retry behaviour run).
 *
 * Currently catches Gemini's 1000-page PDF limit. Transient Gemini errors
 * (429/503) are shed and retried upstream, so only non-transient errors
 * (status 400) reach this code path. We pattern-match the error message
 * because @google/genai doesn't expose a structured error code for this case.
 */
function classifyAiError(err: unknown): AiSkipReason | null {
  const e = err as { status?: number; message?: string } | undefined
  const status = e?.status
  const message = e?.message ?? ''
  if (status === 400 && /exceeds the supported page limit/i.test(message)) {
    return 'pdf_too_large'
  }
  // Gemini rejecting the bytes as a document at all. Retrying cannot help: the
  // stored object is not the document it claims to be (a state site serving an
  // HTML shell under a .pdf URL is the known cause). Recording it as a permanent
  // skip is what makes the failure visible instead of looking like a bill that
  // was never processed. `status` is matched loosely because the message is the
  // reliable signal — the code arrives on the error body, not always on `status`.
  if (/document has no pages|unable to process input image|invalid_argument.*document/i.test(message)) {
    return 'unreadable_document'
  }
  return null
}

function pickLatestTextDocId(centralBill: { texts?: Array<{ docId: string; date: string }> }): string | null {
  const texts = centralBill.texts
  if (!texts || texts.length === 0) return null
  // Doc ids are numeric strings and rise in issue order, so a same-day tie goes
  // to the higher one: compared as numbers, since "9" sorts above "10" as text.
  const sorted = [...texts].sort((a, b) =>
    b.date.localeCompare(a.date) || Number(b.docId) - Number(a.docId) || b.docId.localeCompare(a.docId))
  return sorted[0]?.docId ?? null
}

export async function processQueue(
  messages: Message<TenantQueueMessage>[],
  env: Env,
  db: AppDb,
): Promise<void> {
  for (const message of messages) {
    try {
      await processCentralNotification(message.body, env, db)
      message.ack()
    } catch (err) {
      if (err instanceof AiShedError) {
        await recordShedAttempt(db, message.body.billId, message.attempts, err)
        console.warn(
          `[processor] AI gateway shed for ${message.body.billId}`
          + ` (status ${err.status ?? 'unknown'})`
          + `${err.delaySeconds > 0 ? `, attempt ${message.attempts}, requeing in ${shedRetryDelay(err.delaySeconds, message.attempts)}s` : ', requeing immediately'}`
          + `${err.detail ? ` — ${err.detail}` : ''}`,
        )
        const delaySeconds = shedRetryDelay(err.delaySeconds, message.attempts)
        if (delaySeconds > 0) {
          message.retry({ delaySeconds })
        } else {
          message.retry()
        }
      } else {
        console.error('Queue processing failed for message', message.body, err)
        message.retry()
      }
    }
  }
}

type CentralBill = {
  billId: string
  sessionId: string | null
  sessionName: string | null
  /** Unique within the state. Null from a central older than the slug, or for a session it hasn't slugged yet. */
  sessionSlug?: string | null
  yearStart: number | null
  yearEnd: number | null
  state: string
  number: string
  title: string
  abstract: string | null
  status: string | null
  /** The status's common stage and rank, from the provider's vocabulary. */
  statusStage?: string | null
  statusRank?: number
  statusDate: string | null
  lastAction?: string | null
  lastActionDate?: string | null
  updatedAt: string
  stateUrl: string | null
  textHash: string | null
  textR2Key: string | null
  textStatus?: 'not_checked' | 'no_texts' | 'available' | 'in_r2'
  texts: Array<{ docId: string; note: string; date: string; /** This document's hash. Absent from a central older than #603. */ textHash?: string | null; links: Array<{ url: string; mediaType: string }> }>
  /** `videoUrl`: a recording of the meeting, when the provider publishes one. Absent from an older central. */
  actions: Array<{ description: string; date: string; chamber: string | null; classification: string[]; order: number; videoUrl?: string | null }>
  sponsors: Array<{ name: string; party: string | null; role: string | null; primary: boolean; personId: string | null; url: string | null }>
  votes: Array<unknown>
  /** `sastBillId` is central's id for the other bill, and `kind` what the provider's vocabulary makes of the relationship. Both absent from an older central. */
  relatedBills: Array<{ identifier: string; session: string; relationType: string; sastBillId?: number | null; kind?: string }>
  subjects?: string[]
  /** The committee the bill is pending in, and its referrals, each named by central's committee row (#471). */
  committee?: CentralCommittee | null
  referrals?: CentralCommittee[]
  /** The bill's chamber as central stores it. Empty for a stub central hasn't fetched. */
  body?: string | null
  /** What title-matched companion suggestions match the bill by (#521), or null. Absent from an older central. */
  titleKey?: string | null
}

/**
 * The status as the bill stores it: central's label, or for a bare LegiScan
 * progress code (which a central from before provider vocabularies still
 * sends), the word central sends now. Migration 0076 rewrote stored codes the
 * same way, so the status filter never lists a code and its word separately.
 */
function storedStatus(b: CentralBill): string {
  const status = b.status ?? ''
  return LEGISCAN_CODE_WORDS[status] ?? status
}

/**
 * The bill's status stage and rank. A central from before provider
 * vocabularies sends neither, so they come from the status string, from the
 * table migration 0076 backfilled with.
 */
function statusOrder(b: CentralBill): { statusStage: string | null; statusRank: number } {
  if (typeof b.statusRank === 'number') return { statusStage: b.statusStage ?? null, statusRank: b.statusRank }
  const legacy = LEGACY_STATUS_ORDER[b.status ?? '']
  return { statusStage: legacy?.stage ?? null, statusRank: legacy?.rank ?? 0 }
}

/**
 * The bill's history as `bills.history` stores it. An entry keeps its meeting
 * video only as an http(s) link, since the bill page puts it in an href.
 */
function historyFrom(actions: CentralBill['actions']): { date: string; action: string; chamber: string | null; videoUrl?: string }[] {
  return actions.map(a => {
    const videoUrl = httpUrl(a.videoUrl)
    return { date: a.date, action: a.description, chamber: a.chamber, ...(videoUrl ? { videoUrl } : {}) }
  })
}

export async function processCentralNotification(
  msg: TenantQueueMessage,
  env: Env,
  db: AppDb,
): Promise<void> {
  if (msg.tenantId !== env.TENANT_ID) return
  // A delivery check (scripts/verify-instance.sh): record that it arrived, under
  // the handle central sent, and stop. It must reach no bill write, no feed
  // event, and no analysis.
  if (msg.probe !== undefined) return recordDeliveryProbe(msg, env, db)

  // A handle may arrive in either form (#305). Everything below, including the
  // bill lookup and the handle it is stored under, sees the spelling this
  // instance stores for the bill. Only the reads from central and the calendar
  // UIDs use the legacy one.
  msg = { ...msg, billId: await resolveStoredHandle(db, msg.billId) }

  // When this copy of the bill was read: texts stored later come from a newer one.
  const fetchedAt = nowDb()
  const res = await centralFetch(env, `/bills/${legacyHandle(msg.billId)}`)
  if (!res.ok) throw new Error(`Central API returned ${res.status} for bill ${msg.billId}`)

  const centralBill = await res.json() as CentralBill

  // A full delivery that read an older version than the one stored stops here:
  // the steps below write from that older copy too, and the delivery that
  // stored the newer version already ran them.
  if (await applyCentralBill(msg, env, db, centralBill, fetchedAt) === 'stale') return
  // After every path too, so a state opted into or out of title-matched
  // suggestions reaches the bill on any delivery (lib/companionSuggestion.ts).
  await syncTitleKey(db, msg.billId, centralBill)
  // After every path above, including the ones that skip an unchanged bill:
  // a bill's identical companions can change without its provider data
  // changing (a vocabulary edit), and this is cheap when nothing did.
  await syncIdenticalCompanions(db, msg.billId, centralBill.relatedBills)
  if (msg.stubOnly || msg.metadataOnly) await syncGroupedBillTexts(db, msg.billId, centralBill, fetchedAt)
  await pullCompanions(env, db, msg)
}

/**
 * True (1) when the stored provider version is newer than `incoming`. Compared
 * as times, not strings: central's stamps were ISO (`T`, `Z`) before they were
 * the space format, and as strings a space sorts before `T` on the same day. A
 * stamp SQLite can't read, or a missing one, never counts as newer, so the write
 * goes ahead as it always has.
 */
function storedIsNewer(incoming: SQL | string): SQL<number> {
  return sql<number>`COALESCE(julianday(${bills.providerUpdatedAt}) > julianday(${incoming}), 0)`
}

/**
 * Store what central sent for the bill, and analyze it when it should be.
 * 'stale' when a full delivery read an older version than the one stored: it
 * stored none of that version, and recorded only its own changes
 * (recordStaleDelivery).
 */
async function applyCentralBill(
  msg: TenantQueueMessage,
  env: Env,
  db: AppDb,
  centralBill: CentralBill,
  fetchedAt: string,
): Promise<'stale' | void> {
  const existing = await db.select({
    id: bills.id,
    providerUpdatedAt: bills.providerUpdatedAt,
    storedIsNewer: storedIsNewer(centralBill.updatedAt),
    lastAiTextHash: bills.lastAiTextHash,
    status: bills.status,
    lastAction: bills.lastAction,
    aiProcessedAt: bills.aiProcessedAt,
    aiSkipReason: bills.aiSkipReason,
    matchType: bills.matchType,
    groupKey: bills.groupKey,
    priority: bills.priority,
    textR2Key: bills.textR2Key,
    newMatchAt: bills.newMatchAt,
    matchProvenance: bills.matchProvenance,
  }).from(bills).where(eq(bills.externalId, msg.billId)).get()

  // Stub-only path: upsert metadata, mark as stub, skip text fetch + AI entirely
  if (msg.stubOnly) {
    // Don't re-stub bills that have AI data (they were promoted to full tracking)
    // or that were manually added by an admin. This guards against:
    //   - a stub message arriving after a promote (race) that would otherwise
    //     hide a fully-tracked bill from members
    //   - a manually-added bill being downgraded to a stub
    //
    // A bill that didn't match, in a companion group, and was analyzed through
    // it (lib/companionAnalysis.ts) is not that: it holds its analysis without
    // being tracked, and takes stub updates like any bill that didn't match.
    // Skipping them would freeze its status and history at the day it was
    // analyzed.
    const analyzedThroughGroup = existing?.matchType === null && existing.groupKey !== null
    if ((existing?.aiProcessedAt && !analyzedThroughGroup) || existing?.matchType === 'manual') {
      console.log(`[processor] skipping stub upsert for ${msg.billId}: already tracked or manual`)
      // Recording subjects is not a downgrade — only the stub metadata upsert
      // (and its matchType write) is what the guard above exists to prevent.
      // Without this, a bill with ai_processed_at set and match_type NULL
      // (analyzed in the past, no longer keyword-matched) never gets subjects
      // on any path: the operator's stub-refresh route selects exactly these
      // bills and only ever sends them stubOnly messages. The status, stage,
      // and rank are refreshed here for the same reason: a one-time resend
      // after a vocabulary change reaches these bills only through
      // refresh-stubs.
      if (existing) {
        await db.update(bills)
          .set({
            subjects: centralBill.subjects?.length ? JSON.stringify(centralBill.subjects) : null,
            status: storedStatus(centralBill),
            ...statusOrder(centralBill),
          })
          .where(eq(bills.id, existing.id))
        await syncBillSubjects(db, existing.id, centralBill.state, centralBill.subjects ?? [])
        await syncBillCommittees(db, existing.id, centralBill.state, centralBill.committee, centralBill.referrals)
      }
      return
    }
    const primarySponsorStub = centralBill.sponsors.find(s => s.primary) ?? centralBill.sponsors[0] ?? null
    const coSponsorListStub = centralBill.sponsors
      .filter(s => s !== primarySponsorStub)
      .map(s => ({ name: s.name, url: s.url ?? null, party: s.party ?? null }))
    const historyStub = historyFrom(centralBill.actions)
    const lastActionStub = centralBill.lastAction
      ?? (historyStub.length > 0 ? historyStub[historyStub.length - 1].action : null)
    const lastActionDateStub = centralBill.lastActionDate
      ?? (centralBill.actions.length > 0
        ? centralBill.actions[centralBill.actions.length - 1].date
        : null)
    const nowStub = nowDb()

    const stubData = {
      externalId: msg.billId,
      billNumber: centralBill.number,
      title: centralBill.title,
      state: centralBill.state,
      status: storedStatus(centralBill),
      ...statusOrder(centralBill),
      session:   centralBill.sessionName ?? resolveSessionLabel(centralBill.sessionId),
      sessionSlug: centralBill.sessionSlug ?? null,
      sessionId: centralBill.sessionId ?? null,
      yearStart: centralBill.yearStart ?? null,
      yearEnd:   centralBill.yearEnd   ?? null,
      abstract: centralBill.abstract ?? null,
      url: centralBill.stateUrl ?? null,
      stateUrl: centralBill.stateUrl ?? null,
      providerUpdatedAt: centralBill.updatedAt,
      sponsor: primarySponsorStub?.name ?? null,
      sponsorParty: primarySponsorStub?.party ?? null,
      sponsorUrl: primarySponsorStub?.url ?? null,
      coSponsors: coSponsorListStub.length > 0 ? JSON.stringify(coSponsorListStub) : null,
      lastAction: lastActionStub,
      lastActionDate: lastActionDateStub,
      history: historyStub.length > 0 ? JSON.stringify(historyStub) : null,
      relatedBillIds: centralBill.relatedBills.length > 0
        ? JSON.stringify(centralBill.relatedBills.map(r => r.identifier))
        : null,
      centralSyncedAt: nowStub,
      matchType: msg.matchType !== undefined ? msg.matchType : (existing?.matchType ?? null),
      textStatus: centralBill.textStatus ?? null,
      subjects: centralBill.subjects?.length ? JSON.stringify(centralBill.subjects) : null,
    }

    const { id: stubInternalId } = await upsertBill(db, msg.billId, { ...stubData, updatedAt: nowStub })
    await syncBillSubjects(db, stubInternalId, centralBill.state, centralBill.subjects ?? [])
    await syncBillCommittees(db, stubInternalId, centralBill.state, centralBill.committee, centralBill.referrals)
    return
  }

  // Metadata-only path: upsert metadata from central, skip text fetch + AI.
  // Used to refresh denormalized fields (history, sponsors, etc.) without burning AI quota.
  // It leaves `providerUpdatedAt` out, so the stored version stays what it was (empty for a bill it
  // creates). A bill whose text changed while a refresh was draining must still look changed to its
  // regular delivery, which runs the full path; stamping central's version here would have that
  // delivery skipped and the summary left on the old text (#789).
  if (msg.metadataOnly) {
    const primarySponsorMd = centralBill.sponsors.find(s => s.primary) ?? centralBill.sponsors[0] ?? null
    const coSponsorListMd = centralBill.sponsors
      .filter(s => s !== primarySponsorMd)
      .map(s => ({ name: s.name, url: s.url ?? null, party: s.party ?? null }))
    const historyMd = historyFrom(centralBill.actions)
    const lastActionMd = centralBill.lastAction
      ?? (historyMd.length > 0 ? historyMd[historyMd.length - 1].action : null)
    const lastActionDateMd = centralBill.lastActionDate
      ?? (centralBill.actions.length > 0
        ? centralBill.actions[centralBill.actions.length - 1].date
        : null)
    const nowMd = nowDb()

    const metadataData = {
      externalId: msg.billId,
      billNumber: centralBill.number,
      title: centralBill.title,
      state: centralBill.state,
      status: storedStatus(centralBill),
      ...statusOrder(centralBill),
      session:   centralBill.sessionName ?? resolveSessionLabel(centralBill.sessionId),
      sessionSlug: centralBill.sessionSlug ?? null,
      sessionId: centralBill.sessionId ?? null,
      yearStart: centralBill.yearStart ?? null,
      yearEnd:   centralBill.yearEnd   ?? null,
      abstract: centralBill.abstract ?? null,
      url: centralBill.stateUrl ?? null,
      stateUrl: centralBill.stateUrl ?? null,
      sponsor: primarySponsorMd?.name ?? null,
      sponsorParty: primarySponsorMd?.party ?? null,
      sponsorUrl: primarySponsorMd?.url ?? null,
      coSponsors: coSponsorListMd.length > 0 ? JSON.stringify(coSponsorListMd) : null,
      lastAction: lastActionMd,
      lastActionDate: lastActionDateMd,
      history: historyMd.length > 0 ? JSON.stringify(historyMd) : null,
      relatedBillIds: centralBill.relatedBills.length > 0
        ? JSON.stringify(centralBill.relatedBills.map(r => r.identifier))
        : null,
      centralSyncedAt: nowMd,
      matchType: msg.matchType !== undefined ? msg.matchType : (existing?.matchType ?? null),
      textR2Key: centralBill.textR2Key,
      textStatus: centralBill.textStatus ?? null,
      subjects: centralBill.subjects?.length ? JSON.stringify(centralBill.subjects) : null,
    }

    const { id: metadataInternalId } = await upsertBill(db, msg.billId, { ...metadataData, updatedAt: nowMd })
    await syncBillSubjects(db, metadataInternalId, centralBill.state, centralBill.subjects ?? [])
    await syncBillCommittees(db, metadataInternalId, centralBill.state, centralBill.committee, centralBill.referrals)
    return
  }

  // Never go back a version. Each delivery reads central's copy when it runs, so when two deliveries
  // of the bill overlap, a slow one (the AI call takes seconds) can finish after the other stored a
  // newer version. Writing it would put the older fields, stamp, and child rows back. No flag
  // overrides this: a forced pass on an older copy has nothing to add, and the newer version is
  // analyzed by its own delivery. Its changes are still news (recordStaleDelivery). The commit
  // below checks again, for a version stored after this read.
  if (existing?.storedIsNewer) {
    console.log(`[processor] skipping ${msg.billId}: central sent ${centralBill.updatedAt}, older than the stored ${existing.providerUpdatedAt}`)
    await recordStaleDelivery(db, env, msg, existing.id, true)
    return 'stale'
  }

  // Skip entirely if nothing changed (unless forced)
  // But always process if the bill is currently a stub — it needs to flip to non-stub status,
  // or if central now has an R2 key that the tenant hasn't recorded yet.
  // `aiSkipReason` is paired with `aiProcessedAt` here: either one being set means we
  // already terminally decided AI's fate for this central-version of the bill (success
  // or permanent failure), so re-fetching text + re-trying AI would be wasted work.
  // Recovery: forceAI/forceMetadata/stubOnly/metadataOnly all bypass; a new R2 key
  // (i.e. text content actually changed) also bypasses, which re-attempts AI and
  // either succeeds (clearing the reason) or hits the same skip.
  const centralHasNewR2Key = !!centralBill.textR2Key && !existing?.textR2Key
  // A bill that didn't match and now does (a companion analyzed through its group, say, whose title changed)
  // is news even when its provider data hasn't: central says so with the match type alone, and nothing here
  // stored it.
  const newlyMatched = !!msg.matchType && !existing?.matchType
  // A group analysis asks for the analysis of a bill that didn't match (lib/companionAnalysis.ts), such as a
  // group's lead whose newest text isn't the one its analysis read. Its own delivery already stored that
  // version without analyzing it, so the version alone can't say whether the analysis is current: the text
  // hash dedup below does.
  if (!msg.forceMetadata && !msg.forceAI && !msg.groupAnalysis && !msg.stubOnly && !msg.metadataOnly && !centralHasNewR2Key && !newlyMatched && existing?.providerUpdatedAt === centralBill.updatedAt && (existing?.aiProcessedAt != null || existing?.aiSkipReason != null)) {
    // Calendar reconciliation must still run even when the bill itself hasn't changed,
    // since hearings are updated independently of bill metadata.
    if (msg.calendar && existing && (existing.matchType !== null || existing.priority !== null || existing.groupKey !== null)) {
      const nowEarly = nowDb()
      await reconcileCalendar(db, env, existing.id, msg, false, nowEarly)
    }
    return
  }

  // Map normalized sponsors: the first primary sponsor (or the first listed) is the sponsor, the rest are co-sponsors
  const primarySponsor = centralBill.sponsors.find(s => s.primary) ?? centralBill.sponsors[0] ?? null
  const coSponsorList = centralBill.sponsors
    .filter(s => s !== primarySponsor)
    .map(s => ({ name: s.name, url: s.url ?? null, party: s.party ?? null }))

  const history = historyFrom(centralBill.actions)
  const lastAction = centralBill.lastAction
    ?? (history.length > 0 ? history[history.length - 1].action : null)
  const lastActionDate = centralBill.lastActionDate
    ?? (centralBill.actions.length > 0
      ? centralBill.actions[centralBill.actions.length - 1].date
      : null)

  const now = nowDb()

  // Safety net: never run AI on a bill that has no full text in central.
  // Defense in depth against silent text-download failures upstream — protects
  // the "no Gemini on bills without text" invariant even when the ingestor's
  // text fetch fails. AI is skipped (aiProcessedAt stays null) so the UI shows
  // the right state.
  const hasFullText = (centralBill.texts?.length ?? 0) > 0 && !!centralBill.textHash

  const billData = {
    externalId: msg.billId,
    billNumber: centralBill.number,
    title: centralBill.title,
    state: centralBill.state,
    status: storedStatus(centralBill),
    ...statusOrder(centralBill),
    session:   centralBill.sessionName ?? resolveSessionLabel(centralBill.sessionId),
    sessionSlug: centralBill.sessionSlug ?? null,
    sessionId: centralBill.sessionId ?? null,
    yearStart: centralBill.yearStart ?? null,
    yearEnd:   centralBill.yearEnd   ?? null,
    abstract: centralBill.abstract ?? null,
    url: centralBill.stateUrl ?? null,
    stateUrl: centralBill.stateUrl ?? null,
    providerUpdatedAt: centralBill.updatedAt,
    sponsor: primarySponsor?.name ?? null,
    sponsorParty: primarySponsor?.party ?? null,
    sponsorUrl: primarySponsor?.url ?? null,
    coSponsors: coSponsorList.length > 0 ? JSON.stringify(coSponsorList) : null,
    lastAction,
    lastActionDate,
    history: history.length > 0 ? JSON.stringify(history) : null,
    relatedBillIds: centralBill.relatedBills.length > 0 ? JSON.stringify(centralBill.relatedBills.map(r => r.identifier)) : null,
    centralSyncedAt: now,
    fullyIngestedAt: now,
    textR2Key: centralBill.textR2Key,
    textStatus: centralBill.textStatus ?? null,
    subjects: centralBill.subjects?.length ? JSON.stringify(centralBill.subjects) : null,
  }

  // Determine if AI should run
  const kwRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'keywords')).get()
  const keywords: string[] = kwRow ? JSON.parse(kwRow.value) : []
  // Empty means "match nothing", matching central: routes/tenants.ts is an
  // explicit `keywords.length > 0 ? matchesUnion(...) : false`. Treating empty as
  // match-everything here would stamp match_type='keyword' on a keyword-less tenant
  // during a forceAI re-queue, and empty keywords are now the documented default.
  const keywordMatch = keywords.length > 0
    && matchesKeywords(billMatchText({ title: centralBill.title, description: centralBill.abstract, billNumber: centralBill.number }), keywords)
  // If message carries an explicit matchType (from central), use it.
  // If not (e.g. forceAI re-queue from tenant), preserve whatever is already on the row.
  // Only derive from keyword matching for brand-new bills with no classification yet.
  // A group analysis (lib/companionAnalysis.ts) is for a bill that didn't
  // match, pulled in by its companion group: its keywords never decide its
  // match type, so it stays what it was.
  const derivedMatchType: 'keyword' | 'manual' | null =
    msg.matchType !== undefined ? msg.matchType
    : msg.groupAnalysis ? (existing?.matchType ?? null)
    : (existing?.matchType ?? (keywordMatch ? 'keyword' : null))
  // F5+B5: gate AI on canonical match_type rather than recomputed keywordMatch.
  // This fixes the case where a manually-promoted bill (match_type='manual')
  // whose match text (title, abstract, bill number) doesn't satisfy the tenant's current keywords would
  // never re-run AI on text changes, freezing its summary at promote-time.
  let shouldRunAi = msg.forceAI || msg.groupAnalysis || derivedMatchType !== null
  // A group analysis declined for want of a text hash, for the bill a lead analysis is queued for.
  const groupAnalysisNoHash = !!msg.groupAnalysis && !hasFullText && (centralBill.texts?.length ?? 0) > 0
  if (shouldRunAi && !hasFullText) {
    const textCount = centralBill.texts?.length ?? 0
    const why = textCount === 0
      ? 'central lists no texts'
      : 'central lists texts but sent no text hash (the provider may be emitting an empty text_hash)'
    console.warn(`[processor] skipping AI for ${msg.billId}: ${why} (texts=${textCount}, textHash=${centralBill.textHash ? 'present' : 'missing'}); leaving as stub`)
    shouldRunAi = false
  }
  // Demo tenants never call the model. This is the chokepoint: every route that
  // can reach AI — /admin/reprocess-bill, /admin/reprocess-llm-all,
  // /admin/promote-bill, the keyword-save re-analysis, bulk actions, and the
  // calendar backfill behind PATCH /bills/:id/priority — converges here, so one
  // guard covers them all, including routes added later.
  //
  // It has to be server-side and it has to be here. On a demo the seeded
  // `demo-user` holds role 'admin' and every anonymous visitor shares that one
  // account, so the admin AI endpoints are reachable by the public internet;
  // `reprocess-llm-all` alone queues every unanalyzed matching bill with
  // forceAI. Greying the buttons out in the UI does not close that.
  //
  // `forceAI` deliberately does NOT override this — a demo's content is whatever
  // its seed shipped, and there is no visitor action that should spend a model
  // call.
  //
  // The one exception is `operatorAi`, which only central's direct operator
  // reprocess sets (it drops the flag on any call through a tenant binding), so
  // the operator can refresh a demo's analyses and no visitor can cause it.
  if (shouldRunAi && env.DEMO_MODE === 'true' && !msg.operatorAi) {
    console.log(`[processor] demo tenant: skipping AI for ${msg.billId}`)
    shouldRunAi = false
  }

  // Dedup on the text hash: if AI already ran against this exact text, don't pay
  // for it again. `forceMetadata` is deliberately NOT part of this condition —
  // it means "refresh the provider metadata", not "re-run the model". Having it
  // here made every metadata refresh a fresh AI call: central's /reprocess sends
  // forceMetadata, and PATCH /bills/:id/priority reaches /reprocess through
  // backfillCalendar, so merely setting a priority re-analyzed the bill. That
  // also re-armed isFirstKeywordMatch on any tenant whose new_match_at had been
  // cleared, surfacing a phantom "New bill matching your keywords" event on a
  // bill the reader had just prioritized. Only forceAI forces the model.
  const aiDedup = !msg.forceAI && existing?.lastAiTextHash && existing.lastAiTextHash === centralBill.textHash

  let aiResult: ProcessBillResult | null = null
  // The document the model read, which claim sources are pinned to (#568).
  let claimSourcesPin: { docId: string; textHash: string | null } | null = null
  // The model's claim sources, each resolved against that document and the summary (#569).
  let resolvedClaimSources: ResolvedClaimSource[] | null = null
  let aiSkipReason: AiSkipReason | null = null
  // Transient failure text, recorded so a bill that failed is distinguishable
  // from one never attempted. Truncated — this is a diagnostic breadcrumb, not a log.
  let aiError: string | null = null
  if (shouldRunAi && !aiDedup) {
    const { aiContext, relevanceQuestion, taxonomy } = await loadAnalysisInputs(db)
    const { billText, billPdfBase64, hasFullText, textDocId, textHash } = await loadBillTextForAi(env, msg.billId, centralBill)
    if (!hasFullText) console.log(`[processor] No full text for ${centralBill.number}, AI ran on title+abstract only`)
    // Ask for claim sources only when they can be pinned to the document read:
    // not on the title and abstract, and not from an older central that does
    // not name the document it served.
    if (textDocId !== null && await claimLinksEnabled(db)) claimSourcesPin = { docId: textDocId, textHash }
    const claimSources = claimSourcesPin !== null

    const tier: 'flex' | 'priority' = msg.interactive ? 'priority' : 'flex'

    try {
      aiResult = await processBill(
        { billNumber: centralBill.number, title: centralBill.title, text: billText, pdfBase64: billPdfBase64, taxonomy, aiContext, relevanceQuestion, claimSources },
        env,
        tier,
      )
    } catch (err) {
      if (isGeminiShed(err)) {
        if (tier === 'priority') {
          console.warn(`[processor] priority shed for ${centralBill.number}, retrying at standard tier`)
          try {
            aiResult = await processBill(
              { billNumber: centralBill.number, title: centralBill.title, text: billText, pdfBase64: billPdfBase64, taxonomy, aiContext, relevanceQuestion, claimSources },
              env,
              'standard',
            )
          } catch (retryErr) {
            if (isGeminiShed(retryErr)) {
              const shed = shedDetail(retryErr)
              throw new AiShedError(0, shed.status, shed.detail)
            }
            aiSkipReason = classifyAiError(retryErr)
            if (aiSkipReason) {
              console.warn(`[processor] AI permanently skipped for ${centralBill.number}: ${aiSkipReason}`)
            } else {
              aiError = String(retryErr).slice(0, 300)
              console.error(`AI processing failed for ${centralBill.number}:`, retryErr)
            }
          }
        } else {
          const shed = shedDetail(err)
          throw new AiShedError(60, shed.status, shed.detail)
        }
      } else {
        aiSkipReason = classifyAiError(err)
        if (aiSkipReason) {
          console.warn(`[processor] AI permanently skipped for ${centralBill.number}: ${aiSkipReason}`)
        } else {
          aiError = String(err).slice(0, 300)
          console.error(`AI processing failed for ${centralBill.number}:`, err)
        }
      }
    }

    // Write-time taxonomy validation: the model is told to pick only from the taxonomy but
    // occasionally invents off-taxonomy tags. Hard-drop anything not in the tenant's taxonomy
    // so hallucinated tags never reach storage (the tag filter, exports, or the D1 LIKE path).
    if (aiResult) {
      const allowed = new Set(taxonomy.map(t => t.name))
      const dropped = aiResult.tags.filter(t => !allowed.has(t))
      if (dropped.length > 0) {
        console.warn(`[processor] dropped ${dropped.length} off-taxonomy tag(s) for ${centralBill.number}: ${JSON.stringify(dropped)}`)
      }
      aiResult.tags = filterTagsToTaxonomy(aiResult.tags, allowed)

      // A response cut off inside the claim sources was retried without them
      // (lib/llm.ts), which leaves a null list that looks like never asked. Count
      // it so operators can see it (#573). Extra to the analysis, so a failure
      // to count never fails it. A redelivery after a failed commit (#906) runs
      // the model again and counts again, which is accepted.
      if (aiResult.claimSourcesRetried) {
        try {
          await recordClaimSourcesCutOff(db)
        } catch (err) {
          console.error(`[processor] could not count the claim sources cut-off for ${centralBill.number}:`, err)
        }
      }

      // Resolve the claim sources here, while the document the model read is in
      // hand: a PDF has no text to match, so its quotes stay unverified.
      if (Array.isArray(aiResult.claimSources) && claimSourcesPin !== null) {
        try {
          const resolved = resolveClaimSources(aiResult.claimSources, aiResult.summary, billPdfBase64 === undefined ? billText : null)
          resolvedClaimSources = resolved.items
          if (resolved.dropped > 0) {
            console.warn(`[processor] dropped ${resolved.dropped} claim source(s) for ${centralBill.number} whose claim is not in the summary`)
          }
          if (resolved.capped > 0 || resolved.unsearched > 0) {
            console.warn(`[processor] ${resolved.capped} claim source(s) past the limit and ${resolved.unsearched} fuzzy search(es) past the work budget left ungrounded for ${centralBill.number}`)
          }
        } catch (err) {
          // Extra to the analysis, so it never fails it: the summary, tags, and
          // score are the contract.
          console.error(`[processor] could not resolve claim sources for ${centralBill.number}:`, err)
          resolvedClaimSources = []
        }
      }
    }
  }

  const aiTextDocId = pickLatestTextDocId(centralBill)
  const leadCaughtUp = !!msg.groupAnalysis && (existing?.aiProcessedAt != null || existing?.aiSkipReason != null)
    && ((shouldRunAi && !!aiDedup) || groupAnalysisNoHash)
  const queueChanges = msg.changes ?? []

  // New-match signal: the first time a bill becomes an analyzed KEYWORD match
  // (manual adds are excluded — the adding admin already knows). Set once; later
  // re-analysis / status changes / keyword-resync re-promotes won't re-surface it.
  //
  // A bill analyzed before it matched (a companion pulled in through its group) matches with no new
  // analysis when its text hasn't changed, so the model doesn't run again. It is still the first
  // time it matches, unless it matched before: the feed event is written once per bill, and a
  // dismissed match that lost its keywords and regained them is not news twice.
  const priorMatchEvent = !aiResult && derivedMatchType === 'keyword' && !existing?.newMatchAt && existing?.matchType === null && existing.aiProcessedAt != null
    ? !!(await db.select({ id: feedEvents.id }).from(feedEvents).where(and(eq(feedEvents.billId, existing.id), eq(feedEvents.type, 'bill_matched'))).get())
    : null
  // An operator's analysis of a demo refreshes content; it is not news, so it never marks a bill new.
  const isFirstKeywordMatch = derivedMatchType === 'keyword' && !existing?.newMatchAt && !msg.operatorAi
    && (!!aiResult || priorMatchEvent === false)

  // Where the match came from, as central declared it. The declaration rides
  // only on the message that brings the match, which may arrive before the
  // bill has text to analyse, so it is kept on the bill until the match is
  // recorded and goes on the bill_matched event from there. Once the match
  // is recorded it never changes. With no declaration it stays NULL: bulk.
  // A group analysis is for a bill that didn't match (lib/companionAnalysis.ts)
  // and brings no match, so any declaration on it is ignored: it would
  // otherwise be kept until the bill matched on its own, and be taken for that
  // match's provenance.
  const declaredProvenance = !existing?.newMatchAt && !msg.groupAnalysis && msg.matchProvenance ? msg.matchProvenance : undefined
  const matchProvenance = declaredProvenance ?? existing?.matchProvenance ?? null

  const upsertData = {
    ...billData,
    matchType: derivedMatchType,
    ...(declaredProvenance ? { matchProvenance: declaredProvenance } : {}),
    ...(aiResult ? {
      aiProcessedAt: now,
      lastAiTextHash: centralBill.textHash ?? null,
      lastAiTextDocId: aiTextDocId,
      tenantSummary: aiResult.summary,
      tags: JSON.stringify(aiResult.tags),
      relevanceScore: aiResult.relevanceScore,
      // Stored but not yet surfaced anywhere: this is the first pass at a parsed
      // layer over bill text, kept verbatim so a later consumer can decide what
      // structure it needs.
      affectedCitations: JSON.stringify(aiResult.affectedCitations),
      // Every analysis writes all three, so a re-analysis replaces the list,
      // and one that did not ask clears it: a list never outlives its summary.
      // Not yet surfaced anywhere.
      ...(resolvedClaimSources !== null && claimSourcesPin !== null ? {
        claimSources: JSON.stringify(resolvedClaimSources),
        claimSourcesDocId: claimSourcesPin.docId,
        claimSourcesTextHash: claimSourcesPin.textHash,
      } : { claimSources: null, claimSourcesDocId: null, claimSourcesTextHash: null }),
      // Clear any prior permanent skip — AI ran successfully on this text version.
      aiSkipReason: null,
      // …and any prior transient failure, for the same reason.
      aiAttemptedAt: null,
      aiError: null,
      // …and any heal attempts. A bill that recovers starts clean, so a failure
      // months from now is not poisoned by an old, unrelated outage.
      aiHealAttempts: 0,
    } : aiSkipReason ? {
      // Permanent AI failure on this text. Recording lastAiTextHash here serves the
      // same dedup role as on success: if the text actually changes later, AI re-runs.
      lastAiTextHash: centralBill.textHash ?? null,
      lastAiTextDocId: aiTextDocId,
      aiSkipReason,
      aiAttemptedAt: now,
      aiError: null,
    } : aiError ? {
      // Transient failure: deliberately does NOT record lastAiTextHash, so the
      // next pass retries rather than deduping itself into permanent silence.
      aiAttemptedAt: now,
      aiError,
    } : leadCaughtUp ? {
      // A group analysis of an analyzed (or skipped) bill, queued because its
      // newest text isn't the one its analysis read (lib/companionAnalysis.ts),
      // that ran no model: the text hash says the analysis already read this
      // text, or central sent no hash to analyze by. Record the newest text as
      // read and release the claim, or the bill stays stale and is queued
      // again once a floor, forever. Claim sources stay pinned to their own
      // document.
      lastAiTextDocId: aiTextDocId,
      aiAttemptedAt: null,
      aiHealAttempts: 0,
    } : msg.forceAI && !shouldRunAi ? {
      // A forceAI pass that declined to run AI — no full text in central, or a
      // demo tenant. It produced no result, no skip reason and no error, so
      // without this branch the row keeps whatever ai_attempted_at it already had.
      //
      // That matters because healStalledAiBills() selects on
      // `ai_attempted_at < now - HEAL_MIN_AGE_MS`, and a stub with no text is
      // exactly the population it targets. Leaving the timestamp stale means the
      // heal re-selects the same bill on the very next hourly run: all five
      // attempts burn in five consecutive hours with none of the spacing the
      // floor exists to provide, and the bill is then capped out forever.
      //
      // A pass that declined is still an attempt. Stamping it is what lets the
      // selection predicate observe the attempt and space the next one.
      //
      // Deliberately scoped to msg.forceAI: an ordinary metadata-only or
      // stub-only pass was never trying to run AI, and stamping ai_attempted_at
      // there would invent an attempt that never happened — making bills that
      // have simply never been analyzed look stalled.
      aiAttemptedAt: now,
    } : {}),
    ...(isFirstKeywordMatch ? { newMatchAt: now } : {}),
    ...(queueChanges.length > 0 ? { updatedAt: now } : {}),
  }

  // The bill version is one commit (#906): the bill row, stamped with central's version, its subjects,
  // committees, and texts, and its feed events go in one batch, which D1 runs as one transaction. The stamp is
  // what the early skip above reads, so it lands only with everything else: a delivery that fails anywhere
  // before the commit leaves the bill as it was, and its redelivery decides everything again from the same row,
  // running the model again if it ran (its result went down with the batch). Apart, a write that failed after
  // the bill's upsert left the rest of the version missing, and the redelivery was skipped as unchanged.
  //
  // Nothing before the batch writes (bar a cut-off count, above), and what runs after it (the calendar here,
  // and the companion and title-key syncs in processCentralNotification) runs on the skip path too, so a
  // redelivery after the commit still does it.
  const isNew = !existing
  const { id: billInternalId, statement: billStatement } = await billWrite(db, msg.billId, upsertData, existing?.id)

  // Feed events: only for tracked bills (keyword or manual) and members of a companion group (a companion pulled
  // in through its group has no match type, and its actions belong in the group's card, #381) with AI data and
  // detected changes from central.
  // F5+B5: switched gate from `!existing.isStub` to `existing.matchType !== null` (canonical field).
  const writeUpdate = !isNew && !!existing?.aiProcessedAt && (existing.matchType !== null || existing.groupKey !== null) && queueChanges.length > 0

  // New keyword-match feed event: passive, system actor, written once per bill. On an
  // unprioritized bill it shows nowhere on the feed: a routine match is covered by the
  // day's new-matches row, and a bulk match writes no row, so its event waits
  // unseen. Once someone prioritizes the bill, its card (and the nav dot) takes the
  // event, since the feed admits passive events on prioritized bills (see feed.ts /
  // PASSIVE_EVENT_TYPES).
  // The write-once checks (here, at `priorMatchEvent`, and in the insert itself) read it too.
  //
  // Write-once is enforced against the feed_events table itself, not against
  // `new_match_at`. That column is a *worklist* flag and things legitimately clear it
  // — the demo reset nulls it on every bill so a six-hourly reset doesn't present
  // months-old content as newly matched. When a cleared row is then reprocessed with a
  // fresh AI result (an operator's re-run, or central's own redelivery; a visitor's
  // priority change doesn't, since backfillCalendar skips on a demo), isFirstKeywordMatch
  // goes true a second time and a duplicate
  // "New bill matching your keywords" event surfaces, timestamped now, on a bill that
  // by then has a priority — so it lands in the default feed and lights the nav dot.
  const recordMatch = isFirstKeywordMatch && !(existing && await db.select({ id: feedEvents.id })
    .from(feedEvents)
    .where(and(eq(feedEvents.billId, existing.id), eq(feedEvents.type, 'bill_matched')))
    .get())

  // With the day's no-priority updates row, which stands for this update while the bill has no priority: at one
  // time, so the two share a day. The time is read now, not at the message's start (`now`, before the AI call):
  // a digest or a seen mark between the two would otherwise sit after an update dated before it, and miss it.
  const writtenAt = nowDb()
  const statements: BatchItem<'sqlite'>[] = [
    // The version check again, inside the commit, for a version another delivery stored while this one ran
    // (the model takes seconds). It fails the whole batch, so nothing of this older copy lands: not the
    // bill's fields or stamp, nor its child rows or events, which a WHERE on the bill's write alone would
    // let through. A bill the delivery didn't find needs none: its insert fails if another delivery made it.
    ...(existing ? [staleVersionGuard(db, existing.id, centralBill.updatedAt)] : []),
    // Then the bill, so the rows below have it, and the row checks below read it as written.
    billStatement,
    ...billSubjectStatements(db, billInternalId, centralBill.state, centralBill.subjects ?? []),
    ...billCommitteeStatements(db, billInternalId, centralBill.state, centralBill.committee, centralBill.referrals),
    ...billTextStatements(db, billInternalId, centralBill.texts, fetchedAt, now),
  ]
  if (writeUpdate) {
    statements.push(
      db.insert(feedEvents).values({
        id:        crypto.randomUUID(),
        type:      'bill_updated',
        billId:    billInternalId,
        userId:    'system',
        metadata:  JSON.stringify({ changes: queueChanges }),
        createdAt: writtenAt,
      }),
      noteLegislativeEvent(db, billInternalId, writtenAt),
    )
  }
  if (recordMatch) {
    statements.push(
      // Columns in feed_events' order: id, type, bill_id, user_id, metadata, suppressed, created_at. The NOT
      // EXISTS keeps it once per bill when two deliveries of the bill commit at the same time.
      db.insert(feedEvents).select(sql`
        SELECT ${crypto.randomUUID()}, 'bill_matched', ${billInternalId}, 'system', ${JSON.stringify(matchProvenance ? { matchProvenance } : {})}, 0, datetime('now')
         WHERE NOT EXISTS (SELECT 1 FROM feed_events WHERE bill_id = ${billInternalId} AND type = 'bill_matched')
      `),
      // The feed's one row for the day's routine new matches. Judged by the same
      // definition as the digest and the triage list, on the match just recorded.
      newMatchesRowStatement(db, billInternalId, await getNewMatchMinRelevance(db)),
    )
  }
  try {
    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  } catch (err) {
    // The guard's failure, or the insert's when another delivery created the bill: either way the
    // batch left nothing. Only a newer stored version makes it stale; any other failure is retried.
    const stored = await db.select({ id: bills.id, newer: storedIsNewer(centralBill.updatedAt) })
      .from(bills).where(eq(bills.externalId, await resolveStoredHandle(db, msg.billId))).get()
    if (!stored?.newer) throw err
    console.log(`[processor] skipping ${msg.billId}: a version newer than ${centralBill.updatedAt} was stored during this delivery`)
    await recordStaleDelivery(db, env, msg, stored.id, !isNew)
    return 'stale'
  }

  // Mirror hearings for tracked bills and group members (priority filtering happens at read time, by the group's priority).
  if (msg.calendar && (derivedMatchType !== null || existing?.priority != null || existing?.groupKey != null)) {
    await reconcileCalendar(db, env, billInternalId, msg, isNew, now)
  }
}

/**
 * A statement for the full path's commit batch that fails, failing the batch,
 * when the bill's stored version is newer than `incoming`. SQLite has no RAISE
 * outside a trigger, so it asks json() to parse text that isn't JSON. The text
 * depends on the row, so SQLite can't evaluate it ahead of the CASE.
 */
function staleVersionGuard(db: AppDb, billId: string, incoming: string) {
  return db.select({ guard: sql`json(CASE WHEN ${storedIsNewer(incoming)} THEN 'stale: a newer version is stored' ELSE '0' END)` })
    .from(bills).where(eq(bills.id, billId))
}

/**
 * What a full delivery found stale still records: the message's own changes.
 * Central sends each sync's changes (its `changes` and calendar `changes` are
 * what that pull found against the one before), so the newer delivery's
 * message doesn't carry these, and they would otherwise never reach the Feed.
 * They are written as the full path would write them, gated on the bill as
 * stored now, and in one batch, so they land once or not at all. Nothing of
 * the older copy itself is written: not the bill's fields, its child rows, or
 * its calendar rows, which the newer delivery reconciled.
 *
 * Also the match provenance central declared on this message, when the bill
 * holds none and hasn't recorded its match: the declaration rides only on the
 * message that brings the match, so this may be its only copy. Once a match
 * is recorded its provenance never changes, so a bill whose newer delivery
 * recorded the match first keeps what that delivery wrote.
 *
 * `existed`: the bill was stored when the delivery began. Changes to a bill
 * new to the delivery are not news, as on the full path.
 */
async function recordStaleDelivery(db: AppDb, env: Env, msg: TenantQueueMessage, billId: string, existed: boolean): Promise<void> {
  const statements: BatchItem<'sqlite'>[] = []
  if (!msg.groupAnalysis && msg.matchProvenance) {
    statements.push(db.update(bills).set({ matchProvenance: msg.matchProvenance })
      .where(and(eq(bills.id, billId), isNull(bills.matchProvenance), isNull(bills.newMatchAt))))
  }
  const row = existed
    ? await db.select({ aiProcessedAt: bills.aiProcessedAt, matchType: bills.matchType, groupKey: bills.groupKey, priority: bills.priority })
      .from(bills).where(eq(bills.id, billId)).get()
    : undefined
  const writtenAt = nowDb()
  const changes = msg.changes ?? []
  // The full path's bill_updated gate.
  if (row?.aiProcessedAt && (row.matchType !== null || row.groupKey !== null) && changes.length > 0) {
    statements.push(
      db.insert(feedEvents).values({
        id: crypto.randomUUID(), type: 'bill_updated', billId, userId: 'system',
        metadata: JSON.stringify({ changes }), createdAt: writtenAt,
      }),
      noteLegislativeEvent(db, billId, writtenAt),
    )
  }
  // reconcileCalendar's feed events, under its gates: a tracked bill or group member, never a demo, never a deadline.
  if (row && msg.calendar && env.DEMO_MODE !== 'true'
    && (row.matchType !== null || !!msg.matchType || row.priority != null || row.groupKey != null)) {
    for (const ch of msg.calendar.changes) {
      if (ch.kind === 'deadline') continue
      statements.push(
        db.insert(feedEvents).values({
          id: crypto.randomUUID(), type: ch.changeType, billId, userId: 'system',
          metadata: JSON.stringify({ date: ch.date, time: ch.time, location: ch.location, description: ch.description }),
          createdAt: writtenAt,
        }),
        noteLegislativeEvent(db, billId, writtenAt),
      )
    }
  }
  if (statements.length > 0) await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
}

async function reconcileCalendar(
  db: AppDb,
  env: Env,
  billInternalId: string,
  msg: TenantQueueMessage,
  isNew: boolean,
  now: string,
): Promise<void> {
  const block = msg.calendar
  if (!block) return

  // A demo's hearings come only from its seed (disclosed fiction that central's
  // calendar never lists), and the reset re-derives them. Reconciling against
  // central cancels every one of them and rewrites any it does match, so a
  // delivery leaves a demo's calendar alone (#884).
  if (env.DEMO_MODE === 'true') return

  const incomingUids = new Set<string>()
  const changedUids = new Set<string>()

  // Upsert current events. The ICS SEQUENCE only ever rises: it bumps when an
  // event's date, time, location, description, or kind changes and when a
  // cancelled event comes back, so calendar clients take the newer copy. A new
  // event_hash alone is stored but is no change a member can see.
  for (const e of block.events) {
    const uid = hearingUid(msg.billId, e.identityKey, msg.tenantId)
    incomingUids.add(uid)
    const existing = await db.select({ id: calendarEvents.id, sequence: calendarEvents.sequence, eventHash: calendarEvents.eventHash, status: calendarEvents.status,
      date: calendarEvents.date, time: calendarEvents.time, location: calendarEvents.location,
      description: calendarEvents.description, kind: calendarEvents.kind })
      .from(calendarEvents).where(eq(calendarEvents.uid, uid)).get()

    // The body event shown in the entry's place (lib/bodyEvents.ts). A central
    // that sends no cover leaves the stored one alone.
    const cover = 'coveredBy' in e ? { coveredBy: e.coveredBy ?? null } : {}
    if (!existing) {
      await db.insert(calendarEvents).values({
        id: crypto.randomUUID(), uid, billId: billInternalId, source: 'hearing', kind: e.kind ?? null, sequence: 0,
        date: e.date, time: e.time, location: e.location, description: e.description,
        status: 'confirmed', eventHash: e.eventHash, createdAt: now, updatedAt: now, ...cover,
      })
      changedUids.add(uid)
    } else {
      const visibleChanged = (['date', 'time', 'location', 'description'] as const).some(k => (existing[k] ?? '') !== (e[k] ?? ''))
        // A stored kind of null predates kinds, so filling it in is no change.
        || (!!e.kind && !!existing.kind && existing.kind !== e.kind)
      const reconfirmed = existing.status === 'cancelled'
      const bump = visibleChanged || reconfirmed
      await db.update(calendarEvents).set({
        billId: billInternalId, status: 'confirmed', ...(e.kind ? { kind: e.kind } : {}), ...cover,
        date: e.date, time: e.time, location: e.location, description: e.description,
        eventHash: e.eventHash, sequence: bump ? existing.sequence + 1 : existing.sequence, updatedAt: now,
      }).where(eq(calendarEvents.uid, uid))
      if (bump) {
        changedUids.add(uid)
        console.log('[calendar-reconcile] sequence bump', JSON.stringify({
          billId: msg.billId, tenantId: msg.tenantId, uid, reconfirmed,
          oldHash: existing.eventHash, newHash: e.eventHash ?? null,
        }))
      }
    }
  }

  // Cancel rows for this bill (hearing source only) no longer present (bump sequence so iCal SEQUENCE advances).
  const existingRows = await db.select({ uid: calendarEvents.uid, sequence: calendarEvents.sequence, status: calendarEvents.status })
    .from(calendarEvents).where(and(eq(calendarEvents.billId, billInternalId), eq(calendarEvents.source, 'hearing'))).all()
  for (const row of existingRows) {
    if (!incomingUids.has(row.uid) && row.status !== 'cancelled') {
      await db.update(calendarEvents).set({ status: 'cancelled', sequence: row.sequence + 1, updatedAt: now })
        .where(eq(calendarEvents.uid, row.uid))
      changedUids.add(row.uid)
    }
  }

  // Feed events for the diff — only for existing (non-new) bills, mirroring the
  // bill_updated feed gate. The bill's tracked status is already checked by the caller.
  // Only emit a feed event when the uid actually changed state this pass (idempotent
  // on queue re-delivery: a re-delivered identical message leaves changedUids empty).
  if (!isNew) {
    for (const ch of block.changes) {
      // A deadline isn't a hearing: the calendar shows it, and the feed doesn't announce it as one.
      if (ch.kind === 'deadline') continue
      const uid = hearingUid(msg.billId, ch.identityKey, msg.tenantId)
      if (!changedUids.has(uid)) continue
      console.log('[calendar-reconcile] feed event', JSON.stringify({
        billId: msg.billId, tenantId: msg.tenantId, uid, changeType: ch.changeType,
      }))
      // With the day's no-priority updates row, in one batch at one time read just now (as for
      // bill_updated above, and for the same reason: never the message's start).
      const writtenAt = nowDb()
      await db.batch([
        db.insert(feedEvents).values({
          id: crypto.randomUUID(),
          type: ch.changeType,
          billId: billInternalId,
          userId: 'system',
          metadata: JSON.stringify({ date: ch.date, time: ch.time, location: ch.location, description: ch.description }),
          createdAt: writtenAt,
        }),
        noteLegislativeEvent(db, billInternalId, writtenAt),
      ])
    }
  }
}

function resolveSessionLabel(sessionId: string | null | undefined): string {
  if (!sessionId) return ''
  // synthesized seed sessions: "seed:RI:2026" → "2026"
  if (sessionId.startsWith('seed:')) return sessionId.split(':').pop() ?? sessionId
  // Legacy "ri:2026"-style session ids (from the removed OpenStates central), kept for older data and tests
  if (/^[a-z]{2}:\d{4}/.test(sessionId)) return sessionId.split(':').pop() ?? sessionId
  return sessionId
}

/**
 * Store the bill's texts as central lists them: upsert each, and drop one it
 * no longer lists unless another run stored it from a newer copy than this
 * one. Central never drops a text except when a cutover moves the bill to
 * another provider, which clears the old provider's, and a text it no longer
 * lists would only fail to open.
 */
async function syncBillTexts(db: AppDb, billId: string, texts: CentralBill['texts'], fetchedAt: string, now: string): Promise<void> {
  await db.batch(billTextStatements(db, billId, texts, fetchedAt, now))
}

/**
 * syncBillTexts' statements, for a batch: the delete, then an upsert for each
 * text. The two touch different documents (the delete only those central no
 * longer lists), so their order doesn't matter. Each carries the text's links
 * and hash, never its content, which central keeps in R2.
 */
function billTextStatements(db: AppDb, billId: string, texts: CentralBill['texts'], fetchedAt: string, now: string) {
  const upserts = texts.map(t => {
    const link = t.links[0] ?? null
    const altLink = t.links[1] ?? null
    // '' when central sent none: an older central, or a document it has no hash for.
    const textHash = typeof t.textHash === 'string' ? t.textHash : ''
    return db.insert(billTexts).values({
      id: crypto.randomUUID(),
      billId,
      docId: t.docId,
      type: t.note,
      date: t.date,
      mime: link?.mediaType ?? 'text/html',
      textHash,
      stateLink: link?.url ?? null,
      altStateLink: altLink?.url ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: billTexts.docId,
      // An empty hash never replaces a known one: it means central sent none, not that the text changed.
      set: { type: t.note, date: t.date, mime: link?.mediaType ?? 'text/html', textHash: sql`CASE WHEN ${textHash} = '' THEN ${billTexts.textHash} ELSE ${textHash} END`, stateLink: link?.url ?? null, altStateLink: altLink?.url ?? null, updatedAt: now },
    })
  })
  return [db.delete(billTexts).where(and(
    eq(billTexts.billId, billId),
    sql`${billTexts.docId} NOT IN (SELECT value FROM json_each(${JSON.stringify(texts.map(t => t.docId))}))`,
    lt(billTexts.updatedAt, fetchedAt),
  )), ...upserts] as const
}

/**
 * A stub or metadata-only delivery of a bill in a companion group stores its
 * texts too. Central sends a bill that didn't match only stubs when it
 * changes, and a group's lead and a pulled lead's staleness are read from
 * the instance's texts (lib/groupLead.ts, lib/companionAnalysis.ts). Only a
 * grouped bill, after this delivery's regrouping, and only when central lists
 * texts, so a stub never clears a bill's texts. It runs after the stub and
 * metadata paths, whose provider-version handling it leaves alone.
 */
async function syncGroupedBillTexts(db: AppDb, externalId: string, centralBill: CentralBill, fetchedAt: string): Promise<void> {
  const texts = centralBill.texts ?? []
  if (texts.length === 0) return
  const row = await db.select({ id: bills.id, groupKey: bills.groupKey }).from(bills).where(eq(bills.externalId, externalId)).get()
  if (!row || row.groupKey === null) return
  await syncBillTexts(db, row.id, texts, fetchedAt, nowDb())
}

/** Upsert a bill from central. */
async function upsertBill(
  db: AppDb,
  externalId: string,
  data: Record<string, unknown>,
): Promise<{ id: string; isNew: boolean }> {
  data = await storedSpelling(db, externalId, data)
  const id = crypto.randomUUID()
  const returned = await billUpsert(db, id, data, nowDb()).returning({ id: bills.id }).get()
  return { id: returned.id, isNew: returned.id === id }
}

/**
 * The full path's write of the bill, as a statement for its commit batch (#906), and the id the bill's other
 * rows in that batch go under. A bill the delivery found (`existingId`) is upserted under its id. One it didn't
 * find is inserted, never upserted: if another delivery created it meanwhile, the insert fails on the handle and
 * takes the batch with it, so no row is written under an id no bill has, and the redelivery finds the bill.
 */
async function billWrite(
  db: AppDb,
  externalId: string,
  data: Record<string, unknown>,
  existingId: string | undefined,
): Promise<{ id: string; statement: BatchItem<'sqlite'> }> {
  data = await storedSpelling(db, externalId, data)
  const now = nowDb()
  if (existingId !== undefined) return { id: existingId, statement: billUpsert(db, existingId, data, now) }
  const id = crypto.randomUUID()
  return { id, statement: db.insert(bills).values({ id, ...data as any, createdAt: now, updatedAt: now }) }
}

/**
 * The bill's data under its handle as stored, resolved again just before writing: release 2's migration can
 * rename the row after the delivery began, and the write's conflict target is the spelling, so a stale one
 * would insert a second row for the bill (#305).
 */
async function storedSpelling(
  db: AppDb,
  externalId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const stored = await resolveStoredHandle(db, externalId)
  return stored === externalId ? data : { ...data, externalId: stored }
}

/** Insert the bill under `id`, or update the row its handle names. */
function billUpsert(db: AppDb, id: string, data: Record<string, unknown>, now: string) {
  // Exclude externalId from the update set (it's the conflict target) and handle matchType separately
  // to preserve matchType='manual' for manually-added bills.
  const { externalId: _ext, matchType: _mt, ...updateFields } = data as any
  return db.insert(bills)
    .values({ id, ...data as any, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: bills.externalId,
      set: {
        ...updateFields,
        matchType: sql`CASE WHEN ${bills.matchType} = 'manual' THEN 'manual' WHEN excluded.match_type IS NOT NULL THEN excluded.match_type ELSE ${bills.matchType} END`,
        // Central never changes a session slug once assigned, so a null (an
        // older central, or a session it hasn't slugged yet) keeps the stored one.
        sessionSlug: sql`COALESCE(excluded.session_slug, ${bills.sessionSlug})`,
        updatedAt: (updateFields as any).updatedAt ?? sql`updated_at`,
      },
    })
}
