import { describe, it, expect } from 'vitest'
import {
  signSuperadminJwt,
  verifySuperadminJwt,
  SUPERADMIN_TOKEN_TTL_SEC,
  SUPERADMIN_JWT_ISS,
  SUPERADMIN_JWT_AUD,
} from './superadminJwt' // re-exports ../../../shared/superadminJwt (single source of truth)

async function genKeys(): Promise<{ priv: string; pub: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return {
    priv: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)),
    pub: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey)),
  }
}

describe('central superadminJwt (ES256, via shared)', () => {
  it('resolves the shared module and round-trips with hardened claims', async () => {
    expect(SUPERADMIN_TOKEN_TTL_SEC).toBe(8 * 60 * 60)
    const { priv, pub } = await genKeys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv)
    const result = await verifySuperadminJwt(token, pub)
    expect(result?.email).toBe('a@b.org')
    expect(result?.name).toBe('Ada')
    expect(typeof result?.jti).toBe('string')
  })

  it('rejects expiry, wrong key, bad alg, and revoked jti', async () => {
    const { priv, pub } = await genKeys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv)
    expect(await verifySuperadminJwt(token, pub, { nowSec: Math.floor(Date.now() / 1000) + SUPERADMIN_TOKEN_TTL_SEC + 1 })).toBeNull()
    const other = await genKeys()
    expect(await verifySuperadminJwt(token, other.pub)).toBeNull()
    expect(await verifySuperadminJwt('x.y.z', pub)).toBeNull()
    const jti = (await verifySuperadminJwt(token, pub))!.jti
    expect(await verifySuperadminJwt(token, pub, { isRevoked: (j) => j === jti })).toBeNull()
  })

  it('exposes the iss/aud constants', () => {
    expect(SUPERADMIN_JWT_ISS).toBe('floorvote-central')
    expect(SUPERADMIN_JWT_AUD).toBe('floorvote-superadmin')
  })
})
