// STUB — replaced in the green commit.
import type { AppDb, Env } from '../types'

export type VerifyAiResult =
  | { status: 'ok'; billNumber: string; tags: number; relevanceScore: number; usedFullText: boolean }
  | { status: 'skipped'; reason: string }

export async function verifyAi(_env: Env, _db: AppDb, _billId: string): Promise<VerifyAiResult> {
  return { status: 'skipped', reason: '' }
}
