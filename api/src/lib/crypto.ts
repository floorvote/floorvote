// Uses the Web Crypto API, available in both Cloudflare Workers and the test runtime.

export async function generateToken(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return toHex(bytes)
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(hashBuffer))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Timing-safe secret comparison using HMAC to prevent timing-oracle attacks.
// Both values are signed with the same key; outputs are always 32 bytes, so the
// compare loop is constant-time regardless of input length. Mirrors
// central/src/lib/auth.ts::secretsMatch.
export async function secretsMatch(a: string | null | undefined, b: string): Promise<boolean> {
  if (!a) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ])
  const a8 = new Uint8Array(sa)
  const b8 = new Uint8Array(sb)
  let diff = 0
  for (let i = 0; i < a8.length; i++) diff |= a8[i] ^ b8[i]
  return diff === 0
}
