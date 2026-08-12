import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull().default(''),
  role: text('role', { enum: ['admin', 'member', 'owner'] }).notNull().default('member'),
  subtitle: text('subtitle'),
  invitedBy: text('invited_by'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  lastActive: text('last_active').notNull().default(sql`(datetime('now'))`),
  deactivatedAt: text('deactivated_at'),
  canVote: integer('can_vote').notNull().default(1),
  emailDigestEnabled: integer('email_digest_enabled').notNull().default(1),
  emailWeekAheadEnabled: integer('email_week_ahead_enabled').notNull().default(1),
  lastSeenFeed: text('last_seen_feed'),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  lastActive: text('last_active').notNull().default(sql`(datetime('now'))`),
})

export const magicLinks = sqliteTable('magic_links', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
})

export const authEvents = sqliteTable('auth_events', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  email: text('email').notNull(),
  event: text('event').notNull(),
  reason: text('reason'),
  linkType: text('link_type'),
  provider: text('provider'),
  messageId: text('message_id'),
  userAgent: text('user_agent'),
  ipCountry: text('ip_country'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const bills = sqliteTable('bills', {
  id: text('id').primaryKey(),
  externalId: text('external_id'),
  billNumber: text('bill_number').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  status: text('status').notNull().default(''),
  session: text('session').notNull().default(''),
  sessionId: text('session_id'),
  yearStart: integer('year_start'),
  yearEnd: integer('year_end'),
  abstract: text('abstract'),
  url: text('url'),
  stateUrl: text('state_url'),
  providerUpdatedAt: text('provider_updated_at'),
  textR2Key: text('text_r2_key'),
  tenantSummary: text('tenant_summary'),
  tags: text('tags').notNull().default('[]'),
  priority: text('priority', { enum: ['high', 'medium', 'low'] }),
  sponsor: text('sponsor'),
  sponsorParty: text('sponsor_party'),
  sponsorUrl: text('sponsor_url'),
  coSponsors: text('co_sponsors'),
  lastAction: text('last_action'),
  lastActionDate: text('last_action_date'),
  history: text('history'),
  relatedBillIds: text('related_bill_ids'),
  companionBillIds: text('companion_bill_ids'),
  stateLink: text('state_link'),
  committee: text('committee'),
  matchType: text('match_type', { enum: ['keyword', 'manual'] }),
  addedBy: text('added_by'),
  // AI relevance on a 1-10 scale (NOT 0-100) — set in api/src/lib/llm.ts, clamped 1..10.
  // Any threshold, filter, or UI must use the 1-10 scale.
  relevanceScore: integer('relevance_score'),
  centralSyncedAt: text('central_synced_at'),
  aiProcessedAt: text('ai_processed_at'),
  lastAiTextHash: text('last_ai_text_hash'),
  lastAiTextDocId: text('last_ai_text_doc_id'),
  aiSkipReason: text('ai_skip_reason'),
  // Transient AI failures (provider outage, exhausted AI Gateway credits, bad
  // token). Distinct from aiSkipReason, which means the document itself is
  // permanently unprocessable. Without these, a failed bill looks exactly like
  // one that was never queued — the same ambiguity central's bill_texts
  // .fetch_attempted_at/.fetch_error exist to prevent.
  aiAttemptedAt: text('ai_attempted_at'),
  aiError: text('ai_error'),
  textStatus: text('text_status'),
  newMatchAt: text('new_match_at'),
  triagedAt: text('triaged_at'),
  triagedBy: text('triaged_by'),
  isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
  draftText: text('draft_text'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const memberVotes = sqliteTable('member_votes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  billId: text('bill_id').notNull(),
  position: text('position', { enum: ['support', 'oppose', 'neutral'] }).notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const officialPositions = sqliteTable('official_positions', {
  id: text('id').primaryKey(),
  billId: text('bill_id').notNull().unique(),
  position: text('position').notNull(),
  notes: text('notes'),
  setBy: text('set_by').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  billId: text('bill_id').notNull(),
  userId: text('user_id').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),
  deletedBy: text('deleted_by'),
})

export const commentReactions = sqliteTable('comment_reactions', {
  id: text('id').primaryKey(),
  commentId: text('comment_id').notNull(),
  userId: text('user_id').notNull(),
  emoji: text('emoji').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),
}, (t) => ({
  uniqReaction: uniqueIndex('comment_reactions_comment_user_emoji_unique').on(t.commentId, t.userId, t.emoji),
}))

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  billId: text('bill_id').notNull(),
  userId: text('user_id').notNull(),
  content: text('content').notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  uniqNote: uniqueIndex('notes_bill_user_unique').on(t.billId, t.userId),
}))

export const feedEvents = sqliteTable('feed_events', {
  id: text('id').primaryKey(),
  type: text('type', {
    enum: ['bill_added', 'priority_set', 'position_set', 'comment_added', 'vote_milestone', 'bill_updated', 'hearing_added', 'hearing_changed', 'hearing_cancelled', 'bill_matched'],
  }).notNull(),
  billId: text('bill_id').notNull(),
  userId: text('user_id').notNull(),
  metadata: text('metadata').notNull().default('{}'),
  suppressed: integer('suppressed', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const publicReports = sqliteTable('public_reports', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  billIds: text('bill_ids').notNull().default('[]'),
  generatedBy: text('generated_by').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  expiresAt: text('expires_at'),
})

export const associationConfig = sqliteTable('association_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const billTexts = sqliteTable('bill_texts', {
  id: text('id').primaryKey(),
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  docId: text('doc_id').notNull().unique(),
  type: text('type').notNull(),
  date: text('date').notNull(),
  mime: text('mime').notNull().default('text/html'),
  textHash: text('text_hash').notNull().default(''),
  r2Key: text('r2_key'),
  stateLink: text('state_link'),
  altStateLink: text('alt_state_link'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),
  deletedBy: text('deleted_by'),
})

export const userRoles = sqliteTable('user_roles', {
  userId: text('user_id').notNull(),
  roleId: text('role_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.roleId] }),
}))

export const customFieldDefinitions = sqliteTable('custom_field_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug'),
  type: text('type').notNull(),
  options: text('options'),
  multiple: integer('multiple', { mode: 'boolean' }).notNull().default(false),
  displayOrder: integer('display_order').notNull().default(0),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const billCustomFieldValues = sqliteTable('bill_custom_field_values', {
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  fieldId: text('field_id').notNull().references(() => customFieldDefinitions.id, { onDelete: 'cascade' }),
  value: text('value').notNull(),
  setBy: text('set_by').notNull().references(() => users.id),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: primaryKey({ columns: [t.billId, t.fieldId] }),
}))

export const calendarEvents = sqliteTable('calendar_events', {
  id: text('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  billId: text('bill_id'),
  source: text('source').notNull().default('hearing'),
  sequence: integer('sequence').notNull().default(0),
  date: text('date'),
  time: text('time'),
  location: text('location'),
  description: text('description'),
  details: text('details'),
  url: text('url'),
  status: text('status', { enum: ['confirmed', 'cancelled'] }).notNull().default('confirmed'),
  eventHash: text('event_hash'),
  // Creator's browser IANA zone (custom events); ICS-feed fallback when no state resolves.
  timezone: text('timezone'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const calendarEventBills = sqliteTable('calendar_event_bills', {
  eventId: text('event_id').notNull(),
  billId: text('bill_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.eventId, t.billId] }),
}))

export const commentMentions = sqliteTable('comment_mentions', {
  id: text('id').primaryKey(),
  commentId: text('comment_id').notNull().references(() => comments.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceType: text('source_type', { enum: ['user', 'role', 'everyone'] }).notNull(),
  sourceId: text('source_id').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  readAt: text('read_at'),
})
