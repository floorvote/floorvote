import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth'
import { centralFetch } from '../lib/centralFetch'
import type { AppEnv } from '../types'

/**
 * GET /api/directory: the DC Council's committees (chair, members, key staff,
 * agencies) and staff directory, synced daily by central from dccouncil.gov.
 * Public work contacts, shown to signed-in members.
 */
export const directoryRouter = new Hono<AppEnv>()

directoryRouter.get('/', requireAuth, async (c) => {
  const res = await centralFetch(c.env, '/bills/council-directory')
  if (!res.ok) return c.json({ error: 'The Council directory is unavailable right now.' }, 502)
  return c.json(await res.json())
})
