import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { listNotifications, markAllRead, markCommentRead, markBillRead } from '../lib/notifications'
import type { AppEnv } from '../types'

export const notificationsRouter = new Hono<AppEnv>()
notificationsRouter.use('*', requireAuth)

notificationsRouter.get('/', async (c) => {
  const result = await listNotifications(getDb(c.env.DB), c.get('user').id)
  // `mentions` is the pre-#352 name for this list. A tab still running the old
  // web bundle across the deploy reads only `mentions`, and without it would
  // show an empty panel and then mark everything read when it opens. That bundle
  // draws every row as a mention, so the alias carries mentions only. Remove the
  // alias in the release after the one that ships #352.
  return c.json({ ...result, mentions: result.notifications.filter(n => n.kind === 'mention') })
})

notificationsRouter.post('/mark-read', async (c) => {
  await markAllRead(getDb(c.env.DB), c.get('user').id)
  return c.json({ ok: true })
})

notificationsRouter.post('/mark-read/:commentId', async (c) => {
  await markCommentRead(getDb(c.env.DB), c.get('user').id, c.req.param('commentId'))
  return c.json({ ok: true })
})

notificationsRouter.post('/mark-read-by-bill/:billId', async (c) => {
  await markBillRead(getDb(c.env.DB), c.get('user').id, c.req.param('billId'))
  return c.json({ ok: true })
})
