import { Hono } from 'hono'
import { centralFetch } from '../../lib/centralFetch'
import type { AppEnv } from '../../types'

export function registerLabelRoutes(router: Hono<AppEnv>) {
  // GET /bills/labels?state=XX — explainers for a state's statuses, bill types,
  // and event types, plus its display details (calendar name, whether it has
  // events), from the vocabulary of the provider central reads the state from.
  // The web app shows a bill's status explainer as a tooltip.
  router.get('/labels', async (c) => {
    const state = c.req.query('state')?.toUpperCase() ?? ''
    if (!/^[A-Z]{2}$/.test(state)) return c.json({ error: 'state is required' }, 400)

    const upstream = await centralFetch(c.env, `/bills/labels?state=${state}`)
    if (!upstream.ok) return c.json({ error: 'Labels not available' }, 502)

    // Vocabularies change only when central is deployed.
    return c.json(await upstream.json(), 200, { 'Cache-Control': 'private, max-age=3600' })
  })
}
