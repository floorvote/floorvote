import { eq } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import type { getDb } from '../db/client'
import { nowDb } from './dbTime'

type Db = ReturnType<typeof getDb>

export type ResendReading = { monthlyUsed: number | null; dailyUsed: number | null }

function parseResendUsage(res: Response): ResendReading {
  const m = res.headers.get('x-resend-monthly-quota')
  const d = res.headers.get('x-resend-daily-quota')
  const num = (v: string | null) => (v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
  return { monthlyUsed: num(m), dailyUsed: num(d) }
}

async function writeConfig(db: Db, key: string, value: string): Promise<void> {
  await db.insert(associationConfig).values({ key, value })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value } })
}

export async function recordResendUsage(db: Db, res: Response): Promise<void> {
  const { monthlyUsed, dailyUsed } = parseResendUsage(res)
  if (monthlyUsed === null && dailyUsed === null) return
  if (monthlyUsed !== null) await writeConfig(db, 'resend_monthly_used', String(monthlyUsed))
  if (dailyUsed !== null) await writeConfig(db, 'resend_daily_used', String(dailyUsed))
  await writeConfig(db, 'resend_used_at', nowDb())
}

export async function recordResendThrottle(db: Db, res: Response): Promise<void> {
  if (res.status !== 429) return
  await writeConfig(db, 'resend_last_429_at', nowDb())
}
