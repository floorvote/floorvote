import { describe, it, expect } from 'vitest'
import {
  signSuperadminJwt,
  verifySuperadminJwt,
  SUPERADMIN_TOKEN_TTL_SEC,
  SUPERADMIN_JWT_ISS,
  SUPERADMIN_JWT_AUD,
} from '../../../shared/superadminJwt'

// Generate a P-256 keypair as JWK strings for the tests.
async function genKeys(): Promise<{ priv: string; pub: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const priv = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey))
  const pub = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey))
  return { priv, pub }
}

function b64u(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64uBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Low-level ES256 signer used to forge validly-signed tokens with ARBITRARY
// claims (wrong iss/aud, missing claims, chosen jti) so we can test claim
// enforcement independently of the production signer.
async function mintRaw(payload: Record<string, unknown>, privJwk: string): Promise<string> {
  const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
  const body = b64u(JSON.stringify(payload))
  const key = await crypto.subtle.importKey('jwk', JSON.parse(privJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${body}`)))
  return `${header}.${body}.${b64uBytes(sig)}`
}

function decodePayload(token: string): Record<string, unknown> {
  const body = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(body + '==='.slice((body.length + 3) % 4)))
}

describe('superadminJwt (ES256, hardened)', () => {
  it('TTL is 8 hours', () => {
    expect(SUPERADMIN_TOKEN_TTL_SEC).toBe(8 * 60 * 60)
  })

  it('round-trips a valid token and returns email/name/jti', async () => {
    const { priv, pub } = await genKeys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv)
    const result = await verifySuperadminJwt(token, pub)
    expect(result).not.toBeNull()
    expect(result!.email).toBe('a@b.org')
    expect(result!.name).toBe('Ada')
    expect(typeof result!.jti).toBe('string')
    expect(result!.jti!.length).toBeGreaterThan(0)
  })

  it('signs with iss, aud, jti, and an 8h exp', async () => {
    const { priv } = await genKeys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv, 1000)
    const p = decodePayload(token)
    expect(p.iss).toBe(SUPERADMIN_JWT_ISS)
    expect(p.aud).toBe(SUPERADMIN_JWT_AUD)
    expect(typeof p.jti).toBe('string')
    expect(p.iat).toBe(1000)
    expect(p.exp).toBe(1000 + SUPERADMIN_TOKEN_TTL_SEC)
  })

  it('rejects an expired token', async () => {
    const { priv, pub } = await genKeys()
    const past = 1000
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv, past)
    expect(await verifySuperadminJwt(token, pub, { nowSec: past + SUPERADMIN_TOKEN_TTL_SEC + 1 })).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const { priv, pub } = await genKeys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv)
    const [h, , s] = token.split('.')
    const forged = `${h}.${b64u(JSON.stringify({ email: 'evil@x.org', name: 'X', iat: 1, exp: 9999999999, iss: SUPERADMIN_JWT_ISS, aud: SUPERADMIN_JWT_AUD, jti: 'x' }))}.${s}`
    expect(await verifySuperadminJwt(forged, pub)).toBeNull()
  })

  it('rejects a token signed by a different key', async () => {
    const a = await genKeys()
    const b = await genKeys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', a.priv)
    expect(await verifySuperadminJwt(token, b.pub)).toBeNull()
  })

  it('rejects a non-ES256 alg header (alg confusion)', async () => {
    const { pub } = await genKeys()
    const forged = `${b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64u(JSON.stringify({ email: 'x@y.org', name: 'X', iat: 1, exp: 9999999999, iss: SUPERADMIN_JWT_ISS, aud: SUPERADMIN_JWT_AUD, jti: 'x' }))}.`
    expect(await verifySuperadminJwt(forged, pub)).toBeNull()
  })

  it('rejects a validly-signed token with the wrong iss', async () => {
    const { priv, pub } = await genKeys()
    const token = await mintRaw({ email: 'a@b.org', name: 'Ada', iat: 1000, exp: 9999999999, iss: 'evil', aud: SUPERADMIN_JWT_AUD, jti: 'j1' }, priv)
    expect(await verifySuperadminJwt(token, pub)).toBeNull()
  })

  it('rejects a validly-signed token with the wrong aud', async () => {
    const { priv, pub } = await genKeys()
    const token = await mintRaw({ email: 'a@b.org', name: 'Ada', iat: 1000, exp: 9999999999, iss: SUPERADMIN_JWT_ISS, aud: 'evil', jti: 'j1' }, priv)
    expect(await verifySuperadminJwt(token, pub)).toBeNull()
  })

  it('rejects a legacy token missing iss/aud/jti', async () => {
    const { priv, pub } = await genKeys()
    const token = await mintRaw({ email: 'a@b.org', name: 'Ada', iat: 1000, exp: 9999999999 }, priv)
    expect(await verifySuperadminJwt(token, pub)).toBeNull()
  })

  it('rejects a token whose jti is revoked', async () => {
    const { priv, pub } = await genKeys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv)
    const jti = decodePayload(token).jti as string
    // not revoked → passes
    expect(await verifySuperadminJwt(token, pub, { isRevoked: () => false })).not.toBeNull()
    // revoked → rejected
    expect(await verifySuperadminJwt(token, pub, { isRevoked: (j) => j === jti })).toBeNull()
    // async isRevoked supported
    expect(await verifySuperadminJwt(token, pub, { isRevoked: async (j) => j === jti })).toBeNull()
  })
})
