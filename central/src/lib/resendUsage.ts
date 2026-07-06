import * as schema from '../db/schema-legiscan'
import { nowDb } from './dbTime'
import type { LsDb } from '../types-legiscan'

// Upsert today's account-wide Resend usage snapshot (UTC date key). Latest wins.
export async function snapshotResendDaily(db: LsDb, monthlyUsed: number, dailyUsed: number): Promise<void> {
  const date = new Date().toISOString().slice(0, 10)
  const now = nowDb()
  await db.insert(schema.resendUsageDaily)
    .values({ date, monthlyUsed, dailyUsed, updatedAt: now })
    .onConflictDoUpdate({ target: schema.resendUsageDaily.date, set: { monthlyUsed, dailyUsed, updatedAt: now } })
}
