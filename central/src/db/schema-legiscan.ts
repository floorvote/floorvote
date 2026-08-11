import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const sessions = sqliteTable('sessions', {
  sessionId:    integer('session_id').primaryKey(),
  state:        text('state').notNull(),
  stateId:      integer('state_id').notNull(),
  yearStart:    integer('year_start').notNull(),
  yearEnd:      integer('year_end').notNull(),
  prefile:      integer('prefile').notNull().default(0),
  sineDie:      integer('sine_die').notNull().default(0),
  prior:        integer('prior').notNull().default(0),
  special:      integer('special').notNull().default(0),
  sessionTag:   text('session_tag').notNull().default(''),
  sessionTitle: text('session_title').notNull(),
  sessionName:  text('session_name').notNull(),
  lastSyncedAt: text('last_synced_at'),
  syncEnabled:     integer('sync_enabled', { mode: 'boolean' }).notNull().default(true),
  fullSyncHoursEt: text('full_sync_hours_et'),
  rawSyncHoursEt:  text('raw_sync_hours_et'),
})

export const people = sqliteTable('people', {
  peopleId:      integer('people_id').primaryKey(),
  personHash:    text('person_hash'),
  stateId:       integer('state_id'),
  partyId:       text('party_id'),
  party:         text('party'),
  roleId:        integer('role_id'),
  role:          text('role'),
  name:          text('name').notNull(),
  firstName:     text('first_name'),
  middleName:    text('middle_name'),
  lastName:      text('last_name'),
  suffix:        text('suffix'),
  nickname:      text('nickname'),
  district:      text('district'),
  ftmEid:        integer('ftm_eid'),
  votesmartId:   integer('votesmart_id'),
  opensecretsId: text('opensecrets_id'),
  knowwhoPid:    integer('knowwho_pid'),
  ballotpedia:   text('ballotpedia'),
  bioguideId:    text('bioguide_id'),
  bioJson:       text('bio_json'),
})

export const bills = sqliteTable('bills', {
  billId:            integer('bill_id').primaryKey(),
  changeHash:        text('change_hash').notNull(),
  sessionId:         integer('session_id').notNull(),
  state:             text('state').notNull(),
  stateId:           integer('state_id').notNull(),
  billNumber:        text('bill_number').notNull(),
  billType:          text('bill_type').notNull().default('B'),
  billTypeId:        text('bill_type_id').notNull().default('1'),
  body:              text('body').notNull().default(''),
  bodyId:            integer('body_id').notNull().default(0),
  currentBody:       text('current_body').notNull().default(''),
  currentBodyId:     integer('current_body_id').notNull().default(0),
  title:             text('title').notNull(),
  description:       text('description'),
  status:            integer('status').notNull().default(1),
  statusDate:        text('status_date'),
  completed:         integer('completed').notNull().default(0),
  pendingCommitteeId: integer('pending_committee_id'),
  url:               text('url'),
  stateLink:         text('state_link'),
  progressJson:      text('progress_json'),
  lastAction:        text('last_action'),
  lastActionDate:    text('last_action_date'),
  createdAt:       text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:       text('updated_at').notNull().default(sql`(datetime('now'))`),
  textsFetchedAt:  text('texts_fetched_at'),
}, (t) => [
  index('idx_bills_session').on(t.sessionId),
  index('idx_bills_state').on(t.state),
])

export const committees = sqliteTable('committees', {
  committeeId: integer('committee_id').primaryKey(),
  state:       text('state').notNull(),
  sessionId:   integer('session_id').notNull(),
  chamber:     text('chamber').notNull().default(''),
  chamberId:   integer('chamber_id').notNull().default(0),
  name:        text('name').notNull(),
})

export const billReferrals = sqliteTable('bill_referrals', {
  id:          text('id').primaryKey(),
  billId:      integer('bill_id').notNull(),
  date:        text('date').notNull(),
  committeeId: integer('committee_id'),
  chamber:     text('chamber'),
  chamberId:   integer('chamber_id'),
  name:        text('name'),
}, (t) => [index('idx_bill_referrals_bill').on(t.billId)])

export const billHistory = sqliteTable('bill_history', {
  id:        text('id').primaryKey(),
  billId:    integer('bill_id').notNull(),
  date:      text('date').notNull(),
  action:    text('action').notNull(),
  chamber:   text('chamber'),
  chamberId: integer('chamber_id'),
  importance: integer('importance').notNull().default(1),
  seq:       integer('seq').notNull(),
}, (t) => [index('idx_bill_history_bill').on(t.billId)])

export const billSponsors = sqliteTable('bill_sponsors', {
  id:              text('id').primaryKey(),
  billId:          integer('bill_id').notNull(),
  peopleId:        integer('people_id'),
  sponsorTypeId:   integer('sponsor_type_id').notNull().default(1),
  sponsorOrder:    integer('sponsor_order').notNull().default(0),
  committeeSponsor: integer('committee_sponsor').notNull().default(0),
  committeeId:     integer('committee_id'),
}, (t) => [index('idx_bill_sponsors_bill').on(t.billId)])

export const billSasts = sqliteTable('bill_sasts', {
  id:             text('id').primaryKey(),
  billId:         integer('bill_id').notNull(),
  typeId:         integer('type_id').notNull(),
  type:           text('type').notNull(),
  sastBillNumber: text('sast_bill_number').notNull(),
  sastBillId:     integer('sast_bill_id').notNull(),
}, (t) => [index('idx_bill_sasts_bill').on(t.billId)])

export const billSubjects = sqliteTable('bill_subjects', {
  id:          text('id').primaryKey(),
  billId:      integer('bill_id').notNull(),
  subjectId:   integer('subject_id').notNull(),
  subjectName: text('subject_name').notNull(),
}, (t) => [index('idx_bill_subjects_bill').on(t.billId)])

export const billTexts = sqliteTable('bill_texts', {
  docId:        integer('doc_id').primaryKey(),
  billId:       integer('bill_id').notNull(),
  date:         text('date').notNull(),
  type:         text('type').notNull(),
  typeId:       integer('type_id').notNull().default(1),
  mime:         text('mime').notNull().default('text/html'),
  mimeId:       integer('mime_id').notNull().default(1),
  url:          text('url'),
  stateLink:    text('state_link'),
  textSize:     integer('text_size'),
  textHash:     text('text_hash'),
  altBillText:  integer('alt_bill_text').notNull().default(0),
  altMime:      text('alt_mime'),
  altMimeId:    integer('alt_mime_id'),
  altStateLink: text('alt_state_link'),
  altTextSize:  integer('alt_text_size'),
  altTextHash:  text('alt_text_hash'),
  r2Key:        text('r2_key'),
  /**
   * Why the last download attempt failed, or null when it succeeded / has not
   * run. Without this a failed fetch is indistinguishable from one that never
   * happened, since both simply leave `r2_key` null.
   */
  fetchError:       text('fetch_error'),
  fetchAttemptedAt: text('fetch_attempted_at'),
}, (t) => [index('idx_bill_texts_bill').on(t.billId)])

export const billSupplements = sqliteTable('bill_supplements', {
  supplementId:   integer('supplement_id').primaryKey(),
  billId:         integer('bill_id').notNull(),
  date:           text('date'),
  typeId:         integer('type_id'),
  type:           text('type'),
  title:          text('title'),
  description:    text('description'),
  mime:           text('mime'),
  mimeId:         integer('mime_id'),
  url:            text('url'),
  stateLink:      text('state_link'),
  supplementSize: integer('supplement_size'),
  supplementHash: text('supplement_hash'),
  r2Key:          text('r2_key'),
}, (t) => [index('idx_bill_supplements_bill').on(t.billId)])

export const billAmendments = sqliteTable('bill_amendments', {
  amendmentId:   integer('amendment_id').primaryKey(),
  billId:        integer('bill_id').notNull(),
  adopted:       integer('adopted').notNull().default(0),
  chamber:       text('chamber'),
  date:          text('date'),
  title:         text('title'),
  description:   text('description'),
  mime:          text('mime'),
  url:           text('url'),
  stateLink:     text('state_link'),
  amendmentSize: integer('amendment_size'),
  amendmentHash: text('amendment_hash'),
}, (t) => [index('idx_bill_amendments_bill').on(t.billId)])

export const billChangeLog = sqliteTable('bill_change_log', {
  id:         text('id').primaryKey(),
  billId:     integer('bill_id').notNull(),
  changeType: text('change_type').notNull(),
  oldValue:   text('old_value'),
  newValue:   text('new_value'),
  detail:     text('detail'),
  detectedAt: text('detected_at').notNull(),
}, (t) => [
  index('idx_bill_change_log_bill_date').on(t.billId, t.detectedAt),
  index('idx_bill_change_log_date').on(t.detectedAt),
])

export const billCalendar = sqliteTable('bill_calendar', {
  id:          text('id').primaryKey(),
  billId:      integer('bill_id').notNull(),
  typeId:      integer('type_id'),
  eventHash:   text('event_hash'),
  type:        text('type'),
  date:        text('date'),
  time:        text('time'),
  location:    text('location'),
  description: text('description'),
}, (t) => [
  index('idx_bill_calendar_bill').on(t.billId),
  index('idx_bill_calendar_date').on(t.date),
])

export const rollCalls = sqliteTable('roll_calls', {
  rollCallId:  integer('roll_call_id').primaryKey(),
  billId:      integer('bill_id').notNull(),
  date:        text('date').notNull(),
  description: text('description'),
  yea:         integer('yea').notNull().default(0),
  nay:         integer('nay').notNull().default(0),
  nv:          integer('nv').notNull().default(0),
  absent:      integer('absent').notNull().default(0),
  total:       integer('total').notNull().default(0),
  passed:      integer('passed').notNull().default(0),
  chamber:     text('chamber'),
  chamberId:   integer('chamber_id'),
  url:         text('url'),
  stateLink:   text('state_link'),
}, (t) => [index('idx_roll_calls_bill').on(t.billId)])

export const rollCallVotes = sqliteTable('roll_call_votes', {
  id:          text('id').primaryKey(),
  rollCallId:  integer('roll_call_id').notNull(),
  peopleId:    integer('people_id'),
  voteId:      integer('vote_id'),
  voteText:    text('vote_text'),
}, (t) => [index('idx_roll_call_votes_rc').on(t.rollCallId)])

export const tenants = sqliteTable('tenants', {
  tenantId:      text('tenant_id').primaryKey(),
  name:          text('name').notNull(),
  apiUrl:        text('api_url'),
  stateCoverage: text('state_coverage').notNull(),
  active:        integer('active', { mode: 'boolean' }).notNull().default(true),
  registeredAt:  text('registered_at').notNull().default(sql`(datetime('now'))`),
  lastSeenAt:    text('last_seen_at'),
  // Cloudflare Queues id for this tenant's delivery queue, used for dynamic
  // HTTP fan-out when no static TENANT_QUEUE_<ID> producer binding exists.
  // Populated at registration via the Queues REST API. NULL = binding-only.
  queueId:       text('queue_id'),
})

export const keywordRegistry = sqliteTable('keyword_registry', {
  tenantId: text('tenant_id').notNull(),
  keyword:  text('keyword').notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.keyword] })])

export const billTenants = sqliteTable('bill_tenants', {
  billId:     integer('bill_id').notNull(),
  tenantId:   text('tenant_id').notNull(),
  notifiedAt: text('notified_at'),
  matchType:  text('match_type'),
}, (t) => [primaryKey({ columns: [t.billId, t.tenantId] })])

export const apiCallLog = sqliteTable('api_call_log', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  loggedAt:  text('logged_at').notNull().default(sql`(datetime('now'))`),
  callType:  text('call_type').notNull(),
  params:    text('params').notNull(),
})

export const sessionSyncLog = sqliteTable('session_sync_log', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  syncedAt:     text('synced_at').notNull().default(sql`(datetime('now'))`),
  state:        text('state').notNull(),
  sessionId:    integer('session_id').notNull(),
  sessionName:  text('session_name').notNull(),
  billsChecked: integer('bills_checked').notNull().default(0),
  billsChanged: integer('bills_changed').notNull().default(0),
  billsQueued:  integer('bills_queued').notNull().default(0),
})

export const magicLinks = sqliteTable('magic_links', {
  id:         text('id').primaryKey(),
  email:      text('email').notNull(),
  tokenHash:  text('token_hash').notNull().unique(),
  expiresAt:  text('expires_at').notNull(),
  usedAt:     text('used_at'),
  createdAt:  text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('idx_magic_links_token').on(t.tokenHash),
])

export const adminSessions = sqliteTable('admin_sessions', {
  id:         text('id').primaryKey(),
  email:      text('email').notNull(),
  name:       text('name').notNull().default(''),
  tokenHash:  text('token_hash').notNull().unique(),
  expiresAt:  text('expires_at').notNull(),
  createdAt:  text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('idx_admin_sessions_token').on(t.tokenHash),
])

export const settings = sqliteTable('settings', {
  key:       text('key').primaryKey(),
  value:     text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const tenantStats = sqliteTable('tenant_stats', {
  tenantId:             text('tenant_id').notNull(),
  statDate:             text('stat_date').notNull(),
  totalMembers:         integer('total_members').notNull().default(0),
  activeMembers7d:      integer('active_members_7d').notNull().default(0),
  activeMembers30d:     integer('active_members_30d').notNull().default(0),
  votesCast:            integer('votes_cast').notNull().default(0),
  commentsWritten:      integer('comments_written').notNull().default(0),
  commentReactions:     integer('comment_reactions').notNull().default(0),
  positionsSet:         integer('positions_set').notNull().default(0),
  notesCreated:         integer('notes_created').notNull().default(0),
  customFieldValues:    integer('custom_field_values').notNull().default(0),
  billsWithEngagement:  integer('bills_with_engagement').notNull().default(0),
  rolesDefined:         integer('roles_defined').notNull().default(0),
  customFieldsDefined:  integer('custom_fields_defined').notNull().default(0),
  billsAiProcessed:     integer('bills_ai_processed').notNull().default(0),
  pulledAt:             text('pulled_at').notNull().default(sql`(datetime('now'))`),
  probeLatencyMs:       integer('probe_latency_ms'),
  probeOk:              integer('probe_ok'),
  // JSON of the six user-attributable metrics recomputed with configured internal
  // domains excluded; null when no exclusion list is set (see migration 0014).
  excludedJson:         text('excluded_json'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.statDate] }),
  index('idx_tenant_stats_date').on(t.statDate),
])

export const resendUsageDaily = sqliteTable('resend_usage_daily', {
  date:        text('date').primaryKey(),
  monthlyUsed: integer('monthly_used').notNull(),
  dailyUsed:   integer('daily_used').notNull(),
  updatedAt:   text('updated_at').notNull().default(sql`(datetime('now'))`),
})
