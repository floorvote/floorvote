import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const sessions = sqliteTable('sessions', {
  sessionId:    text('session_id').primaryKey(),
  state:        text('state').notNull(),
  identifier:   text('identifier').notNull(),
  yearStart:    integer('year_start').notNull(),
  yearEnd:      integer('year_end').notNull(),
  sessionName:  text('session_name').notNull(),
  classification: text('classification').notNull().default('primary'),
  isCurrent:    integer('is_current', { mode: 'boolean' }).notNull().default(false),
  sineDie:      integer('sine_die', { mode: 'boolean' }).notNull().default(false),
  provider:     text('provider').notNull().default('openstates'),
  activeSyncFrequencyHours:  integer('active_sync_frequency_hours').notNull().default(24),
  recessSyncFrequencyHours:  integer('recess_sync_frequency_hours').notNull().default(168),
  lastSyncedAt:        text('last_synced_at'),
  lastKeywordSweepAt:  text('last_keyword_sweep_at'),
})

export const bills = sqliteTable('bills', {
  billId:         text('bill_id').primaryKey(),
  sessionId:      text('session_id').notNull(),
  state:          text('state').notNull(),
  number:         text('number').notNull(),
  title:          text('title').notNull(),
  abstract:       text('abstract'),
  status:         text('status'),
  statusDate:     text('status_date'),
  lastAction:     text('last_action'),
  lastActionDate: text('last_action_date'),
  openstatesUrl:  text('openstates_url'),
  stateUrl:       text('state_url'),
  providerData:   text('provider_data'),
  textR2Key:      text('text_r2_key'),
  textHash:       text('text_hash'),
  updatedAt:      text('updated_at').notNull().default(sql`(datetime('now'))`),
  createdAt:      text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_bills_session').on(table.sessionId),
  index('idx_bills_state').on(table.state),
  index('idx_bills_updated').on(table.updatedAt),
])

export const billTenants = sqliteTable('bill_tenants', {
  billId:         text('bill_id').notNull(),
  tenantId:       text('tenant_id').notNull(),
  matchedKeyword: text('matched_keyword'),
  notifiedAt:     text('notified_at'),
}, (table) => [
  primaryKey({ columns: [table.billId, table.tenantId] }),
])

export const tenants = sqliteTable('tenants', {
  tenantId:       text('tenant_id').primaryKey(),
  name:           text('name').notNull(),
  operator:       text('operator').notNull().default(''),
  stateCoverage:  text('state_coverage').notNull(),
  ingestionMode:  text('ingestion_mode').notNull().default('all'),
  active:         integer('active', { mode: 'boolean' }).notNull().default(true),
  aiBilling:      text('ai_billing').notNull().default('operator'),
  registeredAt:   text('registered_at').notNull().default(sql`(datetime('now'))`),
  lastSeenAt:     text('last_seen_at'),
})

export const keywordRegistry = sqliteTable('keyword_registry', {
  tenantId: text('tenant_id').notNull(),
  keyword:  text('keyword').notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.keyword] }),
])

export const tenantStats = sqliteTable('tenant_stats', {
  tenantId:       text('tenant_id').notNull(),
  statDate:       text('stat_date').notNull(),
  billsTracked:   integer('bills_tracked').default(0),
  positionsTaken: integer('positions_taken').default(0),
  votesCast:      integer('votes_cast').default(0),
  commentsAdded:  integer('comments_added').default(0),
  activeMembers:  integer('active_members').default(0),
  reportedAt:     text('reported_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.statDate] }),
])

export const apiCallLog = sqliteTable('api_call_log', {
  date:       text('date').notNull(),
  provider:   text('provider').notNull(),
  callCount:  integer('call_count').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.date, table.provider] }),
])
