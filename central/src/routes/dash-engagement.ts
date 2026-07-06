import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { gte, asc, eq, and } from 'drizzle-orm'
import * as schema from '../db/schema-legiscan'
import { requireAdmin, type DashEnv } from '../lib/adminAuth'
import { pullEngagementStatsForTenant } from '../cron/engagement-pull'

export const dashEngagementRoutes = new Hono<DashEnv>()

dashEngagementRoutes.use('*', requireAdmin())

// ---------- shared helpers ----------

const METRIC_KEYS = [
  'total_members',
  'active_members_7d',
  'active_members_30d',
  'votes_cast',
  'comments_written',
  'comment_reactions',
  'positions_set',
  'notes_created',
  'custom_field_values',
  'bills_with_engagement',
  'roles_defined',
  'custom_fields_defined',
  'bills_ai_processed',
] as const
type MetricKey = (typeof METRIC_KEYS)[number]

function toCamel(key: MetricKey): keyof typeof schema.tenantStats.$inferSelect {
  switch (key) {
    case 'total_members':         return 'totalMembers'
    case 'active_members_7d':     return 'activeMembers7d'
    case 'active_members_30d':    return 'activeMembers30d'
    case 'votes_cast':            return 'votesCast'
    case 'comments_written':      return 'commentsWritten'
    case 'comment_reactions':     return 'commentReactions'
    case 'positions_set':         return 'positionsSet'
    case 'notes_created':         return 'notesCreated'
    case 'custom_field_values':   return 'customFieldValues'
    case 'bills_with_engagement': return 'billsWithEngagement'
    case 'roles_defined':         return 'rolesDefined'
    case 'custom_fields_defined': return 'customFieldsDefined'
    case 'bills_ai_processed':    return 'billsAiProcessed'
  }
}

function parseDays(raw: string | undefined): number {
  const n = Number(raw ?? 90)
  if (!Number.isFinite(n) || n < 1) return 90
  return Math.min(n, 365)
}

function dateNDaysAgoUtc(n: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - (n - 1))
  return d.toISOString().slice(0, 10)
}

function buildDateRange(start: string, days: number): string[] {
  const out: string[] = []
  const base = new Date(start + 'T00:00:00Z')
  for (let i = 0; i < days; i++) {
    const d = new Date(base)
    d.setUTCDate(base.getUTCDate() + i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

// ---------- GET /overview ----------

dashEngagementRoutes.get('/overview', async (c) => {
  const db = drizzle(c.env.DB, { schema })

  // Fetch all stats rows, then pick latest per tenant in JS.
  const allRows = await db.select().from(schema.tenantStats).all()

  // Group by tenantId, keeping only the row with the max statDate.
  const latestByTenant = new Map<string, typeof allRows[number]>()
  for (const r of allRows) {
    const existing = latestByTenant.get(r.tenantId)
    if (!existing || r.statDate > existing.statDate) {
      latestByTenant.set(r.tenantId, r)
    }
  }

  const latestRows = Array.from(latestByTenant.values())

  const totals: Record<string, number> = {
    total_members: 0, active_members_7d: 0, active_members_30d: 0,
    votes_cast: 0, comments_written: 0, comment_reactions: 0,
    positions_set: 0, notes_created: 0, custom_field_values: 0,
    bills_with_engagement: 0, roles_defined: 0, custom_fields_defined: 0,
    bills_ai_processed: 0,
  }
  let asOfDate: string | null = null
  for (const r of latestRows) {
    if (!asOfDate || r.statDate > asOfDate) asOfDate = r.statDate
    totals.total_members         += Number(r.totalMembers)
    totals.active_members_7d     += Number(r.activeMembers7d)
    totals.active_members_30d    += Number(r.activeMembers30d)
    totals.votes_cast            += Number(r.votesCast)
    totals.comments_written      += Number(r.commentsWritten)
    totals.comment_reactions     += Number(r.commentReactions)
    totals.positions_set         += Number(r.positionsSet)
    totals.notes_created         += Number(r.notesCreated)
    totals.custom_field_values   += Number(r.customFieldValues)
    totals.bills_with_engagement += Number(r.billsWithEngagement)
    totals.roles_defined         += Number(r.rolesDefined)
    totals.custom_fields_defined += Number(r.customFieldsDefined)
    totals.bills_ai_processed    += Number(r.billsAiProcessed)
  }

  return c.json({
    data: { tenantCount: latestRows.length, asOfDate, totals },
    meta: { generatedAt: new Date().toISOString() },
  })
})

// ---------- GET /series ----------

dashEngagementRoutes.get('/series', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const days = parseDays(c.req.query('days'))
  const since = dateNDaysAgoUtc(days)
  const dates = buildDateRange(since, days)

  const tenantRows = await db
    .select({ tenantId: schema.tenants.tenantId, name: schema.tenants.name })
    .from(schema.tenants)
    .orderBy(asc(schema.tenants.tenantId))
    .all()
  const tenants = tenantRows.map(t => ({ id: t.tenantId, name: t.name }))

  const statsRows = await db
    .select()
    .from(schema.tenantStats)
    .where(gte(schema.tenantStats.statDate, since))
    .all()

  // index by tenant -> date -> row
  const byTenantDate = new Map<string, Map<string, typeof statsRows[number]>>()
  for (const r of statsRows) {
    if (!byTenantDate.has(r.tenantId)) byTenantDate.set(r.tenantId, new Map())
    byTenantDate.get(r.tenantId)!.set(r.statDate, r)
  }

  const metrics: Record<string, Record<string, (number | null)[]>> = {}
  for (const key of METRIC_KEYS) {
    const camelKey = toCamel(key)
    metrics[key] = {}
    for (const t of tenants) {
      metrics[key][t.id] = dates.map(d => {
        const row = byTenantDate.get(t.id)?.get(d)
        return row != null ? Number(row[camelKey]) : null
      })
    }
  }

  return c.json({
    data: { tenants, dates, metrics },
    meta: { generatedAt: new Date().toISOString() },
  })
})

// ---------- GET /tenants/:id ----------

dashEngagementRoutes.get('/tenants/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const id = c.req.param('id')
  const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, id)).get()
  if (!tenant) return c.json({ error: { code: 'not_found', message: 'Tenant not found' } }, 404)

  const days = parseDays(c.req.query('days'))
  const since = dateNDaysAgoUtc(days)
  const dates = buildDateRange(since, days)

  const rows = await db
    .select()
    .from(schema.tenantStats)
    .where(and(
      eq(schema.tenantStats.tenantId, id),
      gte(schema.tenantStats.statDate, since),
    ))
    .all()
  const byDate = new Map(rows.map(r => [r.statDate, r]))

  const metrics: Record<string, (number | null)[]> = {}
  for (const key of METRIC_KEYS) {
    const camelKey = toCamel(key)
    metrics[key] = dates.map(d => {
      const row = byDate.get(d)
      return row != null ? Number(row[camelKey]) : null
    })
  }

  // Latest probe reading (most recent row that has a probe recorded) — drives
  // the DB-health readout on the per-tenant admin page.
  let probe: { latencyMs: number | null; ok: boolean | null; statDate: string } | null = null
  for (const r of rows) {
    if (r.probeLatencyMs == null && r.probeOk == null) continue
    if (!probe || r.statDate > probe.statDate) {
      probe = {
        latencyMs: r.probeLatencyMs == null ? null : Number(r.probeLatencyMs),
        ok: r.probeOk == null ? null : r.probeOk === 1,
        statDate: r.statDate,
      }
    }
  }

  return c.json({
    data: { tenant: { id: tenant.tenantId, name: tenant.name }, dates, metrics, probe },
    meta: { generatedAt: new Date().toISOString() },
  })
})

// ---------- GET /export ----------

const CSV_HEADER = [
  'tenant_id', 'tenant_name', 'stat_date',
  'total_members', 'active_members_7d', 'active_members_30d',
  'votes_cast', 'comments_written', 'comment_reactions',
  'positions_set', 'notes_created', 'custom_field_values',
  'bills_with_engagement', 'roles_defined', 'custom_fields_defined',
  'bills_ai_processed',
].join(',')

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

dashEngagementRoutes.get('/export', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const format = c.req.query('format') === 'json' ? 'json' : 'csv'
  const days = parseDays(c.req.query('days'))
  const since = dateNDaysAgoUtc(days)
  const today = new Date().toISOString().slice(0, 10)

  if (format === 'json') {
    const tenants = await db
      .select({ tenantId: schema.tenants.tenantId, name: schema.tenants.name })
      .from(schema.tenants)
      .orderBy(asc(schema.tenants.tenantId))
      .all()
    const rows = await db
      .select()
      .from(schema.tenantStats)
      .where(gte(schema.tenantStats.statDate, since))
      .all()
    return new Response(JSON.stringify({
      data: {
        tenants: tenants.map(t => ({ id: t.tenantId, name: t.name })),
        rows: rows.map(r => ({
          tenant_id: r.tenantId, stat_date: r.statDate,
          total_members: r.totalMembers, active_members_7d: r.activeMembers7d,
          active_members_30d: r.activeMembers30d, votes_cast: r.votesCast,
          comments_written: r.commentsWritten, comment_reactions: r.commentReactions,
          positions_set: r.positionsSet, notes_created: r.notesCreated,
          custom_field_values: r.customFieldValues, bills_with_engagement: r.billsWithEngagement,
          roles_defined: r.rolesDefined, custom_fields_defined: r.customFieldsDefined,
          bills_ai_processed: r.billsAiProcessed, pulled_at: r.pulledAt,
        })),
      },
      meta: { generatedAt: new Date().toISOString() },
    }, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="engagement-stats-${today}.json"`,
      },
    })
  }

  // CSV: join tenant_stats with tenants for the name; sort by (tenant_id, stat_date)
  const joined = await db
    .select({
      tenantId: schema.tenantStats.tenantId,
      tenantName: schema.tenants.name,
      statDate: schema.tenantStats.statDate,
      totalMembers: schema.tenantStats.totalMembers,
      activeMembers7d: schema.tenantStats.activeMembers7d,
      activeMembers30d: schema.tenantStats.activeMembers30d,
      votesCast: schema.tenantStats.votesCast,
      commentsWritten: schema.tenantStats.commentsWritten,
      commentReactions: schema.tenantStats.commentReactions,
      positionsSet: schema.tenantStats.positionsSet,
      notesCreated: schema.tenantStats.notesCreated,
      customFieldValues: schema.tenantStats.customFieldValues,
      billsWithEngagement: schema.tenantStats.billsWithEngagement,
      rolesDefined: schema.tenantStats.rolesDefined,
      customFieldsDefined: schema.tenantStats.customFieldsDefined,
      billsAiProcessed: schema.tenantStats.billsAiProcessed,
    })
    .from(schema.tenantStats)
    .innerJoin(schema.tenants, eq(schema.tenants.tenantId, schema.tenantStats.tenantId))
    .where(gte(schema.tenantStats.statDate, since))
    .orderBy(asc(schema.tenantStats.tenantId), asc(schema.tenantStats.statDate))
    .all()

  const lines = [CSV_HEADER]
  for (const r of joined) {
    lines.push([
      csvEscape(r.tenantId),
      csvEscape(r.tenantName),
      csvEscape(r.statDate),
      r.totalMembers, r.activeMembers7d, r.activeMembers30d,
      r.votesCast, r.commentsWritten, r.commentReactions,
      r.positionsSet, r.notesCreated, r.customFieldValues,
      r.billsWithEngagement, r.rolesDefined, r.customFieldsDefined,
      r.billsAiProcessed,
    ].join(','))
  }

  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="engagement-stats-${today}.csv"`,
    },
  })
})

// ---------- POST /refresh/:id ----------

dashEngagementRoutes.post('/refresh/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const id = c.req.param('id')
  try {
    const row = await pullEngagementStatsForTenant(c.env, db, id)
    return c.json({
      data: {
        tenantId: row.tenantId,
        statDate: row.statDate,
        metrics: {
          total_members: row.totalMembers,
          active_members_7d: row.activeMembers7d,
          active_members_30d: row.activeMembers30d,
          votes_cast: row.votesCast,
          comments_written: row.commentsWritten,
          comment_reactions: row.commentReactions,
          positions_set: row.positionsSet,
          notes_created: row.notesCreated,
          custom_field_values: row.customFieldValues,
          bills_with_engagement: row.billsWithEngagement,
          roles_defined: row.rolesDefined,
          custom_fields_defined: row.customFieldsDefined,
          bills_ai_processed: row.billsAiProcessed,
        },
        pulledAt: row.pulledAt,
      },
      meta: { generatedAt: new Date().toISOString() },
    })
  } catch (err: any) {
    const message = err?.message ?? String(err)
    if (/not found/i.test(message)) {
      return c.json({ error: { code: 'not_found', message } }, 404)
    }
    return c.json({ error: { code: 'bad_gateway', message } }, 502)
  }
})
