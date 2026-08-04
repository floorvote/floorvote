import { and, eq, sql } from 'drizzle-orm'
import { processBill } from '../lib/llm'
import { DEFAULT_TAXONOMY, parseTaxonomyItems, filterTagsToTaxonomy } from '../lib/taxonomy'
import { ensureInstancePreset } from '../lib/instancePreset'
import { centralFetch } from '../lib/centralFetch'
import { matchesKeywords } from '../lib/keywords'
import { bills, associationConfig, feedEvents, billTexts, calendarEvents } from '../db/schema'
import { nowDb } from '../lib/dbTime'
import type { AppDb, Env, TenantQueueMessage } from '../types'

class AiShedError extends Error {
  constructor(public readonly delaySeconds: number) {
    super('AI gateway shed — will redeliver')
  }
}

function isGeminiShed(err: unknown): boolean {
  const e = err as { status?: number } | undefined
  return e?.status === 429 || e?.status === 503
}

// AiSkipReason values mirror the column in api/migrations/0039_ai_skip_reason.sql.
// Add new reasons here and document them in the migration when new permanent-failure
// modes are discovered.
type AiSkipReason = 'pdf_too_large'

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
  return null
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function pickLatestTextDocId(centralBill: { texts?: Array<{ docId: string; date: string }> }): string | null {
  const texts = centralBill.texts
  if (!texts || texts.length === 0) return null
  const sorted = [...texts].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.docId < b.docId ? 1 : -1
  })
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
        console.warn(`[processor] AI gateway shed for ${message.body.billId}${err.delaySeconds > 0 ? `, requeing in ${err.delaySeconds}s` : ', requeing immediately'}`)
        if (err.delaySeconds > 0) {
          message.retry({ delaySeconds: err.delaySeconds })
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
  yearStart: number | null
  yearEnd: number | null
  state: string
  number: string
  title: string
  abstract: string | null
  status: string | null
  statusDate: string | null
  lastAction?: string | null
  lastActionDate?: string | null
  updatedAt: string
  openstatesUrl: string | null
  stateUrl: string | null
  textHash: string | null
  textR2Key: string | null
  textStatus?: 'not_checked' | 'no_texts' | 'available' | 'in_r2'
  texts: Array<{ docId: string; note: string; date: string; links: Array<{ url: string; mediaType: string }> }>
  actions: Array<{ description: string; date: string; chamber: string | null; classification: string[]; order: number }>
  sponsors: Array<{ name: string; party: string | null; role: string | null; primary: boolean; personId: string | null; url: string | null }>
  votes: Array<unknown>
  relatedBills: Array<{ identifier: string; session: string; relationType: string }>
}

export async function processCentralNotification(
  msg: TenantQueueMessage,
  env: Env,
  db: AppDb,
): Promise<void> {
  if (msg.tenantId !== env.TENANT_ID) return

  const res = await centralFetch(env, `/bills/${msg.billId}`)
  if (!res.ok) throw new Error(`Central API returned ${res.status} for bill ${msg.billId}`)

  const centralBill = await res.json() as CentralBill

  const existing = await db.select({
    id: bills.id,
    providerUpdatedAt: bills.providerUpdatedAt,
    lastAiTextHash: bills.lastAiTextHash,
    status: bills.status,
    lastAction: bills.lastAction,
    aiProcessedAt: bills.aiProcessedAt,
    aiSkipReason: bills.aiSkipReason,
    matchType: bills.matchType,
    priority: bills.priority,
    textR2Key: bills.textR2Key,
    newMatchAt: bills.newMatchAt,
  }).from(bills).where(eq(bills.externalId, msg.billId)).get()

  // Stub-only path: upsert metadata, mark as stub, skip text fetch + AI entirely
  if (msg.stubOnly) {
    // Don't re-stub bills that have AI data (they were promoted to full tracking)
    // or that were manually added by an admin. This guards against:
    //   - a stub message arriving after a promote (race) that would otherwise
    //     hide a fully-tracked bill from members
    //   - a manually-added bill being downgraded to a stub
    if (existing?.aiProcessedAt || existing?.matchType === 'manual') {
      console.log(`[processor] skipping stub upsert for ${msg.billId}: already tracked or manual`)
      return
    }
    const primarySponsorStub = centralBill.sponsors.find(s => s.primary) ?? centralBill.sponsors[0] ?? null
    const coSponsorListStub = centralBill.sponsors
      .filter(s => s !== primarySponsorStub)
      .map(s => ({ name: s.name, url: s.url ?? null, party: s.party ?? null }))
    const historyStub = centralBill.actions.map(a => ({
      date: a.date,
      action: a.description,
      chamber: a.chamber,
    }))
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
      status: centralBill.status ?? '',
      session:   centralBill.sessionName ?? resolveSessionLabel(centralBill.sessionId),
      sessionId: centralBill.sessionId ?? null,
      yearStart: centralBill.yearStart ?? null,
      yearEnd:   centralBill.yearEnd   ?? null,
      abstract: centralBill.abstract ?? null,
      url: centralBill.openstatesUrl ?? centralBill.stateUrl ?? null,
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
    }

    await upsertBill(db, msg.billId, { ...stubData, updatedAt: nowStub })
    return
  }

  // Metadata-only path: upsert metadata from central, skip text fetch + AI.
  // Used to refresh denormalized fields (history, sponsors, etc.) without burning AI quota.
  if (msg.metadataOnly) {
    const primarySponsorMd = centralBill.sponsors.find(s => s.primary) ?? centralBill.sponsors[0] ?? null
    const coSponsorListMd = centralBill.sponsors
      .filter(s => s !== primarySponsorMd)
      .map(s => ({ name: s.name, url: s.url ?? null, party: s.party ?? null }))
    const historyMd = centralBill.actions.map(a => ({
      date: a.date,
      action: a.description,
      chamber: a.chamber,
    }))
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
      status: centralBill.status ?? '',
      session:   centralBill.sessionName ?? resolveSessionLabel(centralBill.sessionId),
      sessionId: centralBill.sessionId ?? null,
      yearStart: centralBill.yearStart ?? null,
      yearEnd:   centralBill.yearEnd   ?? null,
      abstract: centralBill.abstract ?? null,
      url: centralBill.openstatesUrl ?? centralBill.stateUrl ?? null,
      stateUrl: centralBill.stateUrl ?? null,
      providerUpdatedAt: centralBill.updatedAt,
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
    }

    await upsertBill(db, msg.billId, { ...metadataData, updatedAt: nowMd })
    return
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
  if (!msg.forceMetadata && !msg.forceAI && !msg.stubOnly && !msg.metadataOnly && !centralHasNewR2Key && existing?.providerUpdatedAt === centralBill.updatedAt && (existing?.aiProcessedAt != null || existing?.aiSkipReason != null)) {
    // Calendar reconciliation must still run even when the bill itself hasn't changed,
    // since hearings are updated independently of bill metadata.
    if (msg.calendar && existing && (existing.matchType !== null || existing.priority !== null)) {
      const nowEarly = nowDb()
      await reconcileCalendar(db, existing.id, msg, false, nowEarly)
    }
    return
  }

  // Map normalized sponsors — OpenStates marks all as primary:true, so treat first as primary, rest as co-sponsors
  const primarySponsor = centralBill.sponsors.find(s => s.primary) ?? centralBill.sponsors[0] ?? null
  const coSponsorList = centralBill.sponsors
    .filter(s => s !== primarySponsor)
    .map(s => ({ name: s.name, url: s.url ?? null, party: s.party ?? null }))

  // Map actions to history format
  const history = centralBill.actions.map(a => ({
    date: a.date,
    action: a.description,
    chamber: a.chamber,
  }))
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
    status: centralBill.status ?? '',
    session:   centralBill.sessionName ?? resolveSessionLabel(centralBill.sessionId),
    sessionId: centralBill.sessionId ?? null,
    yearStart: centralBill.yearStart ?? null,
    yearEnd:   centralBill.yearEnd   ?? null,
    abstract: centralBill.abstract ?? null,
    url: centralBill.openstatesUrl ?? centralBill.stateUrl ?? null,
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
    textR2Key: centralBill.textR2Key,
    textStatus: centralBill.textStatus ?? null,
  }

  // Determine if AI should run
  const kwRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'keywords')).get()
  const keywords: string[] = kwRow ? JSON.parse(kwRow.value) : []
  const keywordMatch = keywords.length === 0 || matchesKeywords(`${centralBill.title} ${centralBill.abstract ?? ''}`, keywords)
  // If message carries an explicit matchType (from central), use it.
  // If not (e.g. forceAI re-queue from tenant), preserve whatever is already on the row.
  // Only derive from keyword matching for brand-new bills with no classification yet.
  const derivedMatchType: 'keyword' | 'manual' | null =
    msg.matchType !== undefined ? msg.matchType
    : (existing?.matchType ?? (keywordMatch ? 'keyword' : null))
  // F5+B5: gate AI on canonical match_type rather than recomputed keywordMatch.
  // This fixes the case where a manually-promoted bill (match_type='manual')
  // whose title+abstract doesn't satisfy the tenant's current keywords would
  // never re-run AI on text changes, freezing its summary at promote-time.
  let shouldRunAi = msg.forceAI || derivedMatchType !== null
  if (shouldRunAi && !hasFullText) {
    console.warn(`[processor] skipping AI for ${msg.billId}: no full text available in central; leaving as stub`)
    shouldRunAi = false
  }

  const activePreset = await ensureInstancePreset(env, db)
  const aiDedup = !msg.forceAI && !msg.forceMetadata && existing?.lastAiTextHash && existing.lastAiTextHash === centralBill.textHash

  let aiResult: { summary: string; tags: string[]; relevanceScore: number } | null = null
  let aiSkipReason: AiSkipReason | null = null
  if (shouldRunAi && activePreset && !aiDedup) {
    const [aiContextRow, taxonomyRow, relevanceQuestionRow] = await Promise.all([
      db.select().from(associationConfig).where(eq(associationConfig.key, 'ai_context')).get(),
      db.select().from(associationConfig).where(eq(associationConfig.key, 'tag_taxonomy')).get(),
      db.select().from(associationConfig).where(eq(associationConfig.key, 'relevance_question')).get(),
    ])
    const aiContext = aiContextRow?.value ?? undefined
    const relevanceQuestion = relevanceQuestionRow?.value ?? undefined
    const dbTaxonomy = taxonomyRow ? parseTaxonomyItems(JSON.parse(taxonomyRow.value)) : []
    const taxonomy = dbTaxonomy.length > 0 ? dbTaxonomy : DEFAULT_TAXONOMY

    let billText = `${centralBill.title}. ${centralBill.abstract ?? ''}`
    let billPdfBase64: string | undefined
    let hasFullText = false
    try {
      const textRes = await centralFetch(env, `/bills/${msg.billId}/text`)
      if (textRes.ok) {
        const textData = await textRes.json() as { type: 'html' | 'pdf'; content: string }
        if (textData.type === 'pdf') billPdfBase64 = textData.content
        else billText = stripHtml(textData.content)
        hasFullText = true
      } else if (textRes.status !== 404) {
        console.error(`[processor] central text returned ${textRes.status} for ${centralBill.number}`)
      }
    } catch (err) {
      console.error(`[processor] failed to fetch text for ${centralBill.number}:`, err)
    }
    if (!hasFullText) console.log(`[processor] No full text for ${centralBill.number}, AI ran on title+abstract only`)

    const tier: 'flex' | 'priority' = msg.interactive ? 'priority' : 'flex'

    try {
      aiResult = await processBill(
        { billNumber: centralBill.number, title: centralBill.title, text: billText, pdfBase64: billPdfBase64, taxonomy, aiContext, relevanceQuestion },
        env,
        tier,
      )
    } catch (err) {
      if (isGeminiShed(err)) {
        if (tier === 'priority') {
          console.warn(`[processor] priority shed for ${centralBill.number}, retrying at standard tier`)
          try {
            aiResult = await processBill(
              { billNumber: centralBill.number, title: centralBill.title, text: billText, pdfBase64: billPdfBase64, taxonomy, aiContext, relevanceQuestion },
              env,
              'standard',
            )
          } catch (retryErr) {
            if (isGeminiShed(retryErr)) {
              throw new AiShedError(0)
            }
            aiSkipReason = classifyAiError(retryErr)
            if (aiSkipReason) {
              console.warn(`[processor] AI permanently skipped for ${centralBill.number}: ${aiSkipReason}`)
            } else {
              console.error(`AI processing failed for ${centralBill.number}:`, retryErr)
            }
          }
        } else {
          throw new AiShedError(60)
        }
      } else {
        aiSkipReason = classifyAiError(err)
        if (aiSkipReason) {
          console.warn(`[processor] AI permanently skipped for ${centralBill.number}: ${aiSkipReason}`)
        } else {
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
    }
  } else if (shouldRunAi && !activePreset) {
    console.log(`[processor] Skipping AI for ${centralBill.number} — no instance preset configured`)
  }

  const aiTextDocId = pickLatestTextDocId(centralBill)
  const queueChanges = msg.changes ?? []

  // New-match signal: the first time a bill becomes a fully-analyzed KEYWORD match
  // (manual adds are excluded — the adding admin already knows). Set once; later
  // re-analysis / status changes / keyword-resync re-promotes won't re-surface it.
  const isFirstKeywordMatch = !!aiResult && derivedMatchType === 'keyword' && !existing?.newMatchAt

  const upsertData = {
    ...billData,
    matchType: derivedMatchType,
    ...(aiResult ? {
      aiProcessedAt: now,
      lastAiTextHash: centralBill.textHash ?? null,
      lastAiTextDocId: aiTextDocId,
      tenantSummary: aiResult.summary,
      tags: JSON.stringify(aiResult.tags),
      relevanceScore: aiResult.relevanceScore,
      // Clear any prior permanent skip — AI ran successfully on this text version.
      aiSkipReason: null,
      ...(isFirstKeywordMatch ? { newMatchAt: now } : {}),
    } : aiSkipReason ? {
      // Permanent AI failure on this text. Recording lastAiTextHash here serves the
      // same dedup role as on success: if the text actually changes later, AI re-runs.
      lastAiTextHash: centralBill.textHash ?? null,
      lastAiTextDocId: aiTextDocId,
      aiSkipReason,
    } : {}),
    ...(queueChanges.length > 0 ? { updatedAt: now } : {}),
  }

  const { id: billInternalId, isNew } = await upsertBill(db, msg.billId, upsertData)

  // bill_texts: upsert from normalized versions
  for (const t of centralBill.texts) {
    const link = t.links[0] ?? null
    const altLink = t.links[1] ?? null
    await db.insert(billTexts).values({
      id: crypto.randomUUID(),
      billId: billInternalId,
      docId: t.docId,
      type: t.note,
      date: t.date,
      mime: link?.mediaType ?? 'text/html',
      textHash: '',
      stateLink: link?.url ?? null,
      altStateLink: altLink?.url ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: billTexts.docId,
      set: { type: t.note, date: t.date, mime: link?.mediaType ?? 'text/html', stateLink: link?.url ?? null, altStateLink: altLink?.url ?? null, updatedAt: now },
    })
  }

  // Feed events: only for tracked bills (keyword or manual) with AI data and detected changes from central.
  // F5+B5: switched gate from `!existing.isStub` to `existing.matchType !== null` (canonical field).
  if (!isNew && existing?.aiProcessedAt && existing.matchType !== null && queueChanges.length > 0) {
    await db.insert(feedEvents).values({
      id:       crypto.randomUUID(),
      type:     'bill_updated',
      billId:   billInternalId,
      userId:   'system',
      metadata: JSON.stringify({ changes: queueChanges }),
    })
  }

  // New keyword-match feed event: passive, system actor, written once. Stays out of
  // the default feed and nav-dot (bill_matched ∈ PASSIVE_EVENT_TYPES); shows only in
  // the "All fully analyzed bills" feed scope. Drives the new-match worklist/digest too.
  if (isFirstKeywordMatch) {
    await db.insert(feedEvents).values({
      id:       crypto.randomUUID(),
      type:     'bill_matched',
      billId:   billInternalId,
      userId:   'system',
      metadata: '{}',
    })
  }

  // Mirror hearings for tracked bills (priority filtering happens at read time).
  if (msg.calendar && (derivedMatchType !== null || existing?.priority != null)) {
    await reconcileCalendar(db, billInternalId, msg, isNew, now)
  }
}

function hearingUid(billId: string, identityKey: string, tenantId: string): string {
  const slug = identityKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const billPart = billId.replace(/[^a-z0-9]+/gi, '-')
  return `hearing-${billPart}-${slug}@${tenantId}`
}

async function reconcileCalendar(
  db: AppDb,
  billInternalId: string,
  msg: TenantQueueMessage,
  isNew: boolean,
  now: string,
): Promise<void> {
  const block = msg.calendar
  if (!block) return

  const incomingUids = new Set<string>()
  const changedUids = new Set<string>()

  // Upsert current events; bump sequence when event_hash changed.
  for (const e of block.events) {
    const uid = hearingUid(msg.billId, e.identityKey, msg.tenantId)
    incomingUids.add(uid)
    const existing = await db.select({ id: calendarEvents.id, sequence: calendarEvents.sequence, eventHash: calendarEvents.eventHash })
      .from(calendarEvents).where(eq(calendarEvents.uid, uid)).get()

    if (!existing) {
      await db.insert(calendarEvents).values({
        id: crypto.randomUUID(), uid, billId: billInternalId, source: 'hearing', sequence: 0,
        date: e.date, time: e.time, location: e.location, description: e.description,
        status: 'confirmed', eventHash: e.eventHash, createdAt: now, updatedAt: now,
      })
      changedUids.add(uid)
    } else {
      const bump = (existing.eventHash ?? '') !== (e.eventHash ?? '')
      await db.update(calendarEvents).set({
        billId: billInternalId, status: 'confirmed',
        date: e.date, time: e.time, location: e.location, description: e.description,
        eventHash: e.eventHash, sequence: bump ? existing.sequence + 1 : existing.sequence, updatedAt: now,
      }).where(eq(calendarEvents.uid, uid))
      if (bump) {
        changedUids.add(uid)
        console.log('[calendar-reconcile] hash bump', JSON.stringify({
          billId: msg.billId, tenantId: msg.tenantId, uid,
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
      const uid = hearingUid(msg.billId, ch.identityKey, msg.tenantId)
      if (!changedUids.has(uid)) continue
      console.log('[calendar-reconcile] feed event', JSON.stringify({
        billId: msg.billId, tenantId: msg.tenantId, uid, changeType: ch.changeType,
      }))
      await db.insert(feedEvents).values({
        id: crypto.randomUUID(),
        type: ch.changeType,
        billId: billInternalId,
        userId: 'system',
        metadata: JSON.stringify({ date: ch.date, time: ch.time, location: ch.location, description: ch.description }),
      })
    }
  }
}

function resolveSessionLabel(sessionId: string | null | undefined): string {
  if (!sessionId) return ''
  // synthesized seed sessions: "seed:RI:2026" → "2026"
  if (sessionId.startsWith('seed:')) return sessionId.split(':').pop() ?? sessionId
  // OpenStates session IDs: "ri:2026" → "2026"
  if (/^[a-z]{2}:\d{4}/.test(sessionId)) return sessionId.split(':').pop() ?? sessionId
  return sessionId
}

async function upsertBill(
  db: AppDb,
  externalId: string,
  data: Record<string, unknown>,
): Promise<{ id: string; isNew: boolean }> {
  const id = crypto.randomUUID()
  const now = nowDb()
  // Exclude externalId from the update set (it's the conflict target) and handle matchType separately
  // to preserve matchType='manual' for manually-added bills.
  const { externalId: _ext, matchType: _mt, ...updateFields } = data as any
  const returned = await db.insert(bills)
    .values({ id, ...data as any, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: bills.externalId,
      set: {
        ...updateFields,
        matchType: sql`CASE WHEN ${bills.matchType} = 'manual' THEN 'manual' WHEN excluded.match_type IS NOT NULL THEN excluded.match_type ELSE ${bills.matchType} END`,
        updatedAt: (updateFields as any).updatedAt ?? sql`updated_at`,
      },
    })
    .returning({ id: bills.id })
    .get()
  return { id: returned.id, isNew: returned.id === id }
}
