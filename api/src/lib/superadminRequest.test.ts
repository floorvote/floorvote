import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { isSuperadminRequest } from './superadminRequest'
import { signSuperadminJwt } from '../../../shared/superadminJwt'
import type { Env } from '../types'

async function keys() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return {
    priv: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)),
    pub: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey)),
  }
}

// Drive isSuperadminRequest through a one-route Hono app so we get a real Context.
function appWith(pub: string | undefined) {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/probe', async (c) => c.json({ ok: await isSuperadminRequest(c) }))
  return (cookie?: string) =>
    app.request('/probe', { headers: cookie ? { cookie } : {} }, { SUPERADMIN_JWT_PUBLIC_KEY: pub } as unknown as Env)
}

describe('isSuperadminRequest', () => {
  it('true for a valid superadmin_jwt cookie', async () => {
    const { priv, pub } = await keys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv)
    const res = await appWith(pub)(`superadmin_jwt=${token}`)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('false when no cookie', async () => {
    const { pub } = await keys()
    expect(await (await appWith(pub)()).json()).toEqual({ ok: false })
  })

  it('false when public key unset', async () => {
    const { priv } = await keys()
    const token = await signSuperadminJwt('a@b.org', 'Ada', priv)
    expect(await (await appWith(undefined)(`superadmin_jwt=${token}`)).json()).toEqual({ ok: false })
  })

  it('false for a garbage token', async () => {
    const { pub } = await keys()
    expect(await (await appWith(pub)('superadmin_jwt=not.a.jwt')).json()).toEqual({ ok: false })
  })
})
