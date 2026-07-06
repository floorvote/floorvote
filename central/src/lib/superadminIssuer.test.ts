import { describe, it, expect } from 'vitest'
import { mintSuperadminToken, isSuperadminEmail } from './superadminIssuer'
import { verifySuperadminJwt } from './superadminJwt'
import type { LsEnv } from '../types-legiscan'

async function envWithKey(emails: string): Promise<{ env: LsEnv; pub: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const priv = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey))
  const pub = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey))
  return { env: { SUPERADMIN_EMAILS: emails, SUPERADMIN_JWT_PRIVATE_KEY: priv } as unknown as LsEnv, pub }
}

describe('superadminIssuer', () => {
  it('mints a verifiable token for an allowlisted email', async () => {
    const { env, pub } = await envWithKey('boss@example.com, other@example.com')
    const token = await mintSuperadminToken(env, 'BOSS@example.com', 'Boss')
    expect(token).toBeTruthy()
    const verified = await verifySuperadminJwt(token!, pub)
    expect(verified?.email).toBe('boss@example.com')
    expect(verified?.name).toBe('Boss')
    expect(typeof verified?.jti).toBe('string')
  })

  it('returns null for a non-allowlisted email', async () => {
    const { env } = await envWithKey('boss@example.com')
    expect(await mintSuperadminToken(env, 'nope@x.org', 'No')).toBeNull()
  })

  it('returns null when no private key is configured', async () => {
    const env = { SUPERADMIN_EMAILS: 'boss@example.com' } as unknown as LsEnv
    expect(await mintSuperadminToken(env, 'boss@example.com', 'Boss')).toBeNull()
  })

  it('isSuperadminEmail trims and lowercases', async () => {
    const { env } = await envWithKey('boss@example.com')
    expect(isSuperadminEmail(env, '  BOSS@example.com ')).toBe(true)
    expect(isSuperadminEmail(env, 'x@y.org')).toBe(false)
  })
})
