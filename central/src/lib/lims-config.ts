import type { LsEnv } from '../types-legiscan'

/** Bills, resolutions, grant budget modifications, reprogrammings, oversight hearing notices. */
export const DEFAULT_LIMS_CATEGORIES = [1, 6, 13, 14, 18]

/**
 * States this central sources from DC LIMS instead of LegiScan. Empty unless a
 * LIMS key is configured, so a deployment without one is unchanged. Only DC is
 * meaningful: LIMS is the DC Council's system.
 */
export function limsStates(env: Pick<LsEnv, 'LIMS_API_KEY' | 'LIMS_STATES'>): Set<string> {
  if (!env.LIMS_API_KEY) return new Set()
  const states = (env.LIMS_STATES ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  return new Set(states.filter(s => s === 'DC'))
}

export function limsCategories(env: Pick<LsEnv, 'LIMS_CATEGORIES'>): number[] {
  const ids = (env.LIMS_CATEGORIES ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
  return ids.length > 0 ? ids : DEFAULT_LIMS_CATEGORIES
}
