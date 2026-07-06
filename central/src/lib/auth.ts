// Timing-safe secret comparison using HMAC to prevent timing-oracle attacks.
// Both values are signed with the same key; outputs are always 32 bytes.
export async function secretsMatch(a: string | null | undefined, b: string): Promise<boolean> {
  // Reject a falsy candidate AND a falsy expected secret: an unset/empty
  // ADMIN_SECRET must fail closed, never authenticate anyone (finding L2).
  if (!a || !b) return false
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
