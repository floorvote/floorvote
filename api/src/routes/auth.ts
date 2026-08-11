import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { eq, and, isNull, gt, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { users, sessions, magicLinks } from '../db/schema'
import { nowDb } from '../lib/dbTime'
import { dbTsToEpoch } from '../../../shared/time'
import { generateToken, hashToken } from '../lib/crypto'
import { sendMagicLink } from '../lib/email'
import { recordAuthEvent, authReqContext } from '../lib/authEvents'
import { getSuperAdminCookieDomain } from '../lib/superadmin'
import { parseAppDomains } from '../lib/appDomains'
import { verifySuperadminJwt } from '../../../shared/superadminJwt'
import { isSuperadminEmailViaCentral } from '../lib/superadminCentral'
import { checkRateLimit } from '../../../shared/rateLimit'
import { verifyTurnstile } from '../../../shared/turnstile'
import { countActiveOwners } from '../lib/owners'
import { ensureDemoSession, demoSessionCookie } from '../lib/demoSession'
import type { AppEnv } from '../types'

export const authRoutes = new Hono<AppEnv>()

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MAGIC_LINK_DURATION_MS = 60 * 60 * 1000 // 60 minutes — wider window for slow (e.g. gov) mail gateways that delay/scan links
// Debounce the per-request users.last_active write: only persist when the stored
// value is missing or older than this. Avoids a DB write on every page load.
const LASTACTIVE_DEBOUNCE_MS = 5 * 60 * 1000 // 5 minutes

// Future instant in SQLite space format (UTC, no T/Z/fraction) for stored
// expires_at columns. ISO into these columns breaks string-compare ordering.
function expiryDb(durationMs: number): string {
  return new Date(Date.now() + durationMs).toISOString().slice(0, 19).replace('T', ' ')
}

// GET /auth/demo-mode — unauthenticated login bootstrap; used by the Login page to
// show the demo button and to render the Turnstile widget. The sitekey is public
// (safe to ship); an empty string means no widget is rendered (fail-open, mirrors
// the TURNSTILE_SECRET_KEY server gate) — so a self-hoster who hasn't configured
// Turnstile gets a working login form.
authRoutes.get('/demo-mode', (c) => {
  return c.json({
    demoMode: c.env.DEMO_MODE === 'true',
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? '',
  })
})

// POST /auth/demo-login — instant login as demo user; only available when DEMO_MODE=true
authRoutes.post('/demo-login', async (c) => {
  if (c.env.DEMO_MODE !== 'true') return c.json({ error: 'Not found' }, 404)

  const db = getDb(c.env.DB)
  const user = await db.select().from(users).where(eq(users.id, 'demo-user')).get()
  if (!user) return c.json({ error: 'Demo user not seeded' }, 500)

  // Hand out the ONE shared demo session rather than minting a row per call.
  // This endpoint is on the visitor entry path — web/src/pages/Login.tsx
  // auto-posts it whenever demoMode is true and the visit isn't manual — so a
  // fresh `sessions` row per request is the same unbounded growth from bot
  // traffic that ensureDemoSession was written to stop (see demoSession.ts).
  // Idempotent, and it now hands out the same session the HTML auto-login
  // middleware does instead of a second, divergent one.
  const sessionToken = await ensureDemoSession(c.env.DB)

  // Same cookie the auto-login middleware sets, built by the same helper so the
  // two can't drift. Appended raw because hono's setCookie rejects the
  // far-future Expires the shared session uses.
  const res = c.json({ redirect: '/' })
  res.headers.append('Set-Cookie', demoSessionCookie(sessionToken))
  return res
})

// POST /auth/magic-link
authRoutes.post('/magic-link', async (c) => {
  // Per-IP rate limit: the per-user active-link cap below can't stop
  // a flood across MANY different emails from one source (each also costs a
  // central superadmin-allowlist lookup). Cap by client IP first, before any
  // work. Fails open when the binding is absent (dev/tests).
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!(await checkRateLimit(c.env.LOGIN_RATE_LIMITER, `magic-link:${ip}`))) {
    return c.json({ error: 'Too many requests. Please wait a moment and try again.' }, 429)
  }

  const body = await c.req.json<{ email?: string; turnstileToken?: string }>().catch(() => ({} as { email?: string; turnstileToken?: string }))

  // Turnstile gate (stub): fails OPEN until the operator sets TURNSTILE_SECRET_KEY;
  // once set, a missing/invalid token is rejected. Frontend must POST `turnstileToken`.
  if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip))) {
    return c.json({ error: 'Verification required.' }, 403)
  }

  if (!body.email || typeof body.email !== 'string') {
    return c.json({ error: 'email is required' }, 400)
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(body.email)) {
    return c.json({ error: 'Invalid email address' }, 400)
  }

  const db = getDb(c.env.DB)
  const normalizedEmail = body.email.toLowerCase().trim()

  let user = await db.select().from(users).where(eq(users.email, normalizedEmail)).get()

  if (!user && (await isSuperadminEmailViaCentral(c.env, normalizedEmail))) {
    const id = crypto.randomUUID()
    await db.insert(users).values({ id, email: normalizedEmail, name: '', role: 'admin' })
    user = await db.select().from(users).where(eq(users.id, id)).get() ?? undefined
  }

  if (user) {
    // Rate limit: max 5 active (unexpired, unused) magic links per user at a time.
    // Raised from 3 → 5: paired with the 60-min TTL so a confused user clicking
    // "resend" a few times isn't silently cut off before their first link expires.
    const activeLinks = await db
      .select({ id: magicLinks.id })
      .from(magicLinks)
      .where(and(eq(magicLinks.userId, user.id), isNull(magicLinks.usedAt), gt(sql`datetime(${magicLinks.expiresAt})`, sql`datetime('now')`)))
      .all()
    if (activeLinks.length >= 5) {
      await recordAuthEvent(db, { event: 'rate_limited', email: user.email, userId: user.id, linkType: 'login', ...authReqContext(c) })
      return c.json({ message: 'Check your email for a sign-in link.' })
    }

    const rawToken = await generateToken()
    const tokenHash = await hashToken(rawToken)
    const expiresAt = expiryDb(MAGIC_LINK_DURATION_MS)

    await db.insert(magicLinks).values({
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash,
      expiresAt,
    })

    await recordAuthEvent(db, { event: 'link_requested', email: user.email, userId: user.id, linkType: 'login', ...authReqContext(c) })

    const url = `${c.env.APP_URL}/auth/verify?token=${encodeURIComponent(rawToken)}`
    try {
      c.executionCtx.waitUntil(sendMagicLink(user.email, url, c.env, 'login', db, user.id).catch(console.error))
    } catch {
      // No ExecutionContext in test environments — fire and forget
      sendMagicLink(user.email, url, c.env, 'login', db, user.id).catch(console.error)
    }
  } else {
    await recordAuthEvent(db, {
      event: 'link_requested_unknown',
      email: normalizedEmail,
      userId: null,
      linkType: 'login',
      ...authReqContext(c),
    })
  }

  return c.json({ message: 'Check your email for a sign-in link.' })
})

// GET /auth/verify?token=<raw_token>
authRoutes.get('/verify', async (c) => {
  const rawToken = c.req.query('token')
  if (!rawToken) return c.json({ error: 'token is required' }, 400)
  return c.redirect(`${c.env.APP_URL}/auth/verify?token=${encodeURIComponent(rawToken)}`, 302)
})

// POST /auth/verify
authRoutes.post('/verify', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }))
  if (!body.token || typeof body.token !== 'string') {
    return c.json({ error: 'token is required' }, 400)
  }

  const db = getDb(c.env.DB)
  const tokenHash = await hashToken(body.token)

  const result = await db
    .update(magicLinks)
    .set({ usedAt: nowDb() })
    .where(
      and(
        eq(magicLinks.tokenHash, tokenHash),
        isNull(magicLinks.usedAt),
        gt(sql`datetime(${magicLinks.expiresAt})`, sql`datetime('now')`),
      ),
    )
    .returning({ id: magicLinks.id, userId: magicLinks.userId })

  if (result.length === 0) {
    const link = await db
      .select({ expiresAt: magicLinks.expiresAt, usedAt: magicLinks.usedAt, userId: magicLinks.userId })
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, tokenHash))
      .get()

    const failEmail = link
      ? (await db.select({ email: users.email }).from(users).where(eq(users.id, link.userId)).get())?.email ?? 'unknown'
      : 'unknown'
    const reason = !link ? 'invalid' : link.usedAt ? 'used' : 'expired'
    await recordAuthEvent(db, { event: 'verify_failed', email: failEmail, userId: link?.userId ?? null, reason, linkType: null, ...authReqContext(c) })

    if (!link) {
      console.error('[auth/verify] Invalid token — no matching magic link found. Hash prefix:', tokenHash.slice(0, 8))
      return c.json({ error: 'invalid' }, 400)
    }
    if (link.usedAt) {
      console.error('[auth/verify] Token already used. Used at:', link.usedAt, 'Hash prefix:', tokenHash.slice(0, 8))
      return c.json({ error: 'used' }, 400)
    }
    console.error('[auth/verify] Token expired. Expired at:', link.expiresAt, 'Hash prefix:', tokenHash.slice(0, 8))
    return c.json({ error: 'expired' }, 400)
  }

  const { userId } = result[0]

  const sessionToken = await generateToken()
  const sessionHash = await hashToken(sessionToken)
  const expiresInstant = new Date(Date.now() + SESSION_DURATION_MS)
  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: sessionHash,
    expiresAt: expiryDb(SESSION_DURATION_MS),
  })

  setCookie(c, 'session', sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires: expiresInstant,
  })

  const verifiedUser = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .get()

  // Tenants no longer mint the cross-tenant superadmin SSO cookie. Central is the
  // SOLE issuer: it sets the `.<parent-domain>`-scoped `superadmin_jwt` cookie on
  // a central-verified dashboard login (e.g. admin.example.com), and each tenant's
  // /auth/me below bootstraps a local session from it. Minting here would let a
  // compromised tenant forge a superadmin token without a real login (H2).

  await recordAuthEvent(db, { event: 'verify_success', email: verifiedUser?.email ?? 'unknown', userId, linkType: null, ...authReqContext(c) })

  return c.json({ ok: true })
})

// GET /auth/me
authRoutes.get('/me', async (c) => {
  const rawToken = getCookie(c, 'session')

  if (!rawToken) {
    if (c.env.SUPERADMIN_JWT_PUBLIC_KEY) {
      const jwtToken = getCookie(c, 'superadmin_jwt')
      if (jwtToken) {
        const payload = await verifySuperadminJwt(jwtToken, c.env.SUPERADMIN_JWT_PUBLIC_KEY)
        if (payload) {
          const db = getDb(c.env.DB)
          let localUser = await db.select().from(users).where(eq(users.email, payload.email)).get()
          if (!localUser) {
            const id = crypto.randomUUID()
            await db.insert(users).values({ id, email: payload.email, name: payload.name, role: 'admin' })
            localUser = await db.select().from(users).where(eq(users.id, id)).get()!
          }
          const sessionToken = await generateToken()
          const sessionHash = await hashToken(sessionToken)
          const expiresInstant = new Date(Date.now() + SESSION_DURATION_MS)
          await db.insert(sessions).values({
            id: crypto.randomUUID(),
            userId: localUser!.id,
            tokenHash: sessionHash,
            expiresAt: expiryDb(SESSION_DURATION_MS),
          })
          setCookie(c, 'session', sessionToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
            path: '/',
            expires: expiresInstant,
          })
          await db.update(users).set({ lastActive: nowDb() }).where(eq(users.id, localUser!.id))
          return c.json({
            id: localUser!.id,
            email: localUser!.email,
            name: localUser!.name,
            role: localUser!.role,
            subtitle: localUser!.subtitle,
            canVote: !!localUser!.canVote,
            emailDigestEnabled: localUser!.emailDigestEnabled === 1,
            emailWeekAheadEnabled: localUser!.emailWeekAheadEnabled === 1,
            lastSeenFeed: localUser!.lastSeenFeed ?? null,
            isLastOwner: localUser!.role === 'owner' && (await countActiveOwners(db)) <= 1,
          })
        }
      }
    }
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = getDb(c.env.DB)
  const tokenHash = await hashToken(rawToken)

  const sessionWithUser = await db
    .select({
      sessionId: sessions.id,
      sessionExpiry: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      subtitle: users.subtitle,
      canVote: users.canVote,
      emailDigestEnabled: users.emailDigestEnabled,
      emailWeekAheadEnabled: users.emailWeekAheadEnabled,
      lastSeenFeed: users.lastSeenFeed,
      lastActive: users.lastActive,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .get()

  if (!sessionWithUser) return c.json({ error: 'Not authenticated' }, 401)
  // sessionExpiry may be space format ("YYYY-MM-DD HH:MM:SS", UTC); dbTsToEpoch
  // normalizes both shapes so the compare is UTC-correct (raw `new Date()` on the
  // space form would be parsed as local time by V8).
  if (dbTsToEpoch(sessionWithUser.sessionExpiry) < Date.now()) {
    return c.json({ error: 'Session expired' }, 401)
  }

  const newExpiryInstant = new Date(Date.now() + SESSION_DURATION_MS)
  await db
    .update(sessions)
    .set({ expiresAt: expiryDb(SESSION_DURATION_MS), lastActive: nowDb() })
    .where(eq(sessions.id, sessionWithUser.sessionId))

  // Debounce: only write users.last_active when it's missing or stale (>5 min).
  // The sessions update above (expiresAt + its own last_active) always runs.
  if (
    !sessionWithUser.lastActive ||
    dbTsToEpoch(sessionWithUser.lastActive) < Date.now() - LASTACTIVE_DEBOUNCE_MS
  ) {
    await db
      .update(users)
      .set({ lastActive: nowDb() })
      .where(eq(users.id, sessionWithUser.userId))
  }

  setCookie(c, 'session', rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires: newExpiryInstant,
  })

  return c.json({
    id: sessionWithUser.userId,
    email: sessionWithUser.email,
    name: sessionWithUser.name,
    role: sessionWithUser.role,
    subtitle: sessionWithUser.subtitle,
    canVote: !!sessionWithUser.canVote,
    emailDigestEnabled: sessionWithUser.emailDigestEnabled === 1,
    emailWeekAheadEnabled: sessionWithUser.emailWeekAheadEnabled === 1,
    lastSeenFeed: sessionWithUser.lastSeenFeed ?? null,
    isLastOwner: sessionWithUser.role === 'owner' && (await countActiveOwners(db)) <= 1,
  })
})

// POST /auth/logout
authRoutes.post('/logout', async (c) => {
  const rawToken = getCookie(c, 'session')
  if (rawToken) {
    const db = getDb(c.env.DB)
    const tokenHash = await hashToken(rawToken)
    const session = await db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.tokenHash, tokenHash)).get()
    if (session) {
      const u = await db.select({ email: users.email }).from(users).where(eq(users.id, session.userId)).get()
      await recordAuthEvent(db, { event: 'logout', email: u?.email ?? 'unknown', userId: session.userId, ...authReqContext(c) })
    }
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash))
  }
  deleteCookie(c, 'session', { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' })
  const cookieDomain = getSuperAdminCookieDomain(c.env.APP_URL, parseAppDomains(c.env.APP_DOMAINS))
  deleteCookie(c, 'superadmin_jwt', {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  })
  return c.json({ ok: true })
})
