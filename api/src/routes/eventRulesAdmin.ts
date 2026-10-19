import { Hono } from 'hono'
import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm'
import { getDb } from '../db/client'
import { calendarEvents } from '../db/schema'
import { readStateCapabilities } from '../lib/bodyEvents'
import { agendaBills, applyEventRules, centralOptions, loadEventRules, optionCommittees, saveEventRules } from '../lib/eventRules'
import { parseEventRules, type EventFacets } from '../../../shared/eventRules'
import type { AppEnv } from '../types'

/**
 * The Calendar page's committee events gear (#298, #420, #695): which body events, the legislature's own
 * calendar, the instance shows (lib/eventRules.ts). Mounted under /api/admin,
 * which already requires an admin. The web app offers the control to admins
 * only, and only when a covered state has body events (`capabilities` in GET
 * /config).
 */
export const eventRulesAdminRouter = new Hono<AppEnv>()

/** How far ahead GET returns upcoming events with what the rules read of each. The Calendar control (#420) shows no preview, so nothing reads them now. */
const PREVIEW_DAYS = 120

// GET /api/admin/event-rules: the saved rules (null for none: every event
// shows), the committees and kinds to choose from, and the upcoming body
// events, each with what the rules read of it (the old settings page previewed
// a choice with them; the Calendar control reads none of it). The choices are central's lists for each covered state,
// plus any committee or kind the instance's events or saved rules name, so a
// central outage or a committee since gone never drops a choice.
eventRulesAdminRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const listed = await centralOptions(c.env)
  const states = listed ?? {}
  const optionsError = listed ? null : 'The lists below may be incomplete: the legislative data service is unavailable right now.'
  const centralCommittees = optionCommittees(listed) ?? []
  // A fork's #217 rules not yet carried over (central didn't answer) come back provisionally, unsaved.
  // Once saved here, they apply at once rather than at the next hourly sync.
  const { rules, carriedOver } = await loadEventRules(db, optionCommittees(listed))
  if (carriedOver) await applyEventRules(db, rules)

  const today = new Date().toISOString().slice(0, 10)
  const until = new Date(Date.now() + PREVIEW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const rows = await db.select({
    id: calendarEvents.id, date: calendarEvents.date, time: calendarEvents.time, description: calendarEvents.description,
    url: calendarEvents.url, ruleFacets: calendarEvents.ruleFacets,
  }).from(calendarEvents)
    .where(and(eq(calendarEvents.source, 'body'), eq(calendarEvents.status, 'confirmed'), isNotNull(calendarEvents.ruleFacets),
      gte(calendarEvents.date, today), lte(calendarEvents.date, until)))
    .orderBy(asc(calendarEvents.date), asc(calendarEvents.time)).all()
  const agenda = await agendaBills(db, rows.map(r => r.id))
  const events = rows.map(r => ({
    id: r.id, date: r.date, time: r.time, description: r.description, url: r.url,
    facets: JSON.parse(r.ruleFacets!) as EventFacets,
    trackedOnAgenda: agenda.get(r.id)?.tracked ?? false, prioritizedOnAgenda: agenda.get(r.id)?.prioritized ?? false,
  }))

  // Committees: central's, then any the events or saved rules name that central didn't list.
  const committees: { committeeId: string; name: string; chamber: string | null; state: string | null }[] = [...centralCommittees]
  const addCommittee = (committeeId: string | null, name: string | null) => {
    if (committeeId && name && !committees.some(cm => cm.committeeId === committeeId)) committees.push({ committeeId, name, chamber: null, state: null })
  }
  for (const e of events) addCommittee(e.facets.committeeId, e.facets.committee)
  for (const cm of rules?.committees ?? []) addCommittee(cm.committeeId, cm.name)

  // Kinds, each with its event types: central's for every covered state, and the events'.
  const kinds = new Map<string, Set<string>>()
  const addKind = (kind: string, type: string | null) => {
    const types = kinds.get(kind) ?? new Set<string>()
    if (type) types.add(type)
    kinds.set(kind, types)
  }
  for (const o of Object.values(states)) for (const k of o.kinds) { addKind(k.kind, null); for (const t of k.types) addKind(k.kind, t) }
  for (const e of events) addKind(e.facets.kind, e.facets.type)

  const capabilities = (await readStateCapabilities(db))?.data ?? {}
  return c.json({
    rules,
    hasBodyEvents: Object.values(capabilities).some(cap => cap.bodyEvents),
    committees,
    kinds: [...kinds].map(([kind, types]) => ({ kind, types: [...types].sort((a, b) => a.localeCompare(b)) })),
    events,
    optionsError,
  })
})

// PUT /api/admin/event-rules: save the rules, or clear them with
// {rules: null} so every event shows again. Applied to every body event the
// instance holds in the same batch, without asking central.
eventRulesAdminRouter.put('/', async (c) => {
  const body = await c.req.json<{ rules?: unknown }>().catch(() => ({} as { rules?: unknown }))
  if (body.rules === undefined) return c.json({ error: 'rules is required (null clears them)' }, 400)
  const rules = body.rules === null ? null : parseEventRules(body.rules)
  if (typeof rules === 'string') return c.json({ error: rules }, 400)
  const counts = await saveEventRules(getDb(c.env.DB), rules)
  return c.json({ rules, ...counts })
})
