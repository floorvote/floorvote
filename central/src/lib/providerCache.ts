import type { Db } from '../types'

// Stub: the red tests run against this empty body (#619).
export async function providerCacheList(_db: Db, _provider: string, _prefix: string): Promise<Map<string, string>> {
  return new Map()
}

export async function providerCachePut(_db: Db, _provider: string, _entries: Readonly<Record<string, string>>): Promise<void> {}

export async function providerCacheDrop(_db: Db, _provider: string, _keys: readonly string[]): Promise<void> {}
