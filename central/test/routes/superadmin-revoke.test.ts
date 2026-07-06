import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { isSuperadminJtiRevoked } from '../../src/lib/superadminRevocation'
import { signSuperadminJwt, verifySuperadminJwt } from '../../src/lib/superadminJwt'

async function genKeys(): Promise<{ priv: string; pub: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    priv: JSON.stringify(await crypto.subtle.exportKey('jwk', (kp as CryptoKeyPair).privateKey)),
    pub: JSON.stringify(await crypto.subtle.exportKey('jwk', (kp as CryptoKeyPair).publicKey)),
  }
}

const keys = await genKeys()
const TEST_ENV: any = { ...env, ADMIN_SECRET: 'admin-secret', SUPERADMIN_JWT_PUBLIC_KEY: keys.pub }

beforeEach(async () => { await setupLsDb() })

function post(body: unknown, secret?: string) {
  return app.fetch(
    new Request('http://central/api/admin/superadmin/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-admin-secret': secret } : {}) },
      body: JSON.stringify(body),
    }),
    TEST_ENV,
  )
}

describe('POST /api/admin/superadmin/revoke (M3)', () => {
  it('requires the admin secret', async () => {
    const res = await post({ jti: 'abc' })
    expect(res.status).toBe(401)
  })

  it('400 when neither jti nor token is supplied', async () => {
    const res = await post({}, 'admin-secret')
    expect(res.status).toBe(400)
  })

  it('revokes a supplied jti', async () => {
    const res = await post({ jti: 'jti-123', exp: 9999999999 }, 'admin-secret')
    expect(res.status).toBe(200)
    const db = drizzle(env.DB, { schema })
    expect(await isSuperadminJtiRevoked(db, 'jti-123')).toBe(true)
  })

  it('revokes by decoding a supplied token', async () => {
    const token = await signSuperadminJwt('a@b.org', 'Ada', keys.priv)
    const jti = (await verifySuperadminJwt(token, keys.pub))!.jti
    const res = await post({ token }, 'admin-secret')
    expect(res.status).toBe(200)
    const db = drizzle(env.DB, { schema })
    expect(await isSuperadminJtiRevoked(db, jti)).toBe(true)
  })

  it('is NOT on the tenant-reachable surface', async () => {
    const { isTenantSurfaceAllowed } = await import('../../src/lib/tenantSurface')
    expect(isTenantSurfaceAllowed('POST', '/api/admin/superadmin/revoke')).toBe(false)
  })
})
