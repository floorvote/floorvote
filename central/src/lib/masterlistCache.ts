import type { NormalizedBillStub } from '../providers/types'
import type { Env } from '../types'

const cacheKey = (sessionId: string) => `sessions/${sessionId}/masterlist.json`

interface MasterlistCache {
  cachedAt: string
  entries: NormalizedBillStub[]
}

export async function saveMasterlistCache(env: Env, sessionId: string, entries: NormalizedBillStub[]): Promise<void> {
  const payload: MasterlistCache = { cachedAt: new Date().toISOString(), entries } // ts-write-ok: cache metadata in an R2 JSON blob, never SQL-sorted
  await env.BILLS_BUCKET.put(cacheKey(sessionId), JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json' },
  })
}

export async function loadMasterlistCache(env: Env, sessionId: string): Promise<NormalizedBillStub[] | null> {
  const obj = await env.BILLS_BUCKET.get(cacheKey(sessionId))
  if (!obj) return null
  try {
    const cache = await obj.json() as MasterlistCache
    return cache.entries
  } catch {
    return null
  }
}
