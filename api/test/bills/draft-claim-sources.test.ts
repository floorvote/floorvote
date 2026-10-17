import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, appFetch, stubFetch, seedUser, seedSession } from '../helpers'

// Editing a summary keeps only the claim sources whose claim is still in the
// edited text (#569). Drafts are the one bill whose summary is edited by hand.
// A draft holds none from an analysis, so these put some on the row directly.

const item = (claim: string, start: number, extra: Record<string, unknown> = {}) => ({
  claim, quote: 'q', status: 'exact', claimAt: { start, end: start + claim.length }, quoteAt: { start: 4, end: 5 }, matched: 'q', ...extra,
})

describe('PATCH /api/bills/:id/draft and claim sources', () => {
  let token: string
  let id: string

  async function patch(body: Record<string, unknown>) {
    const res = await appFetch(`https://x/api/bills/${id}/draft`, {
      method: 'PATCH',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
  }
  const stored = async () => {
    const r = await env.DB.prepare('SELECT claim_sources, claim_sources_doc_id, claim_sources_text_hash FROM bills WHERE id = ?').bind(id).first<Record<string, string | null>>()
    return { ...r!, items: r!.claim_sources === null ? null : JSON.parse(r!.claim_sources) as Array<Record<string, unknown>> }
  }

  beforeEach(async () => {
    stubFetch()
    await resetDb()
    await applyMigrations()
    token = await seedSession(await seedUser({ email: 'admin@x.com', role: 'admin' }))
    const res = await appFetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'UT', title: 'Draft', summary: 'Sets penalties. Requires drop boxes.' }),
    })
    id = (await res.json<{ id: string }>()).id
    await env.DB.prepare('UPDATE bills SET claim_sources = ?, claim_sources_doc_id = ?, claim_sources_text_hash = ? WHERE id = ?')
      .bind(JSON.stringify([item('Sets penalties.', 0), item('Requires drop boxes.', 16)]), '7001', 'hash-7001', id).run()
  })

  it('drops the claim sources whose claim is no longer in the edited summary', async () => {
    await patch({ summary: 'Requires drop boxes.' })
    const r = await stored()
    expect(r.items).toEqual([item('Requires drop boxes.', 0)])
    expect(r).toMatchObject({ claim_sources_doc_id: '7001', claim_sources_text_hash: 'hash-7001' })
  })

  it('moves a kept claim to where the edited summary has it', async () => {
    await patch({ summary: 'A new opening. Sets penalties. Requires drop boxes.' })
    expect((await stored()).items).toEqual([item('Sets penalties.', 15), item('Requires drop boxes.', 31)])
  })

  it('drops every claim source when the summary is cleared', async () => {
    await patch({ summary: '' })
    expect((await stored()).items).toEqual([])
  })

  it('drops a claim that was reworded', async () => {
    await patch({ summary: 'Sets a penalty. Requires drop boxes.' })
    expect((await stored()).items).toEqual([item('Requires drop boxes.', 16)])
  })

  it('leaves them alone when the summary is not part of the edit', async () => {
    await patch({ title: 'Renamed' })
    expect((await stored()).items).toEqual([item('Sets penalties.', 0), item('Requires drop boxes.', 16)])
  })

  it('leaves them as they were when the summary is edited to the same text', async () => {
    await patch({ summary: 'Sets penalties. Requires drop boxes.' })
    expect((await stored()).items).toEqual([item('Sets penalties.', 0), item('Requires drop boxes.', 16)])
  })

  it('has nothing to do for a draft with no claim sources', async () => {
    await env.DB.prepare('UPDATE bills SET claim_sources = NULL, claim_sources_doc_id = NULL, claim_sources_text_hash = NULL WHERE id = ?').bind(id).run()
    await patch({ summary: 'Something else.' })
    expect(await stored()).toMatchObject({ claim_sources: null, claim_sources_doc_id: null, claim_sources_text_hash: null })
  })

  it('keeps nothing when the claim sources are not a list', async () => {
    await env.DB.prepare('UPDATE bills SET claim_sources = ? WHERE id = ?').bind('not json', id).run()
    await patch({ summary: 'Requires drop boxes.' })
    expect((await stored()).items).toEqual([])
  })
})
