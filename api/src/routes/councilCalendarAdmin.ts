import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { associationConfig } from '../db/schema'
import {
  COUNCIL_RULES_KEY, loadCouncilWindow, parseCouncilRules, previewCouncilRules, syncCouncilCalendarEvents,
  type CouncilCalendarRules,
} from '../lib/councilCalendar'
import { KNOWN_COUNCIL_COMMITTEES, KNOWN_COUNCIL_HEARING_TYPES } from '../../../shared/councilCalendarPresets'
import { staleCommittees } from '../../../shared/councilCommittees'
import { centralFetch } from '../lib/centralFetch'
import type { AppEnv } from '../types'

/**
 * Settings → Configuration → DC Council calendar. Mounted under /api/admin,
 * which already requires an admin. Each team chooses its own committees,
 * hearing types, and agency or topic keywords; the hourly cron mirrors the
 * matching events, and a save runs that sync right away.
 */
export const councilCalendarAdminRouter = new Hono<AppEnv>()

function merged(known: string[], ...more: string[][]): string[] {
  const out = [...known]
  for (const list of more) for (const x of list) if (x && !out.includes(x)) out.push(x)
  return out
}

// GET /api/admin/council-calendar: saved rules plus the committees and hearing
// types to offer (the known lists, the live calendar window, and the saved rules).
councilCalendarAdminRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, COUNCIL_RULES_KEY)).get()
  let rules: CouncilCalendarRules | null = null
  if (row) { try { rules = JSON.parse(row.value) as CouncilCalendarRules } catch { rules = null } }
  let live: { title: string; hearingType: string }[] = []
  try {
    live = (await loadCouncilWindow(c.env, db)).events
  } catch (err) {
    // The options still work from the known lists when central is unreachable.
    console.error('[council-calendar] options: central window unavailable', err)
  }
  // The Council's current committees, from its own site. After a
  // reorganization a saved committee can stop existing, and the rule naming it
  // silently stops matching, so the page flags it.
  let current: string[] = []
  try {
    const res = await centralFetch(c.env, '/bills/council-directory')
    if (res.ok) current = ((await res.json()) as { committees?: { name: string }[] }).committees?.map(x => x.name) ?? []
  } catch (err) {
    console.error('[council-calendar] options: council directory unavailable', err)
  }
  const saved = (rules?.include ?? []).map(i => i.committee)
  const stale = current.length > 0 ? staleCommittees(saved, current) : []
  const committees = merged(KNOWN_COUNCIL_COMMITTEES, live.map(e => e.title), saved).filter(n => !stale.includes(n) || saved.includes(n))
  const types = merged(KNOWN_COUNCIL_HEARING_TYPES, live.map(e => e.hearingType),
    (rules?.include ?? []).map(i => i.type ?? ''), rules?.types ?? [])
  return c.json({ rules, committees, types, staleCommittees: stale })
})

// POST /api/admin/council-calendar/preview: upcoming events the posted rules
// would select. Nothing is saved.
councilCalendarAdminRouter.post('/preview', async (c) => {
  const body = await c.req.json<{ rules?: unknown }>().catch(() => ({} as { rules?: unknown }))
  const rules = parseCouncilRules(body.rules)
  if (typeof rules === 'string') return c.json({ error: rules }, 400)
  try {
    const events = await previewCouncilRules(c.env, getDb(c.env.DB), rules)
    return c.json({ events })
  } catch (err) {
    console.error('[council-calendar] preview failed', err)
    return c.json({ error: 'The Council calendar is unavailable right now. Try again in a few minutes.' }, 502)
  }
})

// PUT /api/admin/council-calendar: save the rules (or clear them with
// {rules: null}) and mirror the calendar now.
councilCalendarAdminRouter.put('/', async (c) => {
  const body = await c.req.json<{ rules?: unknown }>().catch(() => ({} as { rules?: unknown }))
  const db = getDb(c.env.DB)
  let sync: Awaited<ReturnType<typeof syncCouncilCalendarEvents>> = null
  if (body.rules === null) {
    // No rules: the team takes no Council events. Remove what is mirrored now by
    // syncing against empty rules, then drop the row.
    await db.insert(associationConfig).values({ key: COUNCIL_RULES_KEY, value: '{}' })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: sql`excluded.value` } })
    try { sync = await syncCouncilCalendarEvents(c.env, db) } catch (err) {
      console.error('[council-calendar] clear sync failed', err)
    }
    await db.delete(associationConfig).where(eq(associationConfig.key, COUNCIL_RULES_KEY))
    return c.json({ rules: null, sync })
  }
  const rules = parseCouncilRules(body.rules)
  if (typeof rules === 'string') return c.json({ error: rules }, 400)
  await db.insert(associationConfig).values({ key: COUNCIL_RULES_KEY, value: JSON.stringify(rules) })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: sql`excluded.value` } })
  let syncError: string | null = null
  try { sync = await syncCouncilCalendarEvents(c.env, db) } catch (err) {
    console.error('[council-calendar] sync after save failed', err)
    syncError = 'Saved. The calendar will update within the hour.'
  }
  return c.json({ rules, sync, syncError })
})
