import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, isNull, gt, sql } from 'drizzle-orm'
import * as schema from '../db/schema-legiscan'
import {
  generateToken,
  hashToken,
  isSuperAdmin,
  createAdminSession,
  lookupAdminSession,
  deleteAdminSession,
  type DashEnv,
} from '../lib/adminAuth'
import { verifySuperadminJwt, SUPERADMIN_TOKEN_TTL_SEC } from '../lib/superadminJwt'
import { isSuperadminJtiRevoked } from '../lib/superadminRevocation'
import { mintSuperadminToken } from '../lib/superadminIssuer'
import { getSuperadminCookieDomain } from '../lib/superadminCookie'
import { sendAdminMagicLink } from '../lib/adminEmail'
import { nowDb } from '../lib/dbTime'
import { checkRateLimit } from '../../../shared/rateLimit'
import { verifyTurnstile } from '../../../shared/turnstile'

export const dashAuthRoutes = new Hono<DashEnv>()

const MAGIC_LINK_TTL_MS = 30 * 60 * 1000

// Max active (unused, unexpired) magic links per address. Mirrors the tenant
// login cap (api auth.ts) — superadmin addresses are public, so without a cap an
// attacker could email-bomb one / burn Resend quota by spamming /login.
const MAX_ACTIVE_ADMIN_LINKS = 5

// GET /admin/dash/auth/config — public login bootstrap; serves the public Turnstile
// sitekey to the dashboard login form. Empty string = no widget (fail-open, mirrors
// the TURNSTILE_SECRET_KEY server gate) so a self-hoster without Turnstile can log in.
dashAuthRoutes.get('/config', (c) => {
  return c.json({
    data: { turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? '' },
    meta: { generatedAt: new Date().toISOString() },
  })
})

// GET /admin/dash/auth/me — returns identity or 401/403
dashAuthRoutes.get('/me', async (c) => {
  const db = drizzle(c.env.DB, { schema })

  // 1. Existing central session cookie wins
  const sessionToken = getCookie(c, 'admin_session')
  if (sessionToken) {
    const session = await lookupAdminSession(db, sessionToken)
    if (session) {
      return c.json({ data: { email: session.email, name: session.name }, meta: { generatedAt: new Date().toISOString() } })
    }
  }

  // 2. SSO bootstrap from parent-domain-scoped JWT (ES256, central is issuer)
  const jwt = getCookie(c, 'superadmin_jwt')
  if (!jwt || !c.env.SUPERADMIN_JWT_PUBLIC_KEY) {
    return c.json({ error: { code: 'unauthorized', message: 'Not signed in' } }, 401)
  }
  const payload = await verifySuperadminJwt(jwt, c.env.SUPERADMIN_JWT_PUBLIC_KEY, {
    isRevoked: (jti) => isSuperadminJtiRevoked(db, jti),
  })
  if (!payload) {
    return c.json({ error: { code: 'unauthorized', message: 'Invalid token' } }, 401)
  }
  if (!isSuperAdmin(payload.email, c.env.SUPERADMIN_EMAILS)) {
    return c.json({ error: { code: 'forbidden', message: 'Not authorized' } }, 403)
  }

  const { rawToken, expiresAt } = await createAdminSession(db, payload.email, payload.name)
  setCookie(c, 'admin_session', rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  })
  return c.json({ data: { email: payload.email, name: payload.name }, meta: { generatedAt: new Date().toISOString() } })
})

// POST /admin/dash/auth/login — request magic link
dashAuthRoutes.post('/login', async (c) => {
  // Per-IP rate limit (finding D2): the per-address active-link cap below is
  // keyed on the (allowlisted) email, so it can't throttle a flood from one
  // source probing the endpoint. Cap by client IP first. Fails open without the
  // binding (dev/tests).
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!(await checkRateLimit(c.env.LOGIN_RATE_LIMITER, `dash-login:${ip}`))) {
    return c.json({ error: { code: 'rate_limited', message: 'Too many requests. Please wait and try again.' } }, 429)
  }

  const body = await c.req.json<{ email?: string; turnstileToken?: string }>().catch(() => ({} as { email?: string; turnstileToken?: string }))

  // Turnstile gate (stub): fails OPEN until TURNSTILE_SECRET_KEY is set; once set,
  // a missing/invalid token is rejected. Frontend must POST `turnstileToken`.
  if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip))) {
    return c.json({ error: { code: 'verification_required', message: 'Verification required.' } }, 403)
  }

  const email = body.email?.toLowerCase().trim()
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!email || !emailRegex.test(email)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid email' } }, 400)
  }

  // Always return 200 — no enumeration
  if (!isSuperAdmin(email, c.env.SUPERADMIN_EMAILS)) {
    return c.json({ data: { ok: true }, meta: { generatedAt: new Date().toISOString() } })
  }
  if (!c.env.RESEND_API_KEY || !c.env.ADMIN_APP_URL) {
    console.warn('Admin /login: allowlisted email but RESEND_API_KEY or ADMIN_APP_URL is unset; no email sent', { email })
    return c.json({ data: { ok: true }, meta: { generatedAt: new Date().toISOString() } })
  }

  const db = drizzle(c.env.DB, { schema })

  // Per-address active-link cap (finding D4): refuse silently (still 200, no
  // enumeration) once too many unused, unexpired links exist for this address,
  // so a known superadmin email can't be email-bombed and Resend quota can't be
  // burned. Expired/used links don't count.
  const activeLinks = await db
    .select({ id: schema.magicLinks.id })
    .from(schema.magicLinks)
    .where(and(
      eq(schema.magicLinks.email, email),
      isNull(schema.magicLinks.usedAt),
      gt(sql`datetime(${schema.magicLinks.expiresAt})`, sql`datetime('now')`),
    ))
    .all()
  if (activeLinks.length >= MAX_ACTIVE_ADMIN_LINKS) {
    return c.json({ data: { ok: true }, meta: { generatedAt: new Date().toISOString() } })
  }

  const rawToken = await generateToken()
  const tokenHash = await hashToken(rawToken)
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString()
  await db.insert(schema.magicLinks).values({
    id: crypto.randomUUID(),
    email,
    tokenHash,
    expiresAt,
  })

  const url = `${c.env.ADMIN_APP_URL}/admin/dash/auth/callback?token=${encodeURIComponent(rawToken)}`
  try {
    await sendAdminMagicLink(email, url, c.env)
  } catch (err) {
    console.error('sendAdminMagicLink failed', err)
  }
  return c.json({ data: { ok: true }, meta: { generatedAt: new Date().toISOString() } })
})

// GET /admin/dash/auth/callback?token=... — two-step verify (scanner pre-fetch
// protection, mirrors the tenant /auth/verify). This GET does NOT consume the
// token: it redirects to the SPA interstitial, which POSTs to consume it. Email
// security appliances that pre-fetch the link only hit this idempotent redirect,
// so the human's later click still works.
dashAuthRoutes.get('/callback', (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: { code: 'bad_request', message: 'Missing token' } }, 400)
  const base = c.env.ADMIN_APP_URL ?? ''
  return c.redirect(`${base}/auth/verify?token=${encodeURIComponent(token)}`, 302)
})

// POST /admin/dash/auth/callback — consume the token, mint the admin session and
// the cross-tenant superadmin SSO cookie. Called by the SPA interstitial.
dashAuthRoutes.post('/callback', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }))
  const token = body.token
  if (!token) return c.json({ error: { code: 'bad_request', message: 'Missing token' } }, 400)
  const db = drizzle(c.env.DB, { schema })
  const tokenHash = await hashToken(token)
  const link = await db.select().from(schema.magicLinks).where(eq(schema.magicLinks.tokenHash, tokenHash)).get()
  if (!link) return c.json({ error: { code: 'unauthorized', message: 'Invalid token' } }, 401)
  if (link.usedAt) return c.json({ error: { code: 'unauthorized', message: 'Token already used' } }, 401)
  if (new Date(link.expiresAt).getTime() < Date.now()) {
    return c.json({ error: { code: 'unauthorized', message: 'Token expired' } }, 401)
  }
  // Re-check allowlist — the email may have been removed since the link was issued
  if (!isSuperAdmin(link.email, c.env.SUPERADMIN_EMAILS)) {
    return c.json({ error: { code: 'forbidden', message: 'Email no longer authorized' } }, 403)
  }
  // Atomic "mark used": conditional UPDATE that only succeeds if used_at IS NULL.
  // Two concurrent requests with the same token could both pass the SELECT check above,
  // so we guard here: only the first UPDATE wins (rows_written = 1); the second gets 0.
  const updateResult = await db
    .update(schema.magicLinks)
    .set({ usedAt: nowDb() })
    .where(and(eq(schema.magicLinks.id, link.id), isNull(schema.magicLinks.usedAt)))
    .run()
  const rowsChanged = (updateResult as any)?.meta?.rows_written ?? 0
  if (rowsChanged === 0) {
    return c.json({ error: { code: 'unauthorized', message: 'Token already used' } }, 401)
  }
  const { rawToken: sessionToken, expiresAt } = await createAdminSession(db, link.email)
  setCookie(c, 'admin_session', sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  })

  // Central is the SOLE issuer of the cross-tenant superadmin SSO cookie. On a
  // central-verified dashboard login, ALSO set `superadmin_jwt` scoped to the
  // parent registrable domain (e.g. `.example.com`) so the browser sends it to
  // every tenant subdomain; each tenant's `/auth/me` verifies it with the public
  // key and bootstraps a local admin session — "log in once at admin.example.com,
  // logged into every tenant". Tenants no longer mint this token (closes H2).
  // Gated on the allowlist (the verify above already re-checked it) and on a
  // private key being present — fail safe (no cookie) otherwise.
  const ssoToken = await mintSuperadminToken(c.env, link.email, '')
  if (ssoToken) {
    const cookieDomain = getSuperadminCookieDomain(c.env.ADMIN_APP_URL)
    // Expire the cookie when the JWT itself does (short TTL, finding M3) — not at
    // the 30-day local admin_session expiry — so the browser stops presenting a
    // dead token. The local admin_session and per-tenant sessions it bootstraps
    // persist independently.
    setCookie(c, 'superadmin_jwt', ssoToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      expires: new Date(Date.now() + SUPERADMIN_TOKEN_TTL_SEC * 1000),
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    })
  }

  return c.json({ data: { ok: true }, meta: { generatedAt: new Date().toISOString() } })
})

// POST /admin/dash/auth/logout — clear session
dashAuthRoutes.post('/logout', async (c) => {
  const sessionToken = getCookie(c, 'admin_session')
  if (sessionToken) {
    const db = drizzle(c.env.DB, { schema })
    await deleteAdminSession(db, sessionToken)
  }
  deleteCookie(c, 'admin_session', { path: '/' })
  return c.json({ data: { ok: true }, meta: { generatedAt: new Date().toISOString() } })
})
