import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import { getProvider } from '../providers/index'
import { secretsMatch } from '../lib/auth'
import type { Env } from '../types'

export const billsRoutes = new Hono<{ Bindings: Env }>()

billsRoutes.use('*', async (c, next) => {
  if (!(await secretsMatch(c.req.header('x-admin-secret'), c.env.ADMIN_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})

billsRoutes.get('/sessions', async (c) => {
  const state = c.req.query('state')?.toUpperCase()
  if (!state) return c.json({ error: 'state is required' }, 400)
  const db = drizzle(c.env.DB, { schema })
  const provider = getProvider(c.env, db)
  const sessions = await provider.fetchSessions(state)
  return c.json({ sessions })
})

billsRoutes.get('/:id{ocd-bill/[^/]+}', async (c) => {
  const billId = c.req.param('id')
  const db = drizzle(c.env.DB, { schema })
  const bill = await db.select().from(schema.bills).where(eq(schema.bills.billId, billId)).get()
  if (!bill) return c.json({ error: 'not found' }, 404)

  const sessionRow = bill.sessionId
    ? await db.select({ sessionName: schema.sessions.sessionName }).from(schema.sessions).where(eq(schema.sessions.sessionId, bill.sessionId)).get()
    : null

  let texts: object[] = []
  let documents: object[] = []
  let actions: object[] = []
  let sponsors: object[] = []
  let votes: object[] = []
  let relatedBills: object[] = []

  if (bill.providerData) {
    try {
      const parsed = JSON.parse(bill.providerData)
      texts = (parsed.versions ?? []).map((v: any) => ({
        docId: v.id,
        note: v.note,
        date: v.date,
        links: v.links,
      }))
      documents = (parsed.documents ?? []).map((d: any) => ({
        docId: d.id,
        note: d.note,
        date: d.date,
        classification: d.classification,
        links: d.links,
      }))
      actions = parsed.actions ?? []
      sponsors = parsed.sponsors ?? []
      votes = parsed.votes ?? []
      relatedBills = parsed.relatedBills ?? []
    } catch (err) {
      console.error('[bills] failed to parse providerData for bill', billId, err)
    }
  }

  return c.json({ ...bill, sessionName: sessionRow?.sessionName ?? null, texts, documents, actions, sponsors, votes, relatedBills })
})

billsRoutes.get('/:id{ocd-bill/[^/]+}/text', async (c) => {
  const billId = c.req.param('id')
  const db = drizzle(c.env.DB, { schema })
  const bill = await db.select({ textR2Key: schema.bills.textR2Key })
    .from(schema.bills)
    .where(eq(schema.bills.billId, billId))
    .get()

  if (!bill?.textR2Key) return c.json({ error: 'no text available' }, 404)

  const obj = await c.env.BILLS_BUCKET.get(bill.textR2Key)
  if (!obj) return c.json({ error: 'text not found in storage' }, 404)

  const isPdf = bill.textR2Key.endsWith('.pdf')
  if (isPdf) {
    // Use Buffer.from for base64 (~250-350x faster than a char-by-char btoa
    // loop on multi-MB PDFs, and avoids ~200 MB of transient heap allocation).
    // Requires nodejs_compat — set in wrangler.toml.
    const buf = await obj.arrayBuffer()
    return c.json({ type: 'pdf', content: Buffer.from(buf).toString('base64') })
  } else {
    return c.json({ type: 'html', content: await obj.text() })
  }
})

billsRoutes.get('/:id{ocd-bill/[^/]+}/text/:docId', async (c) => {
  const billId = c.req.param('id')
  const docId = c.req.param('docId')
  const uuid = billId.replace('ocd-bill/', '')

  const htmlKey = `bills/${uuid}/${docId}.html`
  const pdfKey = `bills/${uuid}/${docId}.pdf`

  let obj = await c.env.BILLS_BUCKET.get(htmlKey)
  let contentType = 'text/html; charset=utf-8'
  if (!obj) {
    obj = await c.env.BILLS_BUCKET.get(pdfKey)
    contentType = 'application/pdf'
  }
  if (!obj) {
    // Fall back to the bill's seed text (uploaded via PUT /admin/bills/:id/seed-text)
    const db = drizzle(c.env.DB, { schema })
    const bill = await db.select({ textR2Key: schema.bills.textR2Key })
      .from(schema.bills)
      .where(eq(schema.bills.billId, billId))
      .get()
    if (bill?.textR2Key) {
      obj = await c.env.BILLS_BUCKET.get(bill.textR2Key)
      contentType = bill.textR2Key.endsWith('.pdf') ? 'application/pdf' : 'text/plain; charset=utf-8'
    }
  }
  if (!obj) return c.json({ error: 'not found' }, 404)

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? contentType,
      'Content-Disposition': 'inline',
    },
  })
})
