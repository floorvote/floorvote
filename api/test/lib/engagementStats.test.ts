import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import * as schema from '../../src/db/schema'
import { getDb } from '../../src/db/client'
import { computeEngagementStats, computeExcludedEngagementStats, normalizeExcludeDomains } from '../../src/lib/engagementStats'
import { resetDb, applyMigrations } from '../helpers'

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
})

async function seedKnownActivity() {
  const db = getDb(env.DB)
  // Users
  const now = new Date().toISOString()
  await db.insert(schema.users).values([
    { id: 'u1', email: 'a@x.com', name: 'A', role: 'admin' },
    { id: 'u2', email: 'b@x.com', name: 'B', role: 'member' },
    { id: 'u3', email: 'c@x.com', name: 'C', role: 'member' },
  ])
  // Sessions: u1 active last 1d, u2 active last 10d, u3 last 60d
  const d = (ms: number) => new Date(Date.now() - ms).toISOString()
  await db.insert(schema.sessions).values([
    { id: 's1', userId: 'u1', tokenHash: 'h1', expiresAt: now, lastActive: d(1 * 24 * 3600 * 1000) },
    { id: 's2', userId: 'u2', tokenHash: 'h2', expiresAt: now, lastActive: d(10 * 24 * 3600 * 1000) },
    { id: 's3', userId: 'u3', tokenHash: 'h3', expiresAt: now, lastActive: d(60 * 24 * 3600 * 1000) },
  ])
  // Bills
  await db.insert(schema.bills).values([
    { id: 'b1', billNumber: 'H1', title: 't1', state: 'RI', aiProcessedAt: now },
    { id: 'b2', billNumber: 'H2', title: 't2', state: 'RI', aiProcessedAt: null },
    { id: 'b3', billNumber: 'H3', title: 't3', state: 'RI', aiProcessedAt: now },
  ])
  // Engagement: votes (u1->b1, u2->b1, u1->b2), comments (u1 on b1 non-deleted, u2 on b3 deleted),
  // reactions (1), positions (b1), notes (b1 non-empty + b2 empty), custom fields (2 values),
  // role + custom field def
  await db.insert(schema.memberVotes).values([
    { id: 'v1', billId: 'b1', userId: 'u1', position: 'support' },
    { id: 'v2', billId: 'b1', userId: 'u2', position: 'oppose' },
    { id: 'v3', billId: 'b2', userId: 'u1', position: 'neutral' },
  ])
  await db.insert(schema.comments).values([
    { id: 'c1', billId: 'b1', userId: 'u1', content: 'hi', deletedAt: null },
    { id: 'c2', billId: 'b3', userId: 'u2', content: 'bye', deletedAt: now },
  ])
  await db.insert(schema.commentReactions).values([
    { id: 'r1', commentId: 'c1', userId: 'u2', emoji: '👍' },
  ])
  await db.insert(schema.officialPositions).values([
    { id: 'p1', billId: 'b1', position: 'support', setBy: 'u1' },
  ])
  await db.insert(schema.notes).values([
    { id: 'n1', billId: 'b1', userId: 'u1', content: 'note' },
    { id: 'n2', billId: 'b2', userId: 'u1', content: '' },
  ])
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cf1', name: 'Author', type: 'text', displayOrder: 0 },
  ])
  await db.insert(schema.billCustomFieldValues).values([
    { billId: 'b1', fieldId: 'cf1', value: 'Jane', setBy: 'u1' },
    { billId: 'b2', fieldId: 'cf1', value: '', setBy: 'u1' },
  ])
  await db.insert(schema.roles).values([
    { id: 'role1', name: 'Director', deletedAt: null },
    { id: 'role2', name: 'Old', deletedAt: now },
  ])
}

describe('computeEngagementStats', () => {
  it('returns expected values for the 13 metrics', async () => {
    await seedKnownActivity()
    const db = getDb(env.DB)
    const result = await computeEngagementStats(db)
    expect(result.total_members).toBe(3)
    expect(result.active_members_7d).toBe(1)
    expect(result.active_members_30d).toBe(2)
    expect(result.votes_cast).toBe(3)
    expect(result.comments_written).toBe(1) // c2 is soft-deleted
    expect(result.comment_reactions).toBe(1)
    expect(result.positions_set).toBe(1)
    expect(result.notes_created).toBe(1)   // n2 is empty
    expect(result.custom_field_values).toBe(1) // cv2 is empty
    // bills_with_engagement: b1 has votes+comments+positions, b2 has votes+notes → 2 distinct
    expect(result.bills_with_engagement).toBe(2)
    expect(result.roles_defined).toBe(1)   // role2 is soft-deleted
    expect(result.custom_fields_defined).toBe(1)
    expect(result.bills_ai_processed).toBe(2)
  })

  it('returns zeros on empty db', async () => {
    const db = getDb(env.DB)
    const result = await computeEngagementStats(db)
    expect(result.total_members).toBe(0)
    expect(result.bills_with_engagement).toBe(0)
    expect(result.bills_ai_processed).toBe(0)
  })
})

async function seedForExclusion() {
  const db = getDb(env.DB)
  const now = new Date().toISOString()
  const recent = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  await db.insert(schema.users).values([
    { id: 'ext1', email: 'a@external.org', name: 'Ext1', role: 'member' },
    { id: 'ext2', email: 'b@external.org', name: 'Ext2', role: 'member' },
    { id: 'int1', email: 'staff@bipartisanpolicy.org', name: 'Int1', role: 'admin' },
    { id: 'int2', email: 'x@mail.bipartisanpolicy.org', name: 'Int2', role: 'member' }, // subdomain
  ])
  await db.insert(schema.sessions).values([
    { id: 's1', userId: 'ext1', tokenHash: 'h1', expiresAt: now, lastActive: recent },
    { id: 's2', userId: 'int1', tokenHash: 'h2', expiresAt: now, lastActive: recent },
  ])
  await db.insert(schema.bills).values([{ id: 'b1', billNumber: 'H1', title: 't', state: 'RI' }])
  await db.insert(schema.memberVotes).values([
    { id: 'v1', billId: 'b1', userId: 'ext1', position: 'support' },
    { id: 'v2', billId: 'b1', userId: 'int1', position: 'oppose' },
    { id: 'v3', billId: 'b1', userId: 'int2', position: 'neutral' },
  ])
  await db.insert(schema.comments).values([
    { id: 'c1', billId: 'b1', userId: 'ext1', content: 'hi', deletedAt: null },
    { id: 'c2', billId: 'b1', userId: 'int1', content: 'yo', deletedAt: null },
  ])
  await db.insert(schema.commentReactions).values([
    { id: 'r1', commentId: 'c1', userId: 'int1', emoji: '👍' },
  ])
}

describe('computeExcludedEngagementStats', () => {
  it('drops users on excluded domains, matching exact + subdomain', async () => {
    await seedForExclusion()
    const db = getDb(env.DB)
    const ex = await computeExcludedEngagementStats(db, ['bipartisanpolicy.org'])
    expect(ex).not.toBeNull()
    expect(ex!.total_members).toBe(2)     // int1 (@) + int2 (.subdomain) excluded
    expect(ex!.active_members_7d).toBe(1) // only ext1's session remains
    expect(ex!.votes_cast).toBe(1)        // v2/v3 excluded
    expect(ex!.comments_written).toBe(1)  // c2 excluded
    expect(ex!.comment_reactions).toBe(0) // r1 (by int1) excluded
  })

  it('returns null when no valid domains are configured', async () => {
    await seedForExclusion()
    const db = getDb(env.DB)
    expect(await computeExcludedEngagementStats(db, [])).toBeNull()
    expect(await computeExcludedEngagementStats(db, ['localhost'])).toBeNull() // no dot → normalized out
  })
})

describe('normalizeExcludeDomains', () => {
  it('lowercases, strips junk, dedupes, and requires a dot', () => {
    expect(normalizeExcludeDomains([' BiPartisanPolicy.org ', 'bipartisanpolicy.org', 'localhost', ''])).toEqual(['bipartisanpolicy.org'])
  })
})
