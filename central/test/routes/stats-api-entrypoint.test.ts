import { env, createExecutionContext } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app, StatsApi, TenantApi } from '../../src/index'
import { clearDb } from '../helpers/migrations'

// StatsApi is the named entrypoint a consumer Worker on the same account binds
// to (`entrypoint = "StatsApi"`) to read tenant_stats. These tests call it the
// way a binding does: construct the entrypoint and call its RPC method.

type Row = typeof schema.tenantStats.$inferInsert

function row(tenantId: string, statDate: string, extra: Partial<Row> = {}): Row {
  return { tenantId, statDate, pulledAt: `${statDate} 06:00:00`, ...extra }
}

async function insert(rows: Row[]) {
  await drizzle(env.DB, { schema }).insert(schema.tenantStats).values(rows)
}

function statsApi() {
  return new StatsApi(createExecutionContext(), env)
}

const EXCLUDED = {
  total_members: 9, active_members_7d: 2, active_members_30d: 5,
  votes_cast: 30, comments_written: 11, comment_reactions: 20,
}

beforeEach(async () => {
  await clearDb()
})

describe('StatsApi.tenantStatsSince', () => {
  it('returns every tenant_stats column, with the staff-excluded values parsed', async () => {
    await insert([row('tenant-a', '2026-07-12', {
      totalMembers: 12, activeMembers7d: 4, activeMembers30d: 8, votesCast: 42,
      commentsWritten: 18, commentReactions: 31, positionsSet: 7, notesCreated: 3,
      customFieldValues: 87, billsWithEngagement: 12, rolesDefined: 2,
      customFieldsDefined: 2, billsAiProcessed: 156, billsAiStalled: 9,
      billsAiStalledOldestHours: 3, probeLatencyMs: 140, probeOk: 1,
      excludedJson: JSON.stringify(EXCLUDED),
    })])

    const days = await statsApi().tenantStatsSince('2026-07-01')

    expect(days).toEqual([{
      tenantId: 'tenant-a',
      statDate: '2026-07-12',
      totalMembers: 12,
      activeMembers7d: 4,
      activeMembers30d: 8,
      votesCast: 42,
      commentsWritten: 18,
      commentReactions: 31,
      positionsSet: 7,
      notesCreated: 3,
      customFieldValues: 87,
      billsWithEngagement: 12,
      rolesDefined: 2,
      customFieldsDefined: 2,
      billsAiProcessed: 156,
      billsAiStalled: 9,
      billsAiStalledOldestHours: 3,
      pulledAt: '2026-07-12 06:00:00',
      probeLatencyMs: 140,
      probeOk: 1,
      excluded: EXCLUDED,
    }])
    expect(days[0]).not.toHaveProperty('excludedJson')
  })

  it('returns null excluded values for a row recorded without them', async () => {
    await insert([row('tenant-a', '2026-06-01')])
    const [day] = await statsApi().tenantStatsSince('2026-01-01')
    expect(day).toMatchObject({ tenantId: 'tenant-a', statDate: '2026-06-01', votesCast: 0, probeOk: null, excluded: null })
  })

  it('returns null excluded values, not an error, for a malformed excluded_json, and still returns the other rows', async () => {
    await insert([
      row('tenant-a', '2026-07-01', { excludedJson: '{not json' }),
      row('tenant-a', '2026-07-02', { excludedJson: '[1,2,3]' }),
      row('tenant-a', '2026-07-03', { excludedJson: JSON.stringify({ votes_cast: 4, comments_written: 'many' }) }),
      row('tenant-a', '2026-07-04', { excludedJson: JSON.stringify(EXCLUDED) }),
    ])
    const days = await statsApi().tenantStatsSince('2026-07-01')
    expect(days.map(d => d.excluded)).toEqual([null, null, { votes_cast: 4 }, EXCLUDED])
  })

  it('returns only days on or after `since`', async () => {
    await insert([
      row('tenant-a', '2026-06-30'),
      row('tenant-a', '2026-07-01'),
      row('tenant-a', '2026-07-02'),
      row('tenant-b', '2026-06-15'),
      row('tenant-b', '2026-07-05'),
    ])
    const days = await statsApi().tenantStatsSince('2026-07-01')
    expect(days.map(d => `${d.tenantId} ${d.statDate}`)).toEqual([
      'tenant-a 2026-07-01',
      'tenant-a 2026-07-02',
      'tenant-b 2026-07-05',
    ])
  })

  it('includes the `since` day itself, and returns nothing once `since` is past the last day', async () => {
    await insert([row('tenant-a', '2026-06-30')])
    expect((await statsApi().tenantStatsSince('2026-06-30')).map(d => d.statDate)).toEqual(['2026-06-30'])
    expect(await statsApi().tenantStatsSince('2026-07-01')).toEqual([])
  })

  it('orders rows by tenant, then day, whatever order they were written in', async () => {
    await insert([
      row('tenant-b', '2026-07-02'),
      row('tenant-a', '2026-07-03'),
      row('tenant-b', '2026-07-01'),
      row('tenant-a', '2026-07-01'),
    ])
    const days = await statsApi().tenantStatsSince('2026-01-01')
    expect(days.map(d => `${d.tenantId} ${d.statDate}`)).toEqual([
      'tenant-a 2026-07-01',
      'tenant-a 2026-07-03',
      'tenant-b 2026-07-01',
      'tenant-b 2026-07-02',
    ])
  })

  it.each(['', '2026-7-1', '07/01/2026', "2026-07-01' OR 1=1 --", '2026-07-01T00:00:00Z'])(
    'rejects a `since` that is not a YYYY-MM-DD date: %j',
    async (since) => {
      await insert([row('tenant-a', '2026-07-01')])
      await expect(statsApi().tenantStatsSince(since)).rejects.toThrow(/YYYY-MM-DD/)
    },
  )

  it('is reachable only over the StatsApi binding: not through TenantApi, and not over HTTP', async () => {
    await insert([row('tenant-a', '2026-07-01')])
    // The binding returns the row...
    expect(await statsApi().tenantStatsSince('2026-07-01')).toHaveLength(1)
    // ...a tenant's TenantApi binding has no such method...
    expect('tenantStatsSince' in TenantApi.prototype).toBe(false)
    const tenantEntry = new TenantApi(createExecutionContext(), env)
    for (const path of ['/api/tenant-stats', '/api/stats', '/api/admin/tenant-stats']) {
      expect((await tenantEntry.fetch(new Request(`https://central${path}`))).status).toBe(403)
      // ...and central's public HTTP app has no route that serves it, even with the admin secret.
      const res = await app.request(path, { headers: { 'x-admin-secret': 'test-secret' } }, env)
      expect(res.status).toBe(404)
    }
  })
})
