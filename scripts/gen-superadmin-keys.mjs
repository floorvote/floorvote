// scripts/gen-superadmin-keys.mjs
// Usage: node scripts/gen-superadmin-keys.mjs
// Prints the ES256 keypair as JWK JSON. PRIVATE -> central secret; PUBLIC -> wrangler var.
import { webcrypto } from 'node:crypto'
const { subtle } = webcrypto
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const priv = JSON.stringify(await subtle.exportKey('jwk', kp.privateKey))
const pub = JSON.stringify(await subtle.exportKey('jwk', kp.publicKey))
console.log('\n=== SUPERADMIN_JWT_PRIVATE_KEY (central secret — do NOT commit) ===\n' + priv)
console.log('\n=== SUPERADMIN_JWT_PUBLIC_KEY (wrangler var — safe to commit) ===\n' + pub + '\n')
