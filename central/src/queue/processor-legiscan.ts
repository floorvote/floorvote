import { eq, and, isNull, sql } from 'drizzle-orm'
import { getBill, getBillText } from '../lib/legiscan'
import {
  bills, billHistory, billSponsors, billTexts, billSupplements, billAmendments,
  billSasts, billSubjects, billReferrals, billCalendar, billTenants, apiCallLog,
  billChangeLog, rollCalls, people, tenants,
} from '../db/schema-legiscan'
import { detectChanges, detectCalendarChanges, calendarIdentityKey, type BillSnapshot, type ChangeRecord, type CalendarChange, type PriorCalendarRow } from '../lib/detect-changes'
import type { LsEnv, LsDb, LsIngestorMessage, LsNotificationMessage, CalendarBlock } from '../types-legiscan'
import { nowDb } from '../lib/dbTime'
import { deliverToTenant } from '../lib/tenantDelivery'
import { safeFetch } from '../lib/safeFetch'

function trackLsCall(db: LsDb, callType: string, params: Record<string, unknown>): void {
  db.insert(apiCallLog)
    .values({ loggedAt: nowDb(), callType, params: JSON.stringify(params) })
    .catch(err => console.error('[rate-limit] failed to log API call:', err))
}

export async function processLsIngestorQueue(
  batch: MessageBatch<LsIngestorMessage>,
  env: LsEnv,
  db: LsDb,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processLsBill(message.body, env, db)
      message.ack()
    } catch (err) {
      console.error('[processor-ls] failed for billId', message.body.billId, err)
      message.retry()
    }
  }
}

async function processLsBill(msg: LsIngestorMessage, env: LsEnv, db: LsDb): Promise<void> {
  const forceMetadata = msg.forceMetadata ?? false
  const forceAI = msg.forceAI ?? false
  const interactive = msg.interactive ?? false

  if (msg.skipFetch) {
    // Data already in DB from bulk seed — skip LegiScan API call, just download text and notify
    const textsToDownload = await db.select({
      docId: billTexts.docId,
      stateLink: billTexts.stateLink,
      mime: billTexts.mime,
      textSize: billTexts.textSize,
    })
      .from(billTexts)
      .where(and(eq(billTexts.billId, msg.billId), isNull(billTexts.r2Key)))
      .all()

    for (const t of textsToDownload) {
      if (t.stateLink) {
        await downloadTextToR2(msg.billId, t.docId, t.stateLink, t.mime ?? 'text/html', env, db, t.textSize)
      }
    }

    await notifyLsTenants(msg.billId, env, db, nowDb(), forceMetadata, forceAI, [], undefined, interactive)
    return
  }

  trackLsCall(db, 'getBill', { billId: msg.billId })
  const bill = await getBill(msg.billId, env.LEGISCAN_API_KEY)
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

    detectedChanges = detectChanges(snapshot, bill)

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
    })
  }

  await db.delete(billSponsors).where(eq(billSponsors.billId, bill.bill_id))
  for (const s of bill.sponsors ?? []) {
    // Persist the person record embedded on the sponsor. bills-legiscan resolves
    // sponsor display names by joining bill_sponsors -> people; without this,
    // any state that arrives via keyword sync (rather than a bulk dataset seed)
    // has no people rows and falls back to showing the numeric people_id.
    // Update the display fields on conflict but preserve bio_json, which only
    // the richer bulk/getSessionPeople sources populate.
    if (s.people_id) {
      const personValues = {
        peopleId:      s.people_id,
        personHash:    s.person_hash ?? null,
        stateId:       s.state_id ?? bill.state_id ?? null,
        partyId:       s.party_id ?? null,
        party:         s.party || null,
        roleId:        s.role_id ?? null,
        role:          s.role || null,
        name:          s.name || String(s.people_id),
        firstName:     s.first_name ?? null,
        middleName:    s.middle_name ?? null,
        lastName:      s.last_name ?? null,
        suffix:        s.suffix ?? null,
        nickname:      s.nickname ?? null,
        district:      s.district || null,
        ftmEid:        s.ftm_eid ?? null,
        votesmartId:   s.votesmart_id ?? null,
        opensecretsId: s.opensecrets_id ?? null,
        knowwhoPid:    s.knowwho_pid ?? null,
        ballotpedia:   s.ballotpedia ?? null,
        bioguideId:    s.bioguide_id ?? null,
      }
      const { peopleId: _omit, ...personUpdate } = personValues
      await db.insert(people).values(personValues).onConflictDoUpdate({
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
    if (!stored?.r2Key && t.state_link) {
      await downloadTextToR2(bill.bill_id, t.doc_id, t.state_link, t.mime, env, db, t.text_size ?? null)
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
  // (roll_call_votes) require getRollCall calls and are out of scope here —
  // bulk seed has them; live-ingested bills won't.
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
  }

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
  await notifyLsTenants(bill.bill_id, env, db, now, forceMetadata, forceAI, detectedChanges, calendarBlock, interactive)
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

async function downloadTextToR2(
  billId: number,
  docId: number,
  stateLink: string,
  mime: string,
  env: LsEnv,
  db: LsDb,
  declaredSize: number | null = null,
): Promise<void> {
  const ext = mime.includes('pdf') ? 'pdf' : 'html'
  const r2Key = `bills/legiscan-${billId}/texts/${docId}.${ext}`
  const attemptedAt = nowDb()

  // Attempt 1: the state's own link, with a browser UA.
  let body: ArrayBuffer | null = null
  let contentType = ext === 'pdf' ? 'application/pdf' : 'text/html'
  let failure: string | null = null

  try {
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

  // Attempt 2: LegiScan's getBillText (base64). Costs one API call per document,
  // so it only runs when the direct fetch produced nothing usable.
  if (!body) {
    console.warn(`[processor-ls] doc ${docId}: ${failure} — falling back to getBillText`)
    try {
      trackLsCall(db, 'getBillText', { docId })
      const text = await getBillText(docId, env.LEGISCAN_API_KEY)
      const decoded = base64ToBytes(text.doc)
      const invalid = validateTextPayload(decoded.buffer as ArrayBuffer, text.mime || mime, text.text_size ?? declaredSize)
      if (invalid) {
        failure = `${failure}; getBillText also returned ${invalid}`
      } else {
        body = decoded.buffer as ArrayBuffer
        contentType = text.mime || contentType
        failure = null
      }
    } catch (err) {
      failure = `${failure}; getBillText threw: ${err instanceof Error ? err.message : String(err)}`
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

/** Decode base64 (as LegiScan returns document bytes) without Node Buffer. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function notifyLsTenants(
  billId: number,
  env: LsEnv,
  db: LsDb,
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
    const body: LsNotificationMessage = {
      tenantId: t.tenantId,
      billId: `legiscan:${billId}`,
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
