import { sqliteTable, text, integer, primaryKey, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { EventSource } from '../../../shared/eventSource'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull().default(''),
  role: text('role', { enum: ['admin', 'member', 'owner'] }).notNull().default('member'),
  title: text('title'),
  // The old name for `title`, kept in sync until the drop migration (follow-up issue), so the previous build still works if a deploy is rolled back.
  subtitle: text('subtitle'),
  invitedBy: text('invited_by'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  lastActive: text('last_active').notNull().default(sql`(datetime('now'))`),
  deactivatedAt: text('deactivated_at'),
  canVote: integer('can_vote').notNull().default(1),
  emailDigestEnabled: integer('email_digest_enabled').notNull().default(1),
  emailDigestMatchesEnabled: integer('email_digest_matches_enabled').notNull().default(1),
  emailWeekAheadEnabled: integer('email_week_ahead_enabled').notNull().default(1),
  emailRepliesEnabled: integer('email_replies_enabled').notNull().default(1),
  lastSeenFeed: text('last_seen_feed'),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  lastActive: text('last_active').notNull().default(sql`(datetime('now'))`),
})

// One row per acceptance of the Legal Terms (migration 0069). Append-only:
// re-acceptance after a LEGAL_TERMS_UPDATED bump is an INSERT, never an UPDATE,
// so the record of which text a user accepted previously survives.
export const termsAcceptances = sqliteTable('terms_acceptances', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  // The LEGAL_TERMS_UPDATED value accepted against. YYYY-MM-DD, compared
  // lexicographically -- never wrap either side in datetime().
  termsUpdated: text('terms_updated').notNull(),
  acceptedAt: text('accepted_at').notNull(),
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
  // Who caused the event when it isn't the member it's about (migration 0075).
  actorId: text('actor_id'),
})

// A member's pending change of sign-in email (migration 0086). At most one per
// member. Deleted when it is confirmed or cancelled, which makes its token
// single use. See lib/emailChange.ts.
export const emailChanges = sqliteTable('email_changes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  oldEmail: text('old_email').notNull(),
  newEmail: text('new_email').notNull(),
  requestedBy: text('requested_by').notNull(),
  // The session a self-service request came from, kept signed in at commit.
  requestingSessionId: text('requesting_session_id'),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

// The "This wasn't me" tokens of an email change's old-address notices
// (migration 0090). Single use: pressing one deletes every row for its change.
// See lib/emailChangeReport.ts.
export const emailChangeReports = sqliteTable('email_change_reports', {
  id: text('id').primaryKey(),
  // The email_changes row the notice was about. That row may be gone by now.
  changeId: text('change_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  oldEmail: text('old_email').notNull(),
  newEmail: text('new_email').notNull(),
  requestedBy: text('requested_by').notNull(),
  requestedAt: text('requested_at').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

// Per-hour, per-provider send counters for the email-health job (migration 0073).
// Covers every send, bulk included. `suppressed` holds recipient-specific
// failures and is never counted in `failed`.
export const emailSendStats = sqliteTable('email_send_stats', {
  hour: text('hour').notNull(),               // 'YYYY-MM-DD HH:00:00', UTC
  provider: text('provider').notNull(),       // 'cloudflare' | 'resend'
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  suppressed: integer('suppressed').notNull().default(0),
  lastError: text('last_error'),
  lastSentAt: text('last_sent_at'),
  lastFailedAt: text('last_failed_at'),
}, (t) => [
  primaryKey({ columns: [t.hour, t.provider] }),
])

// One row per provider: the email-health job's memory between hourly runs.
// A missing row means 'ok'.
export const emailAlertState = sqliteTable('email_alert_state', {
  provider: text('provider').primaryKey(),
  status: text('status', { enum: ['ok', 'failing'] }).notNull().default('ok'),
  failingSince: text('failing_since'),
  lastAlertedAt: text('last_alerted_at'),
  recoveredAt: text('recovered_at'),
})

export const bills = sqliteTable('bills', {
  id: text('id').primaryKey(),
  externalId: text('external_id'),
  billNumber: text('bill_number').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  status: text('status').notNull().default(''),
  // The status's common stage and its sort rank, as central sends them from
  // the provider's vocabulary (migration 0076). The bill list filters on the
  // stage and sorts status by rank. No stage and rank 0 for a draft or a
  // status central has no vocabulary entry for.
  statusStage: text('status_stage'),
  statusRank: integer('status_rank').notNull().default(0),
  session: text('session').notNull().default(''),
  sessionId: text('session_id'),
  // The SESSION in /STATE/SESSION/BILL, as central assigned it (unique within
  // the state). Null for a bill central hasn't sent one for: lib/sessionSlug.ts
  // computes it from `session` then.
  sessionSlug: text('session_slug'),
  yearStart: integer('year_start'),
  yearEnd: integer('year_end'),
  abstract: text('abstract'),
  url: text('url'),
  stateUrl: text('state_url'),
  providerUpdatedAt: text('provider_updated_at'),
  textR2Key: text('text_r2_key'),
  // Anything that edits this by hand must also run pruneClaimSources (lib/claimResolution.ts) on claim_sources.
  tenantSummary: text('tenant_summary'),
  tags: text('tags').notNull().default('[]'),
  // Statutory citations the bill affects, verbatim as printed. See
  // migrations/0066_affected_citations.sql for why these are not normalised.
  affectedCitations: text('affected_citations').notNull().default('[]'),
  // Claim sources from the analysis (#568): a JSON array of {claim, quote} or,
  // for a PDF, {claim, quote, page}, pinned to the document the model read.
  // All three null when the bill has none. See migrations/0108_claim_sources.sql.
  claimSources: text('claim_sources'),
  claimSourcesDocId: text('claim_sources_doc_id'),
  claimSourcesTextHash: text('claim_sources_text_hash'),
  priority: text('priority', { enum: ['high', 'medium', 'low'] }),
  // When the priority was last set (migration 0101). A companion group reads
  // its priority from the member where it was set most recently.
  prioritySetAt: text('priority_set_at'),
  sponsor: text('sponsor'),
  sponsorParty: text('sponsor_party'),
  sponsorUrl: text('sponsor_url'),
  coSponsors: text('co_sponsors'),
  lastAction: text('last_action'),
  lastActionDate: text('last_action_date'),
  history: text('history'),
  subjects: text('subjects'),
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
  // aiError has NO reader in application code, and that is deliberate — do not
  // "clean up" an unread column. It is the only per-bill record of *why* AI
  // failed, and its reader is a human running a query when the ops dashboard
  // shows bills stuck: `SELECT bill_number, ai_heal_attempts, ai_error FROM
  // bills WHERE ai_attempted_at IS NOT NULL AND ai_processed_at IS NULL AND
  // ai_skip_reason IS NULL`. That is the same role bill_texts.fetch_error
  // plays, which the comment above already cites as this pair's model.
  //
  // It is deliberately NOT load-bearing: it is free-text that gets reworded, so
  // nothing may parse it. When the self-healing sweep needed "how many have we
  // given up on" as a SQL question, that became its own integer column
  // (aiHealAttempts, migration 0067) rather than a regex over this string.
  aiError: text('ai_error'),
  // Times the self-healing sweep has re-queued this bill (migration 0067).
  // Cleared on successful AI processing; at 5 the bill is left for a human.
  //
  // DO NOT use this column to ask "did the heal run?" — it cannot answer that.
  // Because a success resets it to 0, a bill the heal rescued and a bill the
  // heal never touched are indistinguishable here, so `WHERE ai_heal_attempts
  // > 0` returning nothing is what a *working* heal looks like. It reads as a
  // dead feature and it fooled us once already. A non-zero value means only
  // "currently mid-recovery", and 5 means "gave up".
  //
  // To ask whether the heal did something, group processed bills by hour and
  // look for a spike on the hour (the sweep is hourly, `0 * * * *`):
  //   SELECT substr(ai_processed_at, 1, 13), COUNT(*) FROM bills
  //   WHERE ai_processed_at IS NOT NULL GROUP BY 1 ORDER BY 1 DESC
  // To ask what is still stuck, use the predicate in lib/healStalledAi.ts.
  aiHealAttempts: integer('ai_heal_attempts').notNull().default(0),
  textStatus: text('text_status'),
  newMatchAt: text('new_match_at'),
  // Where the keyword match came from, as central declared it (MatchProvenance
  // in types.ts). NULL, for any match made before central declared one, counts
  // as bulk. Holds the latest declaration until the match is recorded
  // (new_match_at), then never changes.
  matchProvenance: text('match_provenance', { enum: ['routine', 'bulk'] }),
  triagedAt: text('triaged_at'),
  triagedBy: text('triaged_by'),
  isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
  draftText: text('draft_text'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  // The bill's companion group: the smallest id among the bills linked to it by
  // identical relationships, or null for a bill with none in this instance
  // (migration 0100). Written only by lib/companionGroups.ts.
  groupKey: text('group_key'),
  // The tags of the bill's companion group's current analysis, or its own tags
  // when it's in no group, as a JSON array (migration 0103). A tag filter tests
  // these. Written only by the triggers 0106 recreates, never by the app.
  groupTags: text('group_tags').notNull().default('[]'),
  // The key central serves for title-matched companion suggestions (#521):
  // the bill's type and normalized title, or null when no suggestion can come
  // from it. With `chamber`, the bill's chamber as central sends it, written on
  // every delivery (lib/companionSuggestion.ts). Indexed with state and session
  // for bills that have one (migration 0110).
  titleKey: text('title_key'),
  chamber: text('chamber'),
})

// Identical relationships, as central's vocabulary reads them, by bill handle
// on both sides (migration 0100). One row per bill naming a companion, so a
// companion the instance doesn't hold yet is still remembered. Companion groups
// are computed from these in either direction. Written only by
// lib/companionGroups.ts.
export const billIdenticalLinks = sqliteTable('bill_identical_links', {
  externalId: text('external_id').notNull(),
  companionExternalId: text('companion_external_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.externalId, t.companionExternalId] }),
  index('idx_bill_identical_links_companion').on(t.companionExternalId),
])

// An admin's overrides of companion groups (migration 0104), one row per pair
// of bills, smaller id first: `link` groups the two as an identical link would,
// and `split` removes any identical link between them. The group recompute
// reads them with the provider's links on every sync (lib/companionGroups.ts).
export const billGroupOverrides = sqliteTable('bill_group_overrides', {
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  otherBillId: text('other_bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['link', 'split'] }).notNull(),
  actorUserId: text('actor_user_id'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  primaryKey({ columns: [t.billId, t.otherBillId] }),
  index('idx_bill_group_overrides_other').on(t.otherBillId),
])

// An admin's dismissal of a title-matched companion suggestion (#521), kept per
// instance as a pair of bills, smaller id first, like a group override
// (migration 0110). The pair is never suggested again.
export const companionSuggestionDismissals = sqliteTable('companion_suggestion_dismissals', {
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  otherBillId: text('other_bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  primaryKey({ columns: [t.billId, t.otherBillId] }),
  index('idx_companion_suggestion_dismissals_other').on(t.otherBillId),
])

// Structured events about a bill's team-level state, one row per bill (migration
// 0100): a companion group forming or splitting so far. `type` has no CHECK
// constraint, so a new kind of event needs no table rebuild. A null actor
// means FloorVote did it automatically. Metadata is per type: see
// shared/companionGroups.ts for grouping events.
export const teamEvents = sqliteTable('team_events', {
  id: text('id').primaryKey(),
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  actorUserId: text('actor_user_id'),
  metadata: text('metadata').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('idx_team_events_bill').on(t.billId, t.createdAt),
])

export const billSubjects = sqliteTable('bill_subjects', {
  billId:      text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  subjectName: text('subject_name').notNull(),
  state:       text('state').notNull(),
}, (t) => [
  primaryKey({ columns: [t.billId, t.subjectName] }),
  index('idx_bill_subjects_name').on(t.state, t.subjectName),
])

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
    enum: ['bill_added', 'priority_set', 'position_set', 'comment_added', 'vote_milestone', 'bill_updated', 'hearing_added', 'hearing_changed', 'hearing_cancelled', 'bill_matched', 'new_matches'],
  }).notNull(),
  // Null for an event about no single bill (a bulk edit, and later instance-level
  // events). Such an event keeps what it is about in `metadata`, and survives the
  // deletion of any bill, which cascades only the events that point at it.
  billId: text('bill_id'),
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

export const savedViews = sqliteTable('saved_views', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Serialized filter params, exactly as the bill list's URL carries them.
  // Stored opaque so any filter added later is covered with no schema change —
  // the cost is that a clause can outlive what it references, which the read
  // path tolerates rather than reporting (see the design doc).
  query: text('query').notNull(),
  // Human-readable identifier for the bookmark URL (?view=clerk-bills). Nullable
  // because rows created before this column existed have none yet; savedViewsApi's
  // GET / backfills them on read, the same way customFieldsApi backfills field slugs.
  slug: text('slug'),
  // The slug this view had before its most recent rename, kept so a bookmark taken
  // under the old name still resolves. See the PUT /admin/views/:id handler.
  previousSlug: text('previous_slug'),
  // Shared org content authored by a user, not user-owned data: it must outlive
  // its author, so departing admins leave their views behind as authorless.
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

// A member's inclusion of a saved view in their email digest (#449). One row per
// member and view, which a delete of either removes. The view's filter stays on
// the view, so an edit to it carries through to everyone who included it.
export const savedViewSubscriptions = sqliteTable('saved_view_subscriptions', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  viewId: text('view_id').notNull().references(() => savedViews.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.viewId] }),
}))

export const calendarEvents = sqliteTable('calendar_events', {
  id: text('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  billId: text('bill_id'),
  // 'hearing': a bill's calendar entry, from central. 'custom': the instance's
  // own. 'body': an event on a legislature's own calendar, from central
  // (lib/bodyEvents.ts), which links its agenda bills in calendar_event_bills.
  // A date custom field's event (source 'field') is never stored: it's
  // projected from bill_custom_field_values at read time (lib/dateFieldEvents.ts).
  source: text('source').$type<EventSource>().notNull().default('hearing'),
  // A bill calendar entry's kind, as central sent it: 'hearing', 'markup',
  // 'meeting', or 'deadline' (shared/calendarKinds.ts). Null for custom
  // events, and for an entry central hasn't sent since migration 0079.
  kind: text('kind'),
  // The calendar UID of the body event central says covers this bill entry
  // (migration 0082): the entry is shown as that event, so a hearing appears
  // once. Null for an entry nothing covers, and for every other event.
  coveredBy: text('covered_by'),
  // A body event's committee, kind, type, title, and agenda topics, as JSON
  // (shared/eventRules.ts EventFacets), for the instance's event rules
  // (migration 0083, lib/eventRules.ts). Null for every other event.
  ruleFacets: text('rule_facets'),
  // Whether the instance's event rules select this body event: null while the
  // instance has none (it shows), 1 (it shows), or 0 (it's hidden).
  ruleMatch: integer('rule_match'),
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

/** A mention notification's kind-specific data: how the mention reached the recipient. */
export type MentionNotificationData = {
  sourceType: 'user' | 'role' | 'admins' | 'everyone'
  /** The user, the role, or 'all' for @everyone. */
  sourceId: string
}

/** A reply notification carries no data of its own: the comment and its author say it all. */
export type ReplyNotificationData = Record<string, never>

/** A reaction notification's kind-specific data: which emoji was used. */
export type ReactionNotificationData = {
  emoji: string
}

/**
 * The notifications inbox: one row per event a member is notified about, of a
 * `kind` ('mention', 'reply', or 'reaction'). Rows are written when the event happens and
 * never recomputed from comments. Rows for deleted comments are hidden at read
 * time, not deleted. Writers and renderers per kind live in lib/notifications.ts.
 */
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['mention', 'reply', 'reaction'] }).notNull(),
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  // Nullable for a future kind about a bill alone (no comment). Every kind so far has one.
  commentId: text('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Kind-specific JSON, e.g. MentionNotificationData for a mention. */
  data: text('data').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  readAt: text('read_at'),
})

export type NotificationKind = typeof notifications.$inferSelect['kind']

/**
 * Bills whose comments a member muted (#355). A muted bill sends that member no
 * reply notifications, in the app or by email. Mentions still reach them.
 * Muting works whether or not the member has commented on the bill.
 */
export const billMutes = sqliteTable('bill_mutes', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  primaryKey({ columns: [t.userId, t.billId] }),
  index('idx_bill_mutes_bill').on(t.billId),
])
