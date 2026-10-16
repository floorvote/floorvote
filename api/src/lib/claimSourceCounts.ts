import type { AppDb } from '../types'
import type { ClaimSourceStatus } from './claimSources'

// Stub for the red run: the right shapes, none of the behavior.

export type ClaimSourceCounts = {
  analyses: { withClaimSources: number; emptyList: number; noList: number }
  items: Record<ClaimSourceStatus, number> & { total: number }
  cutOffRetries: number
}

export async function computeClaimSourceCounts(_db: AppDb): Promise<ClaimSourceCounts> {
  return {
    analyses: { withClaimSources: 0, emptyList: 0, noList: 0 },
    items: { exact: 0, normalized: 0, fuzzy: 0, anchored: 0, ungrounded: 0, unverified: 0, total: 0 },
    cutOffRetries: 0,
  }
}

export async function recordClaimSourcesCutOff(_db: AppDb): Promise<void> {}
