import { inArray } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { customFieldDefinitions } from '../db/schema'
import { DOCUMENTS_PER_FIELD_MAX, normalizeDocument, type DocumentLink } from '../../../shared/customFieldValues'

/** One resolved custom field write: a string to store, or null to clear. */
export type ResolvedCustomFieldValue = { fieldId: string; value: string | null }

export type CustomFieldValuesResult =
  | { ok: true; values: ResolvedCustomFieldValue[] }
  | { ok: false; error: Record<string, unknown> }

type FieldDef = Pick<typeof customFieldDefinitions.$inferSelect, 'id' | 'type' | 'options' | 'multiple'>

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function isCalendarDate(s: string): boolean {
  const m = ISO_DATE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

function parseOptions(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Validates one value against its field definition, in the request format the
 *  bill page sends: a string, a string array (multi-select dropdown only), an
 *  array of { title, url } (document fields only), or null to clear. Returns the
 *  string to store (multi-select and document values as a JSON array; an empty
 *  array clears) or an error body for a 400. */
function resolveOne(def: FieldDef, raw: unknown): { ok: true; value: string | null } | { ok: false; error: Record<string, unknown> } {
  const fieldId = def.id
  if (raw === null) return { ok: true, value: null }

  if (def.type === 'document') {
    if (!Array.isArray(raw)) return { ok: false, error: { error: `field ${fieldId} requires an array of { title, url }` } }
    if (raw.length > DOCUMENTS_PER_FIELD_MAX) {
      return { ok: false, error: { error: `field ${fieldId} takes at most ${DOCUMENTS_PER_FIELD_MAX} documents` } }
    }
    const docs: DocumentLink[] = []
    for (const entry of raw) {
      const r = normalizeDocument(entry)
      if (!r.ok) return { ok: false, error: { error: `field ${fieldId}: ${r.reason}` } }
      docs.push(r.doc)
    }
    return { ok: true, value: docs.length === 0 ? null : JSON.stringify(docs) }
  }

  if (def.multiple) {
    if (!Array.isArray(raw)) return { ok: false, error: { error: `field ${fieldId} requires an array value` } }
    const opts = parseOptions(def.options)
    const invalid = raw.filter(v => typeof v !== 'string' || !opts.includes(v))
    if (invalid.length > 0) return { ok: false, error: { error: 'invalid_options', fieldId, invalid } }
    return { ok: true, value: raw.length === 0 ? null : JSON.stringify(raw) }
  }

  if (typeof raw !== 'string') return { ok: false, error: { error: `field ${fieldId} requires a string value` } }

  switch (def.type) {
    case 'dropdown': {
      if (!parseOptions(def.options).includes(raw)) {
        return { ok: false, error: { error: 'invalid_options', fieldId, invalid: [raw] } }
      }
      break
    }
    case 'binary': {
      // A checked yes/no field stores '1'; unchecked has no row (send null).
      if (raw !== '1') return { ok: false, error: { error: `field ${fieldId} requires "1" or null` } }
      break
    }
    case 'date': {
      if (!isCalendarDate(raw)) return { ok: false, error: { error: `field ${fieldId} requires a YYYY-MM-DD date` } }
      break
    }
    // 'text' takes any string.
  }
  return { ok: true, value: raw }
}

/** Validates a map of custom field ID -> value against the tenant's field
 *  definitions. The one set of rules for every endpoint that writes custom
 *  field values (the bill page's PUT /bills/:id/custom-fields and
 *  POST /bills/draft): the field exists, the value fits its type, dropdown
 *  values are among its options, and arrays only where the field is
 *  multi-select. Reads only; the caller writes the resolved values. */
export async function resolveCustomFieldValues(
  db: ReturnType<typeof getDb>,
  body: Record<string, unknown>,
): Promise<CustomFieldValuesResult> {
  const fieldIds = Object.keys(body)
  if (fieldIds.length === 0) return { ok: true, values: [] }

  const defs = await db.select({
    id: customFieldDefinitions.id,
    type: customFieldDefinitions.type,
    options: customFieldDefinitions.options,
    multiple: customFieldDefinitions.multiple,
  }).from(customFieldDefinitions).where(inArray(customFieldDefinitions.id, fieldIds)).all()
  const defsById = new Map(defs.map(d => [d.id, d]))

  const values: ResolvedCustomFieldValue[] = []
  for (const [fieldId, raw] of Object.entries(body)) {
    const def = defsById.get(fieldId)
    if (!def) return { ok: false, error: { error: `unknown field: ${fieldId}` } }
    const r = resolveOne(def, raw)
    if (!r.ok) return r
    values.push({ fieldId, value: r.value })
  }
  return { ok: true, values }
}
