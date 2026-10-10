import { eq, and, isNull, sql } from 'drizzle-orm'
import { DEFAULT_PROVIDER_ID, getProvider, type CentralMeasure, type MeasureRef, type Provider } from '../providers'
import {
  bills, billHistory, billSponsors, billTexts, billSupplements, billAmendments,
  billSasts, billSubjects, billReferrals, billCalendar, billTenants,
  billChangeLog, rollCalls, people, tenants, sessions, providerRecords,
} from '../db/schema'
import { detectChanges, detectCalendarChanges, calendarIdentityKey, type BillSnapshot, type ChangeRecord, type CalendarChange, type PriorCalendarRow } from '../lib/detect-changes'
import type { Env, Db, IngestorMessage, BillMessage, NotificationMessage, CalendarBlock } from '../types'
import { personRow } from '../lib/people'
import { writeMemberVotes, type RollCallMemberVotes } from '../lib/rollCallVotes'
import { loadVoteDataset, VOTE_DATASET_DEFER_SECONDS, VOTE_DATASET_RETRY_SECONDS } from '../cron/vote-datasets'
import { nowDb } from '../lib/dbTime'
import { providerContext } from '../lib/providerContext'
import { deliverToTenant } from '../lib/tenantDelivery'
import { safeFetch } from '../lib/safeFetch'
import { toHandle } from '../lib/billHandle'
import { replaceBillExtras } from '../lib/billExtras'
import { httpUrl } from '../../../shared/httpUrl'

export async function processIngestorQueue(
  batch: MessageBatch<IngestorMessage>,
  env: Env,
  db: Db,
): Promise<void> {
  // At most one vote-dataset load per invocation: each can spend a large share
  // of the invocation's D1 query budget, so further loads in the batch are
  // re-sent with a delay rather than run here. Re-sending (not retry()) keeps
  // them from using up their retry budget.
  let datasetLoaded = false
  for (const message of batch.messages) {
    const body = message.body
    if (body.kind === 'vote-dataset') {
      try {
        if (datasetLoaded) {
          await env.INGESTOR_QUEUE.send(body, { delaySeconds: VOTE_DATASET_DEFER_SECONDS })
        } else {
          datasetLoaded = true
          await loadVoteDataset(body, env, db)
        }
        message.ack()
      } catch (err) {
        console.error('[processor-ls] vote dataset load failed for session', body.sessionId, err)
        // Each attempt re-downloads the archive, so give the provider time first.
        message.retry({ delaySeconds: VOTE_DATASET_RETRY_SECONDS })
      }
      continue
    }
    try {
      await processBill(body, env, db)
      message.ack()
    } catch (err) {
      console.error('[processor-ls] failed for billId', body.billId, err)
      message.retry()
    }
  }
}

async function processBill(msg: BillMessage, env: Env, db: Db): Promise<void> {
  const forceMetadata = msg.forceMetadata ?? false
  const forceAI = msg.forceAI ?? false
  const interactive = msg.interactive ?? false
  // The provider that wrote the bill, by its row's `provider` column, and its
  // session, in one read. A bill central has no row for is the default's.
  const known = await db.select({ provider: bills.provider, sessionId: bills.sessionId })
    .from(bills).where(eq(bills.billId, msg.billId)).get()
  const provider = getProvider(known?.provider ?? DEFAULT_PROVIDER_ID)

  if (msg.skipFetch) {
    // Data already in DB from bulk seed — skip the provider's API, just download text and notify
    const textsToDownload = await db.select({
      docId: billTexts.docId,
      stateLink: billTexts.stateLink,
      mime: billTexts.mime,
      textSize: billTexts.textSize,
      textHash: billTexts.textHash,
    })
      .from(billTexts)
      .where(and(
        eq(billTexts.billId, msg.billId),
        msg.forceTextRefetch ? undefined : isNull(billTexts.r2Key),
      ))
      .all()

    for (const t of textsToDownload) {
      if (t.stateLink) {
        await downloadTextToR2(msg.billId, t.docId, t.stateLink, t.mime ?? 'text/html', provider, env, db, t.textSize, t.textHash)
      }
    }

    await notifyTenants(msg.billId, env, db, nowDb(), forceMetadata, forceAI, [], undefined, interactive)
    return
  }

  const measure = await fetchMeasure(msg.billId, known?.sessionId ?? null, provider, env, db)
  await ingestMeasure(measure, provider, env, db, {
    forceMetadata, forceAI, interactive,
    forceTextRefetch: msg.forceTextRefetch ?? false,
  })
}

/**
 * Fetch one bill's full record from its provider. A snapshot provider gets the
 * record core stored for the bill, and the bill's session. When the provider
 * also fetched a details response, store it beside the record, and when, for
 * its details refresh.
 */
async function fetchMeasure(billId: number, sessionId: number | null, provider: Provider, env: Env, db: Db): Promise<CentralMeasure> {
  let ref: MeasureRef
  if (provider.snapshot) {
    const row = await db.select().from(providerRecords)
      .where(and(eq(providerRecords.billId, billId), eq(providerRecords.provider, provider.id))).get()
    if (!row) throw new Error(`bill ${billId} has no stored ${provider.id} record; the ${provider.id} sync has not seen it`)
    const s = await db.select().from(sessions).where(eq(sessions.sessionId, row.sessionId)).get()
    ref = {
      billId,
      sessionId: row.sessionId,
      nativeKey: row.nativeKey,
      record: { raw: JSON.parse(row.rawJson), hash: row.rawHash },
      session: s ? {
        sessionId: s.sessionId, state: s.state, sessionTag: s.sessionTag,
        yearStart: s.yearStart, yearEnd: s.yearEnd, sessionName: s.sessionName, prior: s.prior,
      } : undefined,
    }
  } else {
    ref = { billId, sessionId }
  }

  const fetched = await provider.fetchMeasure(ref, providerContext(provider, env, db))
  if (!('measure' in fetched)) return fetched
  // The whole response, so a field the mapping ignores today can be read later
  // without fetching it again. raw_hash is left alone: it is the listed
  // record's, which the snapshot sync compares.
  await db.update(providerRecords).set({
    detailsJson: fetched.details == null ? null : JSON.stringify(fetched.details),
    detailsFetchedAt: nowDb(),
  }).where(eq(providerRecords.billId, billId))
  return fetched.measure
}

export type IngestOptions = {
  forceMetadata: boolean
  forceAI: boolean
  interactive: boolean
  /** Re-download every text even when R2 already has it (admin refetch-fragment-texts). */
  forceTextRefetch?: boolean
}

/**
 * Write one measure into central: change detection, the bill row and its child
 * tables, text downloads to R2, and the tenant notifications. Provider-neutral:
 * the caller fetches the measure from its provider and hands it here, and new
 * rows record that provider.
 */
export async function ingestMeasure(
  bill: CentralMeasure,
  provider: Provider,
  env: Env,
  db: Db,
  opts: IngestOptions,
): Promise<void> {
  const { forceMetadata, forceAI, interactive, forceTextRefetch } = opts
  const now = nowDb()

  // --- Change detection ---
  // Read existing bill to check change_hash and build before-snapshot
  const existingBillRow = await db
    .select({ changeHash: bills.changeHash, status: bills.status, title: bills.title, description: bills.description })
    .from(bills)
    .where(eq(bills.billId, bill.bill_id))
    .get()

  let detectedChanges: ChangeRecord[] = []
  let calendarChanges: CalendarChange[] = []

  if (existingBillRow) {
    // Read before-snapshot from child tables
    const [historyRows, textRows, supplementRows, amendmentRows, voteRows, sponsorRows, priorCalRows] = await Promise.all([
      db.select({ seq: billHistory.seq }).from(billHistory).where(eq(billHistory.billId, bill.bill_id)).all(),
      db.select({ docId: billTexts.docId }).from(billTexts).where(eq(billTexts.billId, bill.bill_id)).all(),
      db.select({ supplementId: billSupplements.supplementId }).from(billSupplements).where(eq(billSupplements.billId, bill.bill_id)).all(),
      db.select({ amendmentId: billAmendments.amendmentId }).from(billAmendments).where(eq(billAmendments.billId, bill.bill_id)).all(),
      db.select({ rollCallId: rollCalls.rollCallId }).from(rollCalls).where(eq(rollCalls.billId, bill.bill_id)).all(),
      db.select({ peopleId: billSponsors.peopleId, name: people.name, party: people.party })
        .from(billSponsors)
        .leftJoin(people, eq(billSponsors.peopleId, people.peopleId))
        .where(eq(billSponsors.billId, bill.bill_id))
        .all(),
      db.select({ typeId: billCalendar.typeId, description: billCalendar.description, date: billCalendar.date, time: billCalendar.time, location: billCalendar.location, eventHash: billCalendar.eventHash })
        .from(billCalendar).where(eq(billCalendar.billId, bill.bill_id)).all(),
    ])

    const sponsorKeys = new Set<string>()
    const sponsorDetailByKey = new Map<string, string>()
    for (const s of sponsorRows) {
      const key = s.peopleId ? `p${s.peopleId}` : `n${s.name ?? ''}`
      sponsorKeys.add(key)
      if (s.name) sponsorDetailByKey.set(key, s.party ? `${s.name} (${s.party})` : s.name)
    }

    const snapshot: BillSnapshot = {
      status: existingBillRow.status,
      title: existingBillRow.title ?? '',
      description: existingBillRow.description,
      latestHistoryCount: historyRows.length,
      textDocIds: new Set(textRows.map(t => t.docId)),
      supplementIds: new Set(supplementRows.map(s => s.supplementId)),
      amendmentIds: new Set(amendmentRows.map(a => a.amendmentId)),
      voteIds: new Set(voteRows.map(v => v.rollCallId)),
      sponsorKeys,
      sponsorDetailByKey,
    }

    detectedChanges = detectChanges(snapshot, bill, provider)

    // Write change records
    if (detectedChanges.length > 0) {
      for (const change of detectedChanges) {
        await db.insert(billChangeLog).values({
          id:         crypto.randomUUID(),
          billId:     bill.bill_id,
          changeType: change.changeType,
          oldValue:   change.oldValue ?? null,
          newValue:   change.newValue ?? null,
          detail:     change.detail ?? null,
          detectedAt: now,
        })
      }
    }

    const priorCalendar: PriorCalendarRow[] = priorCalRows.map(r => ({
      identityKey: calendarIdentityKey({ type_id: r.typeId, description: r.description, date: r.date }),
      eventHash: r.eventHash,
      date: r.date,
      description: r.description,
      time: r.time,
      location: r.location,
    }))
    calendarChanges = detectCalendarChanges(priorCalendar, bill.calendar ?? [], now.slice(0, 10))

    if (calendarChanges.length > 0) {
      for (const change of calendarChanges) {
        await db.insert(billChangeLog).values({
          id: crypto.randomUUID(),
          billId: bill.bill_id,
          changeType: change.changeType,
          oldValue: null,
          newValue: change.description ?? null,
          detail: change.date ?? null,
          detectedAt: now,
        })
      }
    }
  }
  // --- End change detection ---

  // Upsert core bill row
  await db.insert(bills).values({
    billId:             bill.bill_id,
    changeHash:         bill.change_hash,
    sessionId:          bill.session_id,
    state:              bill.state,
    provider:           provider.id,
    stateId:            bill.state_id,
    billNumber:         bill.bill_number,
    billType:           bill.bill_type,
    billTypeId:         bill.bill_type_id,
    body:               bill.body,
    bodyId:             bill.body_id,
    currentBody:        bill.current_body,
    currentBodyId:      bill.current_body_id,
    title:              bill.title,
    description:        bill.description || null,
    status:             bill.status,
    statusDate:         bill.status_date || null,
    completed:          (bill as any).completed ?? 0,
    pendingCommitteeId: bill.pending_committee_id || null,
    url:                bill.url || null,
    stateLink:          bill.state_link || null,
    progressJson:       bill.progress ? JSON.stringify(bill.progress) : null,
    updatedAt:          now,
    createdAt:          now,
    textsFetchedAt:     now,
  }).onConflictDoUpdate({
    target: bills.billId,
    set: {
      changeHash:         bill.change_hash,
      // A bill first inserted from a masterlist (which carries no type) keeps the
      // column default 'B' until this runs, so write the type on every ingest.
      billType:           bill.bill_type,
      billTypeId:         bill.bill_type_id,
      title:              bill.title,
      description:        bill.description || null,
      status:             bill.status,
      statusDate:         bill.status_date || null,
      completed:          (bill as any).completed ?? 0,
      pendingCommitteeId: bill.pending_committee_id || null,
      url:                bill.url || null,
      stateLink:          bill.state_link || null,
      progressJson:       bill.progress ? JSON.stringify(bill.progress) : null,
      currentBody:        bill.current_body,
      currentBodyId:      bill.current_body_id,
      updatedAt:          detectedChanges.length > 0 ? now : sql`updated_at`,
      textsFetchedAt:     now,
    },
  })

  // Replace child rows
  await db.delete(billHistory).where(eq(billHistory.billId, bill.bill_id))
  for (let i = 0; i < (bill.history ?? []).length; i++) {
    const h = bill.history[i]
    await db.insert(billHistory).values({
      id: crypto.randomUUID(), billId: bill.bill_id,
      date: h.date, action: h.action,
      chamber: h.chamber || null, chamberId: h.chamber_id,
      importance: h.importance, seq: i,
      videoUrl: httpUrl(h.video_url),
    })
  }

  await db.delete(billSponsors).where(eq(billSponsors.billId, bill.bill_id))
  for (const s of bill.sponsors ?? []) {
    // Persist the person record embedded on the sponsor. routes/bills resolves
    // sponsor display names by joining bill_sponsors -> people; without this,
    // any state that arrives via keyword sync (rather than a bulk dataset seed)
    // has no people rows and falls back to showing the numeric people_id.
    // Update the display fields on conflict but preserve bio_json, which only
    // the richer bulk/getSessionPeople sources populate (see personRow).
    if (s.people_id) {
      const personValues = personRow(s, bill.state_id ?? null)
      const { peopleId: _omit, ...personUpdate } = personValues
      // A person keeps the provider that first wrote them: set on insert only.
      await db.insert(people).values({ ...personValues, provider: provider.id }).onConflictDoUpdate({
        target: people.peopleId,
        set: personUpdate,
      })
    }
    await db.insert(billSponsors).values({
      id: crypto.randomUUID(), billId: bill.bill_id,
      peopleId: s.people_id || null,
      sponsorTypeId: s.sponsor_type_id,
      sponsorOrder: s.sponsor_order,
      committeeSponsor: (s as any).committee_sponsor ?? 0,
      committeeId: (s as any).committee_id || null,
    })
  }

  await db.delete(billSasts).where(eq(billSasts.billId, bill.bill_id))
  for (const s of bill.sasts ?? []) {
    await db.insert(billSasts).values({
      id: crypto.randomUUID(), billId: bill.bill_id,
      typeId: s.type_id, type: s.type,
      sastBillNumber: s.sast_bill_number, sastBillId: s.sast_bill_id,
    })
  }

  await db.delete(billSubjects).where(eq(billSubjects.billId, bill.bill_id))
  for (const s of bill.subjects ?? []) {
    await db.insert(billSubjects).values({
      id: crypto.randomUUID(), billId: bill.bill_id,
      subjectId: s.subject_id, subjectName: s.subject_name,
    })
  }

  await db.delete(billReferrals).where(eq(billReferrals.billId, bill.bill_id))
  for (const r of bill.referrals ?? []) {
    await db.insert(billReferrals).values({
      id: crypto.randomUUID(), billId: bill.bill_id,
      date: r.date, committeeId: r.committee_id || null,
      chamber: r.chamber || null, chamberId: r.chamber_id || null,
      name: r.name || null,
    })
  }

  await db.delete(billCalendar).where(eq(billCalendar.billId, bill.bill_id))
  for (const cal of bill.calendar ?? []) {
    await db.insert(billCalendar).values({
      id: crypto.randomUUID(), billId: bill.bill_id,
      typeId: cal.type_id || null, eventHash: cal.event_hash || null,
      type: cal.type || null, date: cal.date || null,
      time: cal.time || null, location: cal.location || null,
      description: cal.description || null,
    })
  }

  // The provider's extras. Display only: change detection above never sees
  // them, so an extra changing alone notifies no one.
  await replaceBillExtras(db, bill, provider)

  // Upsert texts — preserve existing r2_key
  for (const t of bill.texts ?? []) {
    await db.insert(billTexts).values({
      docId: t.doc_id, billId: bill.bill_id,
      date: t.date, type: t.type, typeId: t.type_id,
      mime: t.mime, mimeId: t.mime_id,
      url: t.url || null, stateLink: t.state_link || null,
      textSize: t.text_size || null, textHash: t.text_hash || null,
      altBillText: t.alt_bill_text ?? 0,
      altMime: t.alt_mime || null, altMimeId: t.alt_mime_id || null,
      altStateLink: t.alt_state_link || null,
      altTextSize: t.alt_text_size || null, altTextHash: t.alt_text_hash || null,
    }).onConflictDoUpdate({
      target: billTexts.docId,
      set: {
        date: t.date, type: t.type,
        mime: t.mime, stateLink: t.state_link || null,
        textSize: t.text_size || null, textHash: t.text_hash || null,
        altBillText: t.alt_bill_text ?? 0,
        altStateLink: t.alt_state_link || null,
      },
    })

    // Download text if not already in R2
    const stored = await db.select({ r2Key: billTexts.r2Key })
      .from(billTexts).where(eq(billTexts.docId, t.doc_id)).get()
    if ((forceTextRefetch || !stored?.r2Key) && t.state_link) {
      await downloadTextToR2(bill.bill_id, t.doc_id, t.state_link, t.mime, provider, env, db, t.text_size ?? null, t.text_hash ?? null)
    }
  }

  // Upsert supplements
  for (const s of bill.supplements ?? []) {
    await db.insert(billSupplements).values({
      supplementId:   s.supplement_id,
      billId:         bill.bill_id,
      date:           s.date || null,
      typeId:         s.type_id,
      type:           s.type || null,
      title:          s.title || null,
      description:    s.description || null,
      mime:           s.mime || null,
      url:            s.url || null,
      stateLink:      s.state_link || null,
      supplementSize: s.supplement_size || null,
      supplementHash: s.supplement_hash || null,
    }).onConflictDoUpdate({
      target: billSupplements.supplementId,
      set: {
        date:           s.date || null,
        typeId:         s.type_id,
        type:           s.type || null,
        title:          s.title || null,
        description:    s.description || null,
        mime:           s.mime || null,
        url:            s.url || null,
        stateLink:      s.state_link || null,
        supplementSize: s.supplement_size || null,
        supplementHash: s.supplement_hash || null,
      },
    })
  }

  // Upsert amendments
  for (const a of bill.amendments ?? []) {
    await db.insert(billAmendments).values({
      amendmentId:   a.amendment_id,
      billId:        bill.bill_id,
      adopted:       a.adopted ?? 0,
      chamber:       a.chamber || null,
      date:          a.date || null,
      title:         a.title || null,
      description:   a.description || null,
      mime:          a.mime || null,
      url:           a.url || null,
      stateLink:     a.state_link || null,
      amendmentSize: a.amendment_size || null,
      amendmentHash: a.amendment_hash || null,
    }).onConflictDoUpdate({
      target: billAmendments.amendmentId,
      set: {
        adopted:       a.adopted ?? 0,
        chamber:       a.chamber || null,
        date:          a.date || null,
        title:         a.title || null,
        description:   a.description || null,
        mime:          a.mime || null,
        url:           a.url || null,
        stateLink:     a.state_link || null,
        amendmentSize: a.amendment_size || null,
        amendmentHash: a.amendment_hash || null,
      },
    })
  }

  // Upsert roll calls (vote summaries from getBill). Per-legislator vote rows
  // (roll_call_votes) would cost a getRollCall call each, so for LegiScan they
  // come from the weekly vote-dataset load instead (cron/vote-datasets.ts).
  // Providers whose records carry them inline, such as DC LIMS, set member_votes.
  const memberVotes: RollCallMemberVotes[] = []
  for (const v of bill.votes ?? []) {
    await db.insert(rollCalls).values({
      rollCallId:  v.roll_call_id,
      billId:      bill.bill_id,
      date:        v.date,
      description: v.desc || null,
      yea:         v.yea ?? 0,
      nay:         v.nay ?? 0,
      nv:          v.nv ?? 0,
      absent:      v.absent ?? 0,
      total:       v.total ?? 0,
      passed:      v.passed ?? 0,
      chamber:     v.chamber || null,
      chamberId:   v.chamber_id ?? null,
      url:         v.url || null,
      stateLink:   v.state_link || null,
    }).onConflictDoUpdate({
      target: rollCalls.rollCallId,
      set: {
        date:        v.date,
        description: v.desc || null,
        yea:         v.yea ?? 0,
        nay:         v.nay ?? 0,
        nv:          v.nv ?? 0,
        absent:      v.absent ?? 0,
        total:       v.total ?? 0,
        passed:      v.passed ?? 0,
        chamber:     v.chamber || null,
        chamberId:   v.chamber_id ?? null,
        url:         v.url || null,
        stateLink:   v.state_link || null,
      },
    })

    if (v.member_votes) {
      memberVotes.push({
        rollCallId: v.roll_call_id,
        // A vote whose member the provider couldn't resolve has no person to
        // show it under (the bill API skips those), so it isn't stored.
        votes: v.member_votes.filter(mv => mv.people_id != null)
          .map(mv => ({ peopleId: mv.people_id!, voteId: mv.vote_id, voteText: mv.vote_text })),
      })
    }
  }
  // One write for every member vote of the bill: a Virginia budget bill has
  // thousands, and one query each would pass D1's per-invocation query limit.
  if (memberVotes.length > 0) await writeMemberVotes(env.DB, memberVotes, { replace: true })

  const calendarBlock: CalendarBlock = {
    events: (bill.calendar ?? []).map(e => ({
      identityKey: calendarIdentityKey(e),
      date: e.date || null,
      time: e.time || null,
      location: e.location || null,
      description: e.description || null,
      eventHash: e.event_hash || null,
    })),
    changes: calendarChanges,
  }
  await notifyTenants(bill.bill_id, env, db, now, forceMetadata, forceAI, detectedChanges, calendarBlock, interactive)
}

/**
 * A browser-like User-Agent for state-site document fetches.
 *
 * Several legislature sites content-negotiate on User-Agent and answer
 * non-browser clients with their JavaScript app shell — HTTP 200, and
 * `content-type: text/html` even for a URL ending in `.pdf`. Indiana's
 * iga.in.gov does exactly this: a bare fetch of a bill PDF returns 691 bytes of
 * "You need to enable JavaScript to run this app", while the same URL with a
 * plausible browser UA returns the real 180KB PDF. The UA has to look real —
 * a truncated `Mozilla/5.0 Chrome/140.0` still gets the shell.
 */
const TEXT_FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * Decide whether a fetched payload is plausibly the document we asked for.
 * Returns null when it looks fine, or a short human-readable reason when it
 * does not.
 *
 * This exists because "HTTP 200" is not evidence of success. The bot-wall case
 * above returned 200 with a tiny HTML body under a `.pdf` URL, we stored it, and
 * the tenant then handed it to Gemini as a PDF — which failed with "The document
 * has no pages" for every Indiana bill. Storing an r2_key for that payload is
 * worse than storing nothing, because the download path only retries texts
 * `WHERE r2_key IS NULL`, so the bad object is sticky.
 */
export function validateTextPayload(
  body: ArrayBuffer,
  mime: string,
  declaredSize: number | null,
): string | null {
  const bytes = new Uint8Array(body)
  if (bytes.byteLength === 0) return 'empty response body'

  const head = new TextDecoder('latin1').decode(bytes.slice(0, 5))
  if (mime.includes('pdf') && head !== '%PDF-') {
    const peek = new TextDecoder('latin1').decode(bytes.slice(0, 60)).replace(/\s+/g, ' ')
    return `expected a PDF, got ${JSON.stringify(peek)}`
  }

  // A body far smaller than LegiScan's declared size is the generic shape of an
  // error/interstitial page standing in for the document. Only applied when the
  // declared size is big enough for the ratio to mean something.
  if (declaredSize && declaredSize > 4096 && bytes.byteLength * 4 < declaredSize) {
    return `body far smaller than declared size (${bytes.byteLength} vs ${declaredSize} bytes)`
  }

  return null
}

/**
 * Can this URL name a specific document version?
 *
 * A fragment is never transmitted to the server, so a link that selects a
 * version with one cannot fetch that version — the server answers with
 * whatever is current. California's leginfo does exactly this
 * (`...billTextClient.xhtml?bill_id=...#99INT`), which is why every stored CA
 * document held whatever was current on the day we fetched it, and why two
 * different doc_ids for the same bill came back byte-identical.
 *
 * This keys on the URL, not the state. A state that adopts the same pattern is
 * handled without a code change.
 */
export function isVersionAddressable(stateLink: string): boolean {
  return !stateLink.includes('#')
}

async function downloadTextToR2(
  billId: number,
  docId: number,
  stateLink: string,
  mime: string,
  provider: Provider,
  env: Env,
  db: Db,
  declaredSize: number | null = null,
  declaredHash: string | null = null,
): Promise<void> {
  const ext = mime.includes('pdf') ? 'pdf' : 'html'
  const r2Key = `bills/legiscan-${billId}/texts/${docId}.${ext}`
  const attemptedAt = nowDb()

  // Attempt 1: the state's own link, with a browser UA.
  let body: ArrayBuffer | null = null
  let contentType = ext === 'pdf' ? 'application/pdf' : 'text/html'
  let failure: string | null = null

  if (!isVersionAddressable(stateLink)) {
    failure = 'state_link selects its version with a fragment, which the server never sees'
  } else try {
    const res = await safeFetch(stateLink, { headers: { 'user-agent': TEXT_FETCH_UA } })
    if (!res.ok) {
      failure = `state_link HTTP ${res.status}`
    } else {
      const candidate = await res.arrayBuffer()
      const invalid = validateTextPayload(candidate, mime, declaredSize)
      if (invalid) {
        failure = `state_link returned ${invalid}`
      } else {
        body = candidate
        contentType = res.headers.get('content-type') ?? contentType
      }
    }
  } catch (err) {
    failure = `state_link fetch threw: ${err instanceof Error ? err.message : String(err)}`
  }

  // Attempt 2: the provider's own copy, when it keeps one (LegiScan's
  // getBillText). That can cost an API call per document, so it only runs when
  // the direct fetch produced nothing usable. The provider is the bill's own,
  // so it is only ever asked for documents it issued.
  if (!body && provider.fetchDocument) {
    console.warn(`[processor-ls] doc ${docId}: ${failure} — falling back to the ${provider.id} copy`)
    try {
      const doc = await provider.fetchDocument(docId, providerContext(provider, env, db))
      const invalid = validateTextPayload(doc.bytes, doc.mime || mime, doc.size ?? declaredSize)
      if (invalid) {
        failure = `${failure}; ${provider.id} copy also returned ${invalid}`
      } else if (declaredHash && await md5Hex(doc.bytes) !== declaredHash) {
        // The provider's copy is byte-exact what it catalogued, so a mismatch
        // means we did not get the document we asked for. Deliberately NOT
        // applied to the state_link path: a live page never reproduces this
        // hash, even when it is the correct version.
        failure = `${failure}; ${provider.id} copy hash mismatch against text_hash`
      } else {
        body = doc.bytes
        contentType = doc.mime || contentType
        failure = null
      }
    } catch (err) {
      failure = `${failure}; ${provider.id} copy threw: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (!body) {
    // Record the failure instead of leaving the row indistinguishable from
    // "not downloaded yet" — that ambiguity is what let 40 unreadable Indiana
    // bills look like they had simply never been processed.
    console.error(`[processor-ls] giving up on doc ${docId}: ${failure}`)
    await db.update(billTexts)
      .set({ fetchError: failure, fetchAttemptedAt: attemptedAt })
      .where(eq(billTexts.docId, docId))
    return
  }

  // Server often omits charset; sniff from HTML meta tag so browsers decode correctly
  if (ext === 'html' && !contentType.includes('charset')) {
    const peek = new TextDecoder('latin1').decode(body.slice(0, 2048))
    const m = peek.match(/charset=["']?([^"'\s;>]+)/i)
    if (m) contentType = `text/html; charset=${m[1]}`
  }
  await env.BILLS_BUCKET.put(r2Key, body, {
    httpMetadata: { contentType },
  })
  await db.update(billTexts)
    .set({ r2Key, fetchError: null, fetchAttemptedAt: attemptedAt })
    .where(eq(billTexts.docId, docId))
}

/**
 * MD5 of a byte buffer, hex-encoded.
 *
 * `crypto.subtle.digest('MD5', …)` is a Cloudflare extension — it is not in the
 * documented algorithm table but works in workerd and typechecks. Verified:
 * md5("abc") === "900150983cd24fb0d6963f7d28e17f72".
 */
async function md5Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('MD5', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function notifyTenants(
  billId: number,
  env: Env,
  db: Db,
  now: string,
  forceMetadata = false,
  forceAI = false,
  changes: ChangeRecord[] = [],
  calendar?: CalendarBlock,
  interactive = false,
): Promise<void> {
  const matchingTenants = await db
    .select({ tenantId: billTenants.tenantId, matchType: billTenants.matchType, queueId: tenants.queueId })
    .from(billTenants)
    .leftJoin(tenants, eq(tenants.tenantId, billTenants.tenantId))
    .where(eq(billTenants.billId, billId))
    .all()

  for (const t of matchingTenants) {
    const body: NotificationMessage = {
      tenantId: t.tenantId,
      billId: toHandle(billId),
      forceMetadata,
      forceAI,
      matchType: (t.matchType ?? null) as 'keyword' | 'manual' | null,
      ...(interactive ? { interactive: true as const } : {}),
      ...(changes.length > 0 ? {
        changes: changes.map(c => ({ ...c, detectedAt: now })),
      } : {}),
      ...(calendar && (calendar.events.length > 0 || calendar.changes.length > 0) ? { calendar } : {}),
    }
    // Binding-first (existing tenants unchanged); HTTP fallback by queue_id for
    // tenants onboarded without a static binding.
    const outcome = await deliverToTenant(env, t.tenantId, t.queueId ?? null, body)
    if (outcome === 'dropped') {
      console.error(
        `[processor-ls] dropped bill ${billId} for tenant ${t.tenantId}: ` +
        `no queue binding and no queue_id (add a binding or re-register the tenant)`,
      )
    }
  }

  if (matchingTenants.length > 0) {
    await db.update(billTenants)
      .set({ notifiedAt: now })
      .where(eq(billTenants.billId, billId))
  }
}
