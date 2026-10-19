import { inArray } from 'drizzle-orm'
import { associationConfig, users } from '../db/schema'
import { nowDb } from './dbTime'
import type { AppDb } from '../types'

// Who last changed each AI setting, and when (#602): the same record #570 keeps
// for the claim links setting (lib/claimLinksSetting.ts), for the three AI
// instruction settings. Each record is its own `association_config` row, named
// by `recordKey`, written in the same batch as the setting it describes.

export const AI_SETTING_KEYS = ['ai_context', 'relevance_question', 'tag_taxonomy'] as const
export type AiSettingKey = (typeof AI_SETTING_KEYS)[number]

export const recordKey = (key: AiSettingKey) => `${key}_changed`

/** The admin config's fields for the records: `<key>_changed_at` and `<key>_changed_by`. */
export type AiSettingRecordFields = Record<`${AiSettingKey}_changed_at` | `${AiSettingKey}_changed_by`, unknown>

function parse(value: string): unknown {
  try { return JSON.parse(value) } catch { return value }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object)
    const bk = Object.keys(b as object)
    return ak.length === bk.length && ak.every(k => k in (b as object) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

/**
 * Which AI settings in a config save would actually change. `current` is the
 * stored rows by key; a null in the body means "clear it", which changes
 * nothing when it was never set. Saving the same value again changes nothing.
 */
export function changedAiSettings(current: Map<string, string>, body: Record<string, unknown>): AiSettingKey[] {
  return AI_SETTING_KEYS.filter((key) => {
    if (!(key in body)) return false
    const stored = current.get(key)
    if (body[key] === null) return stored !== undefined
    return stored === undefined || !sameValue(parse(stored), body[key])
  })
}

/** The statements that record the admin and the time for each changed setting, to run in the same batch as the values. */
export function recordStatements(db: AppDb, changed: AiSettingKey[], adminId: string) {
  const value = JSON.stringify({ by: adminId, at: nowDb() })
  return changed.map((key) => db.insert(associationConfig).values({ key: recordKey(key), value }).onConflictDoUpdate({
    target: associationConfig.key,
    set: { value },
  }))
}

/** The records for the admin config, as its response fields. A setting nobody has changed has null fields. */
export async function readAiSettingRecordFields(db: AppDb): Promise<AiSettingRecordFields> {
  const rows = await db.select().from(associationConfig)
    .where(inArray(associationConfig.key, AI_SETTING_KEYS.map(recordKey))).all()
  const parsed = new Map<AiSettingKey, { by: string | null; at: string | null }>()
  for (const key of AI_SETTING_KEYS) {
    const row = rows.find(r => r.key === recordKey(key))
    if (!row) continue
    try {
      const p = JSON.parse(row.value) as { by?: unknown; at?: unknown }
      parsed.set(key, { by: typeof p.by === 'string' ? p.by : null, at: typeof p.at === 'string' ? p.at : null })
    } catch { /* an unreadable record reads as no record */ }
  }
  const ids = [...new Set([...parsed.values()].map(p => p.by).filter((id): id is string => id !== null))]
  const people = ids.length === 0
    ? []
    : await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)).all()
  const fields: Record<string, unknown> = {}
  for (const key of AI_SETTING_KEYS) {
    const p = parsed.get(key)
    fields[`${key}_changed_at`] = p?.at ?? null
    fields[`${key}_changed_by`] = (p?.by != null && people.find(u => u.id === p.by)) || null
  }
  return fields as AiSettingRecordFields
}
