/// <reference types="vite/client" />
import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { getDb } from '../src/db/client'
import { generateToken, hashToken } from '../src/lib/crypto'
import { users, sessions, magicLinks, bills, billTexts, roles, userRoles, comments, commentMentions, calendarEvents, authEvents } from '../src/db/schema'

// Every file in api/migrations/, so a new migration is applied by the tests the
// moment it lands, with no list to update. test/migrations/allApplied.test.ts
// fails if any file is left out.
const migrationFiles = import.meta.glob<string>('../migrations/*.sql', { query: '?raw', import: 'default', eager: true })

export function parseMigration(sql: string, name: string) {
  return { name, queries: splitStatements(sql) }
}

// Split a migration into statements on `;`, dropping `--` and `/* */`
// comments first and ignoring semicolons inside quotes, so a `;` in a comment
// can't break it the way it breaks parseMigration. The same splitter central's
// tests use (central/test/helpers/migrations.ts). Not handled: a CREATE
// TRIGGER body, whose own semicolons would be split apart.
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: string | null = null
  const flush = () => {
    const s = current.trim()
    if (s.length > 0) statements.push(s + ';')
    current = ''
  }
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (quote) {
      current += c
      if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c
      current += c
    } else if (c === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i)
      i = eol === -1 ? sql.length : eol - 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 1
    } else if (c === ';') {
      flush()
    } else {
      current += c
    }
  }
  flush()
  return statements
}

/**
 * Migration files keyed by path, valued by raw SQL (what
 * import.meta.glob(..., { query: '?raw', import: 'default', eager: true })
 * returns), as migrations in filename order, each named by its basename
 * without the extension, like applyMigrations' names. For building a database
 * from a whole folder, such as a fork's (test/migrations/forkUpgrade.test.ts).
 */
export function migrationsFromFiles(files: Record<string, string>): { name: string; queries: string[] }[] {
  return Object.entries(files)
    .map(([path, sql]) => ({ name: path.split('/').pop()!.replace(/\.sql$/, ''), sql }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sql }) => ({ name, queries: splitStatements(sql) }))
}

export async function resetDb(): Promise<void> {
  await reset()
}

/**
 * Apply every migration. With `before`, apply only those whose names sort
 * before it, so a test can seed rows as an older database holds them and then
 * call applyMigrations() again to run the rest over them.
 */
export async function applyMigrations(opts: { before?: string } = {}): Promise<void> {
  const migrations = migrationsFromFiles(migrationFiles)
  const before = opts.before
  await applyD1Migrations(env.DB, before ? migrations.filter(m => m.name < before) : migrations)
}

export async function seedUser(overrides?: {
  role?: 'admin' | 'member' | 'owner'
  email?: string
  name?: string
  subtitle?: string
  canVote?: boolean
  emailDigestEnabled?: boolean
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
    subtitle: overrides?.subtitle ?? null,
    canVote: overrides?.canVote === false ? 0 : 1,
    emailDigestEnabled: overrides?.emailDigestEnabled === false ? 0 : 1,
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
  triagedAt?: string | null
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
    triagedAt: overrides?.triagedAt ?? null,
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

export async function seedCommentMention(
  commentId: string,
  userId: string,
  overrides?: {
    sourceType?: 'user' | 'role'
    sourceId?: string
    readAt?: string | null
  },
): Promise<string> {
  const db = getDb(env.DB)
  const id = crypto.randomUUID()
  await db.insert(commentMentions).values({
    id,
    commentId,
    userId,
    sourceType: overrides?.sourceType ?? 'user',
    sourceId: overrides?.sourceId ?? userId,
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
  overrides: { email?: string; reason?: string; linkType?: string; provider?: string; messageId?: string; createdAt?: string } = {},
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
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  })
}
