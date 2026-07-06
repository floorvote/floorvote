import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth'
import { sendFeedback } from '../lib/email'
import { getDb } from '../db/client'
import type { AppEnv } from '../types'

const feedbackRouter = new Hono<AppEnv>()

feedbackRouter.use('*', requireAuth)

feedbackRouter.post('/', async (c) => {
  const body = await c.req.json<{ message?: string; pageUrl?: string }>().catch(() => ({} as { message?: string; pageUrl?: string }))
  if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
    return c.json({ error: 'message is required' }, 400)
  }
  if (new TextEncoder().encode(body.message).length > 20_480) {
    return c.json({ error: 'Message too long (max 20 KB)' }, 400)
  }

  const user = c.get('user')

  try {
    await sendFeedback(
      { email: user.email },
      body.message.trim(),
      body.pageUrl,
      c.env,
      getDb(c.env.DB),
    )
  } catch (err) {
    console.error('sendFeedback failed:', err)
    return c.json({ error: 'Failed to send feedback' }, 500)
  }

  return c.json({ ok: true })
})

export { feedbackRouter }
