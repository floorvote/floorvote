import type { LsEnv } from '../types-legiscan'

/** Bills, resolutions, grant budget modifications, reprogrammings, oversight hearing notices. */
export const DEFAULT_LIMS_CATEGORIES = [1, 6, 13, 14, 18]

export function limsCategories(env: Pick<LsEnv, 'LIMS_CATEGORIES'>): number[] {
  const ids = (env.LIMS_CATEGORIES ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
  return ids.length > 0 ? ids : DEFAULT_LIMS_CATEGORIES
}
