import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { verifyAi } from '../../src/lib/verifyAi'
import { CentralApi } from '../../src/centralApi'
import { processCentralNotification } from '../../src/queue/processor'
import { bills, feedEvents, associationConfig } from '../../src/db/schema'
import { processBill } from '../../src/lib/llm'

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn() }
})

const gatewayEnv = {
  ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test',
  AI_GATEWAY_ENABLED: 'true', CF_ACCOUNT_ID: 'acct', CF_AIG_GATEWAY: 'gw', CF_AIG_TOKEN: 'tok',
} as any

const centralBill = { billId: 'legiscan:42', number: 'HB 100', title: 'Election Administration Act', abstract: 'An act relating to elections' }

let fetchMock: ReturnType<typeof vi.fn>

function central(opts: { bill?: Response; text?: Response } = {}) {
  fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes('/text')) return opts.text ?? new Response(JSON.stringify({ type: 'html', content: '<p>The full text</p>' }), { status: 200 })
    return opts.bill ?? new Response(JSON.stringify(centralBill), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.clearAllMocks()
  vi.mocked(processBill).mockResolvedValue({ summary: 'A summary', tags: ['Elections', 'Voting'], relevanceScore: 8, affectedCitations: [] })
  central()
})

describe('verifyAi', () => {
  it('analyzes the stored bill end to end and reports what came back', async () => {
    const r = await verifyAi(gatewayEnv, getDb(env.DB), 'legiscan:42')
    expect(r).toEqual({ status: 'ok', billNumber: 'HB 100', tags: 2, relevanceScore: 8, usedFullText: true })
    expect(processBill).toHaveBeenCalledTimes(1)
    const args = vi.mocked(processBill).mock.calls[0][0]
    expect(args).toMatchObject({ billNumber: 'HB 100', title: 'Election Administration Act' })
    expect(args.text).toContain('The full text')
  })

  it('leaves no bill, feed event, or tracked match behind', async () => {
    const db = getDb(env.DB)
    await verifyAi(gatewayEnv, db, 'legiscan:42')
    expect(await db.select().from(bills).all()).toEqual([])
    expect(await db.select().from(feedEvents).all()).toEqual([])
  })

  it('analyzes with the instance own AI context and taxonomy, as the real pipeline does', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values([
      { key: 'ai_context', value: JSON.stringify('You advise county clerks.') },
      { key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Clerk Duties', description: 'Duties of the clerk' }]) },
    ])
    await verifyAi(gatewayEnv, db, 'legiscan:42')
    const args = vi.mocked(processBill).mock.calls[0][0]
    expect(args.aiContext).toBe('You advise county clerks.')
    expect(args.taxonomy.map((t: { name: string }) => t.name)).toEqual(['Clerk Duties'])
  })

  it('asks for claim sources as the pipeline does, when central pins the text it served', async () => {
    central({ text: new Response(JSON.stringify({ type: 'html', content: '<p>The full text</p>', docId: '77', textHash: 'h77' }), { status: 200 }) })
    await verifyAi(gatewayEnv, getDb(env.DB), 'legiscan:42')
    expect(vi.mocked(processBill).mock.calls[0][0].claimSources).toBe(true)
  })

  it('does not ask for claim sources when central sends no doc id, as the pipeline does not', async () => {
    await verifyAi(gatewayEnv, getDb(env.DB), 'legiscan:42')
    expect(vi.mocked(processBill).mock.calls[0][0].claimSources).toBe(false)
  })

  it('falls back to the title and abstract when central has no text, and says so', async () => {
    central({ text: new Response('{}', { status: 404 }) })
    const r = await verifyAi(gatewayEnv, getDb(env.DB), 'legiscan:42')
    expect(r).toMatchObject({ status: 'ok', usedFullText: false })
    expect(vi.mocked(processBill).mock.calls[0][0].text).toContain('An act relating to elections')
  })

  it('is skipped, naming why, when the deployment has no AI configured', async () => {
    const r = await verifyAi({ ...gatewayEnv, AI_GATEWAY_ENABLED: 'false', GEMINI_API_KEY: '' }, getDb(env.DB), 'legiscan:42')
    expect(r.status).toBe('skipped')
    expect((r as { reason: string }).reason).toMatch(/AI_GATEWAY_ENABLED|GEMINI_API_KEY/)
    expect(processBill).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs on the direct-key path when the gateway is off but a Gemini key is set', async () => {
    const r = await verifyAi({ ...gatewayEnv, AI_GATEWAY_ENABLED: 'false', GEMINI_API_KEY: 'k' }, getDb(env.DB), 'legiscan:42')
    expect(r.status).toBe('ok')
  })

  it('is skipped on a demo instance, which never calls the model', async () => {
    const r = await verifyAi({ ...gatewayEnv, DEMO_MODE: 'true' }, getDb(env.DB), 'legiscan:42')
    expect(r.status).toBe('skipped')
    expect(processBill).not.toHaveBeenCalled()
  })

  it('rejects, keeping the message, when the model call fails', async () => {
    vi.mocked(processBill).mockRejectedValue(new Error('402 Insufficient wholesale credits'))
    await expect(verifyAi(gatewayEnv, getDb(env.DB), 'legiscan:42')).rejects.toThrow('402 Insufficient wholesale credits')
  })

  it('rejects when the gateway is enabled but a setting is missing, rather than skipping', async () => {
    vi.mocked(processBill).mockRejectedValue(new Error('AI_GATEWAY_ENABLED is true but CF_ACCOUNT_ID, CF_AIG_GATEWAY, or CF_AIG_TOKEN is missing'))
    await expect(verifyAi({ ...gatewayEnv, CF_AIG_TOKEN: undefined }, getDb(env.DB), 'legiscan:42')).rejects.toThrow(/CF_AIG_TOKEN/)
  })

  it('rejects when central cannot return the bill', async () => {
    central({ bill: new Response('{}', { status: 404 }) })
    await expect(verifyAi(gatewayEnv, getDb(env.DB), 'legiscan:42')).rejects.toThrow(/404/)
    expect(processBill).not.toHaveBeenCalled()
  })
})

describe('CentralApi verification entrypoints', () => {
  it('verifyAi() runs the same analysis', async () => {
    const entry = new CentralApi(createExecutionContext(), gatewayEnv)
    expect(await entry.verifyAi('legiscan:42')).toMatchObject({ status: 'ok', billNumber: 'HB 100' })
  })

  it('deliveryProbe() reports no probe until one has arrived, then the one that did', async () => {
    const entry = new CentralApi(createExecutionContext(), gatewayEnv)
    expect(await entry.deliveryProbe()).toEqual({ probe: null })
    await processCentralNotification({ tenantId: 'test-org', billId: 'legiscan:42', probe: 'n-9' }, gatewayEnv, getDb(env.DB))
    expect((await entry.deliveryProbe()).probe).toMatchObject({ nonce: 'n-9', billId: 'legiscan:42', readStatus: 200 })
  })
})
