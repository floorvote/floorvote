import { inArray } from 'drizzle-orm'
import { bills } from '../db/schema'
import { handleForms, normalizeHandle } from '../../../shared/billHandle'
import type { AppDb } from '../types'

/**
 * The handle this instance stores for the bill `handle` names, whichever
 * spelling the caller used (#305). A bill held under the other spelling (a
 * legacy row stored before migration 0119 ran) keeps its stored one, so the
 * delivery updates that row instead of inserting a second. A bill held under
 * both gets the normalized (neutral) one. A bill the
 * instance doesn't hold yet, and anything that isn't a handle, gets the
 * normalized form.
 */
export async function resolveStoredHandle(db: AppDb, handle: string): Promise<string> {
  const forms = handleForms(handle)
  if (forms.length === 1) return handle
  const stored = (await db.select({ externalId: bills.externalId }).from(bills).where(inArray(bills.externalId, forms)).all())
    .map(r => r.externalId)
  const preferred = normalizeHandle(handle)
  return stored.includes(preferred) ? preferred : (stored[0] ?? preferred)
}
