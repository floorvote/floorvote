// Per-session full/raw/skip decision logic for the LegiScan cron.
// All schedule hours are in America/New_York time (ET); the helper handles DST.

export const DEFAULT_FULL_HOURS_ET = [5, 13, 23]
export const DEFAULT_RAW_HOURS_ET = [7, 9, 11, 15, 17, 19, 21]

export type SyncMode = 'full' | 'raw' | 'skip'

export type SessionSyncConfig = {
  syncEnabled: boolean
  fullSyncHoursEt: string | null  // JSON array of integers, or null for default
  rawSyncHoursEt: string | null
  sineDie?: number  // 1 = concluded, 0 = active. Optional for backward compat with older callers.
}

function parseHours(json: string | null, fallback: number[]): number[] {
  if (!json) return fallback
  try {
    const arr = JSON.parse(json)
    if (Array.isArray(arr) && arr.every(n => Number.isInteger(n) && n >= 0 && n < 24)) return arr
    console.warn(`[sync-schedule] override JSON is not an array of 0-23 ints, falling back to defaults: ${json}`)
  } catch {
    console.warn(`[sync-schedule] override JSON is malformed, falling back to defaults: ${json}`)
  }
  return fallback
}

export function decideMode(cfg: SessionSyncConfig, etHour: number): SyncMode {
  if (cfg.sineDie === 1) return 'skip'
  if (!cfg.syncEnabled) return 'skip'
  const fullHours = parseHours(cfg.fullSyncHoursEt, DEFAULT_FULL_HOURS_ET)
  if (fullHours.includes(etHour)) return 'full'
  const rawHours = parseHours(cfg.rawSyncHoursEt, DEFAULT_RAW_HOURS_ET)
  if (rawHours.includes(etHour)) return 'raw'
  return 'skip'
}

// Current hour (0-23) in America/New_York, computed from the given UTC instant (defaults to now).
export function getCurrentEtHour(nowUtc: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  return parseInt(fmt.format(nowUtc), 10)
}
