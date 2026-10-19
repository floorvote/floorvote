import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getDb } from '../db/client'
import { muteFromLink } from '../lib/billMutes'
import { checkRateLimit } from '../../../shared/rateLimit'
import type { AppEnv } from '../types'

// POST /api/mute-link: mute a bill from a reply email, with no session (#355).
//
// Two callers. A mail client's one-click unsubscribe (RFC 8058) posts to the
// List-Unsubscribe URL, token in the query, with a `List-Unsubscribe=One-Click`
// form body this route ignores. The /mute-bill page, opened from the email's
// footer link, posts the token in a JSON body once the member presses its
// button. Neither is a GET, so a mail scanner following links mutes nothing.
//
// The token is signed for one member and one bill (lib/billMutes.ts), so it can
// mute only that. Every refusal is the same 404, whatever was wrong with it.
//
// Unauthenticated, and every request costs an HMAC check, so it is rate limited
// per client IP (#531), under its own key so a burst here can't spend anyone's
// login or status-check budget. Mail providers send one-click POSTs from a few
// shared IPs, so it has its own, higher budget on MUTE_LINK_RATE_LIMITER (#685).
// An instance whose wrangler.toml predates that binding falls back to
// LOGIN_RATE_LIMITER, as before, so nothing breaks before an operator adds it.
// The key is the
// IP alone: a token in it would let a flooder vary the token on every request
// and never reach the cap. The check runs first, before the body-size check and
// before the token is read, so a refusal says nothing about whether a token is
// valid. Fails open when neither binding is present (dev/tests), like every other
// use. A bound mute limiter that errors fails open on its own, without falling
// back to the login budget.
export const muteLinkRouter = new Hono<AppEnv>()

const NOT_VALID = { error: 'This link is not valid.' }

muteLinkRouter.post('/', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!(await checkRateLimit(c.env.MUTE_LINK_RATE_LIMITER ?? c.env.LOGIN_RATE_LIMITER, `mute-link:${ip}`))) {
    return c.json({ error: 'Too many requests. Please wait a moment and try again.' }, 429)
  }
  await next()
}, bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
  let token: unknown = c.req.query('token')
  if (token === undefined && (c.req.header('content-type') ?? '').includes('application/json')) {
    const body = await c.req.json<{ token?: unknown }>().catch(() => null)
    token = body?.token
  }
  const muted = await muteFromLink(getDb(c.env.DB), token)
  if (!muted) return c.json(NOT_VALID, 404)
  return c.json(muted)
})
