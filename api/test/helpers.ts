import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { getDb } from '../src/db/client'
import { generateToken, hashToken } from '../src/lib/crypto'
import { users, sessions, magicLinks, bills, billTexts, roles, userRoles, comments, commentMentions, calendarEvents, authEvents } from '../src/db/schema'
import migrationSql1 from '../migrations/0001_initial.sql?raw'
import migrationSql2 from '../migrations/0002_bill_ingestion.sql?raw'
import migrationSql3 from '../migrations/0003_member_ui.sql?raw'
import migrationSql4 from '../migrations/0004_admin.sql?raw'
import migrationSql5 from '../migrations/0005_legiscan_expansion.sql?raw'
import migrationSql6 from '../migrations/0006_sponsor_url.sql?raw'
import migrationSql7 from '../migrations/0007_session_year.sql?raw'
import migrationSql8 from '../migrations/0008_full_legiscan_capture.sql?raw'
import migrationSql9 from '../migrations/0009_bill_calendar_composite_unique.sql?raw'
import migrationSql10 from '../migrations/0010_central_columns.sql?raw'
import migrationSql11 from '../migrations/0011_rename_summary_columns.sql?raw'
import migrationSql12 from '../migrations/0012_drop_generic_summary.sql?raw'
import migrationSql13 from '../migrations/0013_central_synced_at.sql?raw'
import migrationSql14 from '../migrations/0014_ai_processed_at.sql?raw'
import migrationSql15 from '../migrations/0015_last_ai_text_hash.sql?raw'
import migrationSql16 from '../migrations/0016_feed_events_bill_updated.sql?raw'
import migrationSql17 from '../migrations/0017_roles.sql?raw'
import migrationSql18 from '../migrations/0018_can_vote.sql?raw'
import migrationSql19 from '../migrations/0019_owner_role_and_soft_delete.sql?raw'
import migrationSql20 from '../migrations/0020_owner_role_check.sql?raw'
import migrationSql21 from '../migrations/0021_custom_fields.sql?raw'
import migrationSql22 from '../migrations/0022_custom_field_slugs.sql?raw'
import migrationSql23 from '../migrations/0023_comment_mentions.sql?raw'
import migrationSql24 from '../migrations/0024_comment_mention_indexes.sql?raw'
import migrationSql25 from '../migrations/0025_openstates_tenant.sql?raw'
import migrationSql26 from '../migrations/0026_comment_reactions_unique.sql?raw'
import migrationSql27 from '../migrations/0027_bills_list_indexes.sql?raw'
import migrationSql28 from '../migrations/0028_bills_external_id_unique.sql?raw'
import migrationSql29 from '../migrations/0029_bills_is_stub.sql?raw'
import migrationSql30 from '../migrations/0030_last_ai_text_doc_id.sql?raw'
import migrationSql31 from '../migrations/0031_bill_match_type.sql?raw'
import migrationSql32 from '../migrations/0032_text_status.sql?raw'
import migrationSql33 from '../migrations/0033_year_columns.sql?raw'
import migrationSql34 from '../migrations/0034_comment_mention_read_at.sql?raw'
import migrationSql35 from '../migrations/0035_role_soft_delete.sql?raw'
import migrationSql36 from '../migrations/0036_partial_role_name_index.sql?raw'
import migrationSql37 from '../migrations/0037_pinned_custom_field.sql?raw'
import migrationSql38 from '../migrations/0038_drop_is_stub.sql?raw'
import migrationSql39 from '../migrations/0039_ai_skip_reason.sql?raw'
import migrationSql40 from '../migrations/0040_custom_field_multiple.sql?raw'
import migrationSql41 from '../migrations/0041_comment_mentions_everyone.sql?raw'
import migrationSql42 from '../migrations/0042_calendar_events.sql?raw'
import migrationSql43 from '../migrations/0043_feed_events_hearing_types.sql?raw'
import migrationSql44 from '../migrations/0044_email_digest_enabled.sql?raw'
import migrationSql45 from '../migrations/0045_calendar_event_bills.sql?raw'
import migrationSql46 from '../migrations/0046_add_last_seen_feed.sql?raw'
import migrationSql47 from '../migrations/0047_draft_bills.sql?raw'
import migrationSql48 from '../migrations/0048_calendar_event_timezone.sql?raw'
import migrationSql50 from '../migrations/0050_calendar_event_details_url.sql?raw'
import migrationSql51 from '../migrations/0051_email_week_ahead.sql?raw'
import migrationSql52 from '../migrations/0052_new_match_columns.sql?raw'
import migrationSql53 from '../migrations/0053_feed_events_bill_matched.sql?raw'
import migrationSql55 from '../migrations/0055_auth_events.sql?raw'
import migrationSql56 from '../migrations/0056_auth_events_unknown_email.sql?raw'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0)
    .map((s) => s + ';')
  return { name, queries }
}

export async function resetDb(): Promise<void> {
  await reset()
}

export async function applyMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, [
    parseMigration(migrationSql1, '0001_initial'),
    parseMigration(migrationSql2, '0002_bill_ingestion'),
    parseMigration(migrationSql3, '0003_member_ui'),
    parseMigration(migrationSql4, '0004_admin'),
    parseMigration(migrationSql5, '0005_legiscan_expansion'),
    parseMigration(migrationSql6, '0006_sponsor_url'),
    parseMigration(migrationSql7, '0007_session_year'),
    parseMigration(migrationSql8, '0008_full_legiscan_capture'),
    parseMigration(migrationSql9, '0009_bill_calendar_composite_unique'),
    parseMigration(migrationSql10, '0010_central_columns'),
    parseMigration(migrationSql11, '0011_rename_summary_columns'),
    parseMigration(migrationSql12, '0012_drop_generic_summary'),
    parseMigration(migrationSql13, '0013_central_synced_at'),
    parseMigration(migrationSql14, '0014_ai_processed_at'),
    parseMigration(migrationSql15, '0015_last_ai_text_hash'),
    parseMigration(migrationSql16, '0016_feed_events_bill_updated'),
    parseMigration(migrationSql17, '0017_roles'),
    parseMigration(migrationSql18, '0018_can_vote'),
    parseMigration(migrationSql19, '0019_owner_role_and_soft_delete'),
    parseMigration(migrationSql20, '0020_owner_role_check'),
    parseMigration(migrationSql21, '0021_custom_fields'),
    parseMigration(migrationSql22, '0022_custom_field_slugs'),
    parseMigration(migrationSql23, '0023_comment_mentions'),
    parseMigration(migrationSql24, '0024_comment_mention_indexes'),
    parseMigration(migrationSql25, '0025_openstates_tenant'),
    parseMigration(migrationSql26, '0026_comment_reactions_unique'),
    parseMigration(migrationSql27, '0027_bills_list_indexes'),
    parseMigration(migrationSql28, '0028_bills_external_id_unique'),
    parseMigration(migrationSql29, '0029_bills_is_stub'),
    parseMigration(migrationSql30, '0030_last_ai_text_doc_id'),
    parseMigration(migrationSql31, '0031_bill_match_type'),
    parseMigration(migrationSql32, '0032_text_status'),
    parseMigration(migrationSql33, '0033_year_columns'),
    parseMigration(migrationSql34, '0034_comment_mention_read_at'),
    parseMigration(migrationSql35, '0035_role_soft_delete'),
    parseMigration(migrationSql36, '0036_partial_role_name_index'),
    parseMigration(migrationSql37, '0037_pinned_custom_field'),
    parseMigration(migrationSql38, '0038_drop_is_stub'),
    parseMigration(migrationSql39, '0039_ai_skip_reason'),
    parseMigration(migrationSql40, '0040_custom_field_multiple'),
    parseMigration(migrationSql41, '0041_comment_mentions_everyone'),
    parseMigration(migrationSql42, '0042_calendar_events'),
    parseMigration(migrationSql43, '0043_feed_events_hearing_types'),
    parseMigration(migrationSql44, '0044_email_digest_enabled'),
    parseMigration(migrationSql45, '0045_calendar_event_bills'),
    parseMigration(migrationSql46, '0046_add_last_seen_feed'),
    parseMigration(migrationSql47, '0047_draft_bills'),
    parseMigration(migrationSql48, '0048_calendar_event_timezone'),
    // 0049 is a data-cleanup DELETE; the raw import can't be parsed by parseMigration due to a
    // semicolon inside a comment line. Provide it inline — the test DB starts empty so the DELETE
    // is a safe no-op, and the table structure is identical either way.
    { name: '0049_remove_dead_config_keys', queries: ["DELETE FROM association_config WHERE key IN ('allowed_domains', 'reaction_emojis');"] },
    parseMigration(migrationSql50, '0050_calendar_event_details_url'),
    parseMigration(migrationSql51, '0051_email_week_ahead'),
    parseMigration(migrationSql52, '0052_new_match_columns'),
    parseMigration(migrationSql53, '0053_feed_events_bill_matched'),
    // 0054 uses UPDATE with a comment containing semicolon-like prose; provide inline to avoid
    // parseMigration splitting issues. The test DB starts empty so the UPDATE is a safe no-op.
    { name: '0054_floorvote_ical_uids', queries: ["UPDATE calendar_events SET uid = replace(uid, '@example.org', '@example.com') WHERE uid LIKE '%@example.org';"] },
    parseMigration(migrationSql55, '0055_auth_events'),
    parseMigration(migrationSql56, '0056_auth_events_unknown_email'),
    // 0057 has a semicolon inside a comment ("efficiently; the covering"), which breaks
    // parseMigration's naive split. Provide the three statements inline.
    { name: '0057_match_type_index', queries: [
      "CREATE INDEX IF NOT EXISTS idx_bills_match_type ON bills(match_type);",
      "CREATE INDEX IF NOT EXISTS idx_bills_tracked_cover ON bills(status, priority, state, year_start, session, relevance_score, last_action_date) WHERE match_type IS NOT NULL;",
      "ANALYZE;",
    ] },
  ])
}

export async function seedUser(overrides?: {
  role?: 'admin' | 'member' | 'owner'
  email?: string
  name?: string
  subtitle?: string
  canVote?: boolean
  emailDigestEnabled?: boolean
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
  billNumber?: string
  title?: string
  state?: string
  status?: string
  session?: string
  sessionId?: string
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
  triageDismissedAt?: string | null
}): Promise<string> {
  const db = getDb(env.DB)
  const id = crypto.randomUUID()
  await db.insert(bills).values({
    id,
    externalId: overrides?.externalId ?? null,
    billNumber: overrides?.billNumber ?? 'HB 1',
    title: overrides?.title ?? 'Test Bill',
    state: overrides?.state ?? 'RI',
    status: overrides?.status ?? '',
    session: overrides?.session ?? '2026 Regular Session',
    sessionId: overrides?.sessionId ?? 'ri:2026',
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
    matchType: overrides && 'matchType' in overrides ? overrides.matchType : 'keyword',
    textStatus: overrides?.textStatus ?? null,
    yearStart: overrides?.yearStart ?? null,
    yearEnd: overrides?.yearEnd ?? null,
    isDraft: overrides?.isDraft ?? false,
    draftText: overrides?.draftText ?? null,
    newMatchAt: overrides?.newMatchAt ?? null,
    triageDismissedAt: overrides?.triageDismissedAt ?? null,
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
    uid: string; source: string; sequence: number; date: string; time: string;
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
  overrides: { email?: string; reason?: string; linkType?: string } = {},
): Promise<void> {
  const db = getDb(env.DB)
  await db.insert(authEvents).values({
    id: crypto.randomUUID(),
    userId,
    email: overrides.email ?? 'seed@b.com',
    event,
    reason: overrides.reason ?? null,
    linkType: overrides.linkType ?? null,
  })
}
