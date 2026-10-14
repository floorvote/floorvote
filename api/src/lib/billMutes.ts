// Per-bill mute (#355): a member who mutes a bill's comments gets no reply
// notifications for it, in the app or by email. Mentions still reach them.
//
// A member mutes from the bill page (with a session) or from a reply email's
// mute link (without one). The email link carries a token signed for one member
// and one bill, so it can mute that bill for that member and nothing else.
//
// The signing key is a random secret the instance creates for itself the first
// time it needs one and keeps in association_config, the way the calendar feed
// keeps its secret slug. Nothing for a self-hoster to set. It never leaves the
// database: GET /admin/config and the export both read config through
// allowlists that leave it out.
import { and, eq } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { associationConfig, billMutes, bills, users } from '../db/schema'
import { activeUser } from './accountDeletion'
import { generateToken, secretsMatch } from './crypto'
import { billUrl } from '../../../shared/sessionSlug'

type Db = ReturnType<typeof getDb>

/** Mutes a bill's comments for a member. Muting a muted bill changes nothing. */
export async function muteBill(db: Db, userId: string, billId: string): Promise<void> {
  await db.insert(billMutes).values({ userId, billId }).onConflictDoNothing()
}

export async function unmuteBill(db: Db, userId: string, billId: string): Promise<void> {
  await db.delete(billMutes).where(and(eq(billMutes.userId, userId), eq(billMutes.billId, billId)))
}

export async function isBillMuted(db: Db, userId: string, billId: string): Promise<boolean> {
  const row = await db.select({ userId: billMutes.userId }).from(billMutes)
    .where(and(eq(billMutes.userId, userId), eq(billMutes.billId, billId))).get()
  return !!row
}

// ── Signed mute links ─────────────────────────────────────────────────────────

const KEY_NAME = 'email_link_key'
// Bound into every signature, so a signature made for some other purpose with
// the same key can never pass as a mute link.
const PURPOSE = 'mute-bill:v1'

async function readKey(db: Db): Promise<string | null> {
  const row = await db.select({ value: associationConfig.value }).from(associationConfig)
    .where(eq(associationConfig.key, KEY_NAME)).get()
  return row?.value || null
}

/** The instance's link-signing key, created on first use. Two concurrent first uses agree on one. */
async function getOrCreateKey(db: Db): Promise<string> {
  const existing = await readKey(db)
  if (existing) return existing
  const fresh = await generateToken()
  await db.insert(associationConfig).values({ key: KEY_NAME, value: fresh }).onConflictDoNothing()
  return (await readKey(db)) ?? fresh
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, c => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** Signs payloads with one key, imported once. */
async function signer(key: string): Promise<(payload: string) => Promise<string>> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return async (payload) => toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(`${PURPOSE}\n${payload}`))))
}

/**
 * Makes mute-link tokens. A token mutes one bill for one member: the encoded
 * member and bill, a dot, and an HMAC-SHA256 of them under the instance's key.
 * It does not expire. Muting is the only thing it can do, and unmuting is one
 * click on the bill page. The key is read once, however many tokens are made.
 */
export async function muteLinkTokens(db: Db): Promise<(userId: string, billId: string) => Promise<string>> {
  const sign = await signer(await getOrCreateKey(db))
  return async (userId, billId) => {
    const payload = toBase64Url(new TextEncoder().encode(JSON.stringify([userId, billId])))
    return `${payload}.${await sign(payload)}`
  }
}

/**
 * The member and bill a token was signed for, or null for anything else. The
 * signature is checked before the payload is even decoded, so a forged token
 * learns nothing about which members or bills exist.
 */
export async function verifyMuteLinkToken(db: Db, token: unknown): Promise<{ userId: string; billId: string } | null> {
  if (typeof token !== 'string' || token.length > 1024) return null
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const [payload, signature] = parts
  // No key yet means no link was ever signed. Verifying never creates one.
  const key = await readKey(db)
  if (!key) return null
  const sign = await signer(key)
  if (!(await secretsMatch(signature, await sign(payload)))) return null

  const bytes = fromBase64Url(payload)
  if (!bytes) return null
  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') {
      return { userId: decoded[0], billId: decoded[1] }
    }
  } catch {}
  return null
}

/**
 * Mutes the bill a link was signed for, for the member it was signed for.
 * Returns the bill, for the confirmation page to name, or null when the token
 * is not a valid link, its member is no longer active, or its bill is gone.
 */
export async function muteFromLink(db: Db, token: unknown): Promise<{ billNumber: string; billTitle: string; billPath: string } | null> {
  const signed = await verifyMuteLinkToken(db, token)
  if (!signed) return null
  const [member, bill] = await Promise.all([
    db.select({ id: users.id }).from(users).where(and(eq(users.id, signed.userId), activeUser)).get(),
    db.select({ id: bills.id, billNumber: bills.billNumber, title: bills.title, state: bills.state, session: bills.session, sessionSlug: bills.sessionSlug })
      .from(bills).where(eq(bills.id, signed.billId)).get(),
  ])
  if (!member || !bill) return null
  await muteBill(db, member.id, bill.id)
  return { billNumber: bill.billNumber, billTitle: bill.title, billPath: billUrl(bill) }
}
