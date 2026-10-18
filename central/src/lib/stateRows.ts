import type { Env, Db } from '../types'

export type CallCoverage = 'full' | 'partial' | 'none'
export const CALL_LOGGING: Record<string, CallCoverage> = {}

export interface StateRow {
  state: string
}

export async function loadStateRows(_db: Db, _env: Env, _now: Date = new Date()): Promise<StateRow[]> {
  return []
}
