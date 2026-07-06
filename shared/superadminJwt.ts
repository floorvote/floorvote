// ES256 (ECDSA P-256) superadmin SSO token. Central signs with the private JWK;
// every env verifies with the public JWK. Header alg is pinned to ES256.
//
// Hardened: short TTL, `jti` for optional central-side revocation,
// and `iss`/`aud` so a token can only be used in the superadmin SSO context.
// NOTE: this file is the SINGLE source of truth — central imports it directly
// (like shared/brand.ts) rather than keeping a copy, so the sign/verify claim
// rules can never drift between the issuer (central) and the verifiers (tenants).

// 8 hours. The token's only job is to bootstrap a long-lived LOCAL session on
// each surface (central admin_session + per-tenant session) the first time it's
// presented there; once bootstrapped those persist independently. A short TTL
// therefore costs almost nothing functionally while shrinking the stolen-token
// window and the residual tenant-access window for routine de-authorization
// (tenants verify signature/exp only — they cannot re-check the allowlist or the
// revocation list, so their residual access is bounded by this TTL).
export const SUPERADMIN_TOKEN_TTL_SEC = 8 * 60 * 60

// Issuer + audience claims. There is exactly one issuer (central) and one
// audience class (superadmin SSO consumers), so these are fixed constants rather
// than configuration — every signer sets them and every verifier requires them.
export const SUPERADMIN_JWT_ISS = 'floorvote-central'
export const SUPERADMIN_JWT_AUD = 'floorvote-superadmin'

function b64uStr(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64uBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64uBytes(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(p + '==='.slice((p.length + 3) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function unb64uStr(s: string): string {
  const p = s.replace(/-/g, '+').replace(/_/g, '/')
  return atob(p + '==='.slice((p.length + 3) % 4))
}

export async function signSuperadminJwt(
  email: string,
  name: string,
  privateJwk: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = b64uStr(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
  const payload = b64uStr(JSON.stringify({
    email,
    name,
    iss: SUPERADMIN_JWT_ISS,
    aud: SUPERADMIN_JWT_AUD,
    jti: crypto.randomUUID(),
    iat: nowSec,
    exp: nowSec + SUPERADMIN_TOKEN_TTL_SEC,
  }))
  const sigInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'jwk', JSON.parse(privateJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(sigInput)),
  )
  return `${sigInput}.${b64uBytes(sig)}`
}

export interface VerifySuperadminOpts {
  /** Current time in epoch seconds (defaults to now). */
  nowSec?: number
  /**
   * Optional revocation predicate keyed on the token's `jti`. Central passes a
   * check against its revocation store; tenants omit it (they have no store and
   * rely on the short TTL). If it returns true the token is rejected.
   */
  isRevoked?: (jti: string) => boolean | Promise<boolean>
}

export async function verifySuperadminJwt(
  token: string,
  publicJwk: string,
  opts: VerifySuperadminOpts = {},
): Promise<{ email: string; name: string; jti: string } | null> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  // alg-confusion guard
  let hdr: { alg?: string }
  try { hdr = JSON.parse(unb64uStr(header)) } catch { return null }
  if (hdr.alg !== 'ES256') return null

  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('jwk', JSON.parse(publicJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  } catch { return null }

  let ok: boolean
  try {
    ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, unb64uBytes(sig), new TextEncoder().encode(`${header}.${body}`),
    )
  } catch { return null }
  if (!ok) return null

  let payload: { email?: unknown; name?: unknown; exp?: unknown; iss?: unknown; aud?: unknown; jti?: unknown }
  try { payload = JSON.parse(unb64uStr(body)) } catch { return null }
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null
  // Required claims — reject anything not minted by the current hardened signer
  // (this also rejects legacy 30-day tokens that lack iss/aud/jti).
  if (payload.iss !== SUPERADMIN_JWT_ISS) return null
  if (payload.aud !== SUPERADMIN_JWT_AUD) return null
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) return null
  if (typeof payload.email !== 'string') return null
  if (opts.isRevoked && await opts.isRevoked(payload.jti)) return null
  return { email: payload.email, name: typeof payload.name === 'string' ? payload.name : '', jti: payload.jti }
}
