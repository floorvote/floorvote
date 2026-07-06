import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import {
  isSuperadminJtiRevoked,
  revokeSuperadminJti,
  pruneRevokedSuperadminJtis,
} from '../../src/lib/superadminRevocation'

beforeEach(async () => { await setupLsDb() })

describe('superadmin jti revocation store', () => {
  it('reports an unknown jti as not revoked', async () => {
    const db = drizzle(env.DB, { schema })
    expect(await isSuperadminJtiRevoked(db, 'never-seen')).toBe(false)
  })

  it('reports a revoked jti as revoked', async () => {
    const db = drizzle(env.DB, { schema })
    const nowSec = Math.floor(Date.now() / 1000)
    await revokeSuperadminJti(db, 'jti-abc', nowSec + 3600)
    expect(await isSuperadminJtiRevoked(db, 'jti-abc')).toBe(true)
    expect(await isSuperadminJtiRevoked(db, 'jti-other')).toBe(false)
  })

  it('stores the revocation under a namespaced settings key', async () => {
    const db = drizzle(env.DB, { schema })
    await revokeSuperadminJti(db, 'jti-xyz', 9999999999)
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, 'revoked_jti:jti-xyz')).get()
    expect(row).toBeTruthy()
  })

  it('prunes revocations whose token has already expired but keeps live ones', async () => {
    const db = drizzle(env.DB, { schema })
    const nowSec = Math.floor(Date.now() / 1000)
    await revokeSuperadminJti(db, 'expired', nowSec - 10)
    await revokeSuperadminJti(db, 'live', nowSec + 10_000)
    await pruneRevokedSuperadminJtis(db, nowSec)
    expect(await isSuperadminJtiRevoked(db, 'expired')).toBe(false)
    expect(await isSuperadminJtiRevoked(db, 'live')).toBe(true)
  })
})
