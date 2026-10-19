import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth'
import { senderFor, resolveAssocName } from '../lib/email'
import { renderFeedbackEmail } from '../lib/feedbackEmail'
import { describeSendFailure } from '../lib/emailErrors'
import { validEmailList } from '../../../shared/operator'
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
    const recipients = validEmailList(c.env.OPERATOR_CONTACT_EMAILS, 'OPERATOR_CONTACT_EMAILS')
    if (recipients.length === 0) {
      throw new Error('Feedback not configured — OPERATOR_CONTACT_EMAILS is empty or has no valid address')
    }
    const { subject, html } = renderFeedbackEmail({
      fromEmail: user.email,
      message: body.message.trim(),
      pageUrl: body.pageUrl,
      appUrl: c.env.APP_URL,
      assocName: await resolveAssocName(c.env, getDb(c.env.DB)),
    })
    // Operator mail: the sender falls back, never counts it toward email health
    // (so no db), and sends on a demo too.
    const r = await senderFor(c.env).send({ purpose: 'operator', to: recipients, subject, html })
    if (!r.ok) throw new Error(describeSendFailure(r))
  } catch (err) {
    console.error('feedback send failed:', err)
    return c.json({ error: 'Failed to send feedback' }, 500)
  }

  return c.json({ ok: true })
})

export { feedbackRouter }
