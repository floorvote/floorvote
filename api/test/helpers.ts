/// <reference types="vite/client" />
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { app } from '../src/index'
import { getDb } from '../src/db/client'
import { generateToken, hashToken } from '../src/lib/crypto'
// The schema (migrations, resetDb, clearDb) lives in test/schema.ts, which must
// not import the app; see its header.
export { parseMigration, migrationsFromFiles, applyMigrations, resetDb, rememberSchema, clearDb } from './schema'
import { users, sessions, magicLinks, bills, billTexts, roles, userRoles, comments, notifications, calendarEvents, authEvents } from '../src/db/schema'

// Send a request to the app and wait for the background work it starts
// (`ctx.waitUntil`, such as a magic-link email or a central backfill) before
// returning. SELF.fetch cannot do this: workerd runs that work after the
// response, so it can outlive the test, reach `fetch` once the stub is gone, or
// race the next test's resetDb(). A rejected background task would only be
// logged to stderr, so draining it here is what makes it a test failure.
// Accepts a path or a full URL, and an optional bindings override, like
// app.request.
export async function appFetch(input: string, init?: RequestInit, bindings: object = env): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await app.request(input, init, bindings, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

// Stub `fetch` (the global guard in test/setup.ts otherwise fails any request)
// with a handler that answers every request, defaulting to `200 {}`. Returns
// the spy so a test can assert on the calls.
export function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => new Response('{}', { status: 200 }),
) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input instanceof Request ? input.url : String(input), init))
  vi.stubGlobal('fetch', spy)
  return spy
}

export async function seedUser(overrides?: {
  role?: 'admin' | 'member' | 'owner'
  email?: string
  name?: string
  title?: string
  canVote?: boolean
  emailDigestEnabled?: boolean
  emailDigestMatchesEnabled?: boolean
  emailRepliesEnabled?: boolean
  deactivatedAt?: string | null
  invitedBy?: string | null
}): Promise<string> {
  const db = getDb(env.DB)
  const id = crypto.randomUUID()
  await db.insert(users).values({
    id,
    email: overrides?.email ?? `user-${id}@example.com`,
    name: overrides?.name ?? 'Test User',
    role: overrides?.role ?? 'member',
    title: overrides?.title ?? null,
    canVote: overrides?.canVote === false ? 0 : 1,
    emailDigestEnabled: overrides?.emailDigestEnabled === false ? 0 : 1,
    emailDigestMatchesEnabled: overrides?.emailDigestMatchesEnabled === false ? 0 : 1,
    emailRepliesEnabled: overrides?.emailRepliesEnabled === false ? 0 : 1,
    deactivatedAt: overrides?.deactivatedAt ?? null,
    invitedBy: overrides?.invitedBy ?? null,
  })
  return id
}

export async function seedSession(userId: string): Promise<string> {
  const db = getDb(env.DB)
  const rawToken = await generateToken()
  const tokenHash = await hashToken(rawToken)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    expiresAt,
    lastActive: new Date().toISOString(),
  })
  return rawToken
}

export async function seedMagicLink(
  userId: string,
  opts: { expired?: boolean; used?: boolean } = {},
): Promise<string> {
  const db = getDb(env.DB)
  const rawToken = await generateToken()
  const tokenHash = await hashToken(rawToken)
  const expiresAt = opts.expired
    ? new Date(Date.now() - 1000).toISOString()
    : new Date(Date.now() + 15 * 60 * 1000).toISOString()
  const usedAt = opts.used ? new Date().toISOString() : null
  await db.insert(magicLinks).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    expiresAt,
    usedAt,
  })
  return rawToken
}

export async function seedBill(overrides?: {
  /** Explicit primary key. Pass this when a test dumps rows that carry bill_id
   *  and needs the dump to be stable across runs (see demoReset.snapshot.test.ts);
   *  otherwise a random UUID is used. */
  id?: string
  billNumber?: string
  title?: string
  state?: string
  status?: string
  statusStage?: string | null
  statusRank?: number
  session?: string
  sessionId?: string
  /** The slug central assigned the bill's session. Omit for a bill stored before central sent one. */
  sessionSlug?: string | null
  abstract?: string
  url?: string
  stateUrl?: string
  priority?: 'high' | 'medium' | 'low' | null
  tenantSummary?: string
  tags?: string[]
  externalId?: string
  addedBy?: string
  sponsor?: string
  sponsorParty?: string
  lastAction?: string
  lastActionDate?: string
  history?: { date: string; action: string; chamber?: string | null }[]
  relatedBillIds?: string[]
  relevanceScore?: number
  aiProcessedAt?: string
  providerUpdatedAt?: string
  matchType?: 'keyword' | 'manual' | null
  textStatus?: 'not_checked' | 'no_texts' | 'available' | 'in_r2' | null
  yearStart?: number | null
  yearEnd?: number | null
  isDraft?: boolean
  draftText?: string | null
  newMatchAt?: string | null
  /** Where the keyword match came from; null (the default) counts as bulk. */
  matchProvenance?: 'routine' | 'bulk' | null
  triagedAt?: string | null
  /** Where central stored the bill's text, when the instance has been told. */
  textR2Key?: string | null
  /** Raw `bills.subjects` column value — a JSON-encoded array string (or null),
   *  not a decoded array. Pass e.g. '["Elections"]' to mirror what LegiScan sync
   *  actually writes. */
  subjects?: string | null
}): Promise<string> {
  const db = getDb(env.DB)
  const id = overrides?.id ?? crypto.randomUUID()
  await db.insert(bills).values({
    id,
    externalId: overrides?.externalId ?? null,
    billNumber: overrides?.billNumber ?? 'HB 1',
    title: overrides?.title ?? 'Test Bill',
    state: overrides?.state ?? 'RI',
    status: overrides?.status ?? '',
    statusStage: overrides?.statusStage ?? null,
    statusRank: overrides?.statusRank ?? 0,
    session: overrides?.session ?? '2026 Regular Session',
    sessionId: overrides?.sessionId ?? 'ri:2026',
    sessionSlug: overrides?.sessionSlug ?? null,
    abstract: overrides?.abstract ?? null,
    url: overrides?.url ?? null,
    stateUrl: overrides?.stateUrl ?? null,
    providerUpdatedAt: overrides?.providerUpdatedAt ?? null,
    priority: overrides?.priority ?? null,
    tenantSummary: overrides?.tenantSummary ?? null,
    tags: JSON.stringify(overrides?.tags ?? []),
    sponsor: overrides?.sponsor ?? null,
    sponsorParty: overrides?.sponsorParty ?? null,
    lastAction: overrides?.lastAction ?? null,
    lastActionDate: overrides?.lastActionDate ?? null,
    history: overrides?.history ? JSON.stringify(overrides.history) : null,
    relatedBillIds: overrides?.relatedBillIds ? JSON.stringify(overrides.relatedBillIds) : null,
    relevanceScore: overrides?.relevanceScore ?? null,
    aiProcessedAt: overrides?.aiProcessedAt ?? null,
    subjects: overrides?.subjects ?? null,
    matchType: overrides && 'matchType' in overrides ? overrides.matchType : 'keyword',
    textStatus: overrides?.textStatus ?? null,
    yearStart: overrides?.yearStart ?? null,
    yearEnd: overrides?.yearEnd ?? null,
    isDraft: overrides?.isDraft ?? false,
    draftText: overrides?.draftText ?? null,
    newMatchAt: overrides?.newMatchAt ?? null,
    matchProvenance: overrides?.matchProvenance ?? null,
    triagedAt: overrides?.triagedAt ?? null,
    textR2Key: overrides?.textR2Key ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  return id
}

export async function seedBillText(billId: string, overrides?: {
  docId?: string
  type?: string
  date?: string
  mime?: string
  textHash?: string
  r2Key?: string
}): Promise<string> {
  const db = getDb(env.DB)
  const id = crypto.randomUUID()
  await db.insert(billTexts).values({
    id,
    billId,
    docId: overrides?.docId ?? '1001',
    type: overrides?.type ?? 'Introduced',
    date: overrides?.date ?? '2025-01-01',
    mime: overrides?.mime ?? 'text/html',
    textHash: overrides?.textHash ?? 'hash-abc',
    r2Key: overrides?.r2Key ?? null,
  })
  return id
}

export async function seedRole(name: string): Promise<string> {
  const db = getDb(env.DB)
  const id = crypto.randomUUID()
  await db.insert(roles).values({ id, name })
  return id
}

export async function seedUserRole(userId: string, roleId: string): Promise<void> {
  const db = getDb(env.DB)
  await db.insert(userRoles).values({ userId, roleId })
}

export async function seedComment(
  billId: string,
  userId: string,
  content = '<p>Test comment</p>',
): Promise<string> {
  const db = getDb(env.DB)
  const id = crypto.randomUUID()
  await db.insert(comments).values({
    id,
    billId,
    userId,
    content,
    createdAt: new Date().toISOString(),
  })
  return id
}

/**
 * The stored mention notifications, flattened to the shape the old
 * comment_mentions table had, for tests that check who a comment reached and how.
 */
export async function mentionRecords(commentId?: string): Promise<Array<{
  id: string; commentId: string | null; userId: string; sourceType: 'user' | 'role' | 'admins' | 'everyone'; sourceId: string; readAt: string | null
}>> {
  const rows = await getDb(env.DB).select().from(notifications)
    .where(commentId ? and(eq(notifications.kind, 'mention'), eq(notifications.commentId, commentId)) : eq(notifications.kind, 'mention'))
    .all()
  return rows.map(r => {
    const data = JSON.parse(r.data) as { sourceType: 'user' | 'role' | 'admins' | 'everyone'; sourceId: string }
    return { id: r.id, commentId: r.commentId, userId: r.recipientId, sourceType: data.sourceType, sourceId: data.sourceId, readAt: r.readAt }
  })
}

/** Seeds a mention notification for `userId` on a comment, from the comment's author. */
export async function seedCommentMention(
  commentId: string,
  userId: string,
  overrides?: {
    sourceType?: 'user' | 'role' | 'admins'
    sourceId?: string
    readAt?: string | null
  },
): Promise<string> {
  const db = getDb(env.DB)
  const id = crypto.randomUUID()
  const comment = await db.select({ billId: comments.billId, userId: comments.userId }).from(comments).where(eq(comments.id, commentId)).get()
  if (!comment) throw new Error(`seedCommentMention: no comment ${commentId}`)
  await db.insert(notifications).values({
    id,
    recipientId: userId,
    kind: 'mention',
    billId: comment.billId,
    commentId,
    actorId: comment.userId,
    data: JSON.stringify({ sourceType: overrides?.sourceType ?? 'user', sourceId: overrides?.sourceId ?? userId }),
    readAt: overrides?.readAt ?? null,
    createdAt: new Date().toISOString(),
  })
  return id
}

export async function seedCalendarEvent(
  billId: string,
  overrides?: Partial<{
    uid: string; source: string; kind: string | null; sequence: number; date: string; time: string;
    location: string; description: string; status: 'confirmed' | 'cancelled'; eventHash: string;
  }>,
): Promise<string> {
  const db = getDb(env.DB)
  const id = crypto.randomUUID()
  await db.insert(calendarEvents).values({
    id,
    uid: overrides?.uid ?? `hearing-${billId}-${id}@test`,
    billId,
    source: overrides?.source ?? 'hearing',
    kind: overrides?.kind ?? null,
    sequence: overrides?.sequence ?? 0,
    date: overrides?.date ?? '2026-06-04',
    time: overrides?.time ?? '14:00:00',
    location: overrides?.location ?? 'Room 35',
    description: overrides?.description ?? 'House Cmte on Elections',
    status: overrides?.status ?? 'confirmed',
    eventHash: overrides?.eventHash ?? 'h1',
  })
  return id
}

export async function seedAuthEvent(
  userId: string,
  event: string,
  overrides: { email?: string; reason?: string; linkType?: string; provider?: string; messageId?: string; createdAt?: string; actorId?: string } = {},
): Promise<void> {
  const db = getDb(env.DB)
  await db.insert(authEvents).values({
    id: crypto.randomUUID(),
    userId,
    email: overrides.email ?? 'seed@b.com',
    event,
    reason: overrides.reason ?? null,
    linkType: overrides.linkType ?? null,
    provider: overrides.provider ?? null,
    messageId: overrides.messageId ?? null,
    actorId: overrides.actorId ?? null,
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  })
}
