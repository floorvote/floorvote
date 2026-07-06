import { eq } from 'drizzle-orm'
import * as schema from '../db/schema-legiscan'
import { nowDb } from './dbTime'
import type { LsDb } from '../types-legiscan'

export async function getSetting(db: LsDb, key: string, fallback: string): Promise<string> {
  const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
  return row?.value ?? fallback
}

export async function getSettingNumber(db: LsDb, key: string, fallback: number): Promise<number> {
  const raw = await getSetting(db, key, '')
  if (raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export async function setSetting(db: LsDb, key: string, value: string): Promise<void> {
  const now = nowDb()
  await db.insert(schema.settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } })
}
