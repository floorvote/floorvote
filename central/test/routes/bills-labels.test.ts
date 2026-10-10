import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

const headers = { 'x-admin-secret': 'test-secret' }
// A deployment with DC on LIMS: its env var names the state.
const LIMS_ENV = { ...env, LIMS_API_KEY: 'lims-key', LIMS_STATES: 'DC' }

type Labels = {
  state: string
  statuses: Array<{ label: string; stage: string | null; rank: number; explainer: string; terminal?: boolean }>
  billTypes: Array<{ value: string; label: string; explainer: string | null }>
  eventTypes: Array<{ typeId: number; label: string; explainer: string | null }>
  calendarName: string | null
  hasEvents: boolean
}

async function labels(state: string, e: object = env): Promise<Labels> {
  const res = await app.request(`/api/bills/labels?state=${state}`, { headers }, e)
  expect(res.status).toBe(200)
  return res.json() as Promise<Labels>
}

beforeEach(async () => {
  await setupLsDb()
})

describe('GET /bills/labels', () => {
  it('serves a LegiScan state\'s status explainers, by rank, with its bill and event types', async () => {
    const body = await labels('ri')
    expect(body.state).toBe('RI')
    expect(body.statuses.map(s => s.label)).toEqual([
      'Draft', 'Pre-filed', 'Introduced', 'Referred', 'Report DNP', 'Report Pass', 'Engrossed',
      'Enrolled', 'Failed', 'Vetoed', 'Passed', 'Override', 'Chaptered',
    ])
    expect(body.statuses.find(s => s.label === 'Enrolled')).toMatchObject({ stage: 'passed', rank: 401 })
    expect(body.billTypes.find(t => t.value === 'JR')?.label).toBe('Joint Resolution')
    expect(body.eventTypes.find(t => t.typeId === 1)?.label).toBe('Hearing')
    expect(body).toMatchObject({ calendarName: null, hasEvents: false })
  })

  it('keeps whether a status is final in central', async () => {
    const body = await labels('RI')
    expect(body.statuses.every(s => !('terminal' in s))).toBe(true)
  })

  it('serves DC\'s own statuses and types when LIMS reads DC', async () => {
    const body = await labels('DC', LIMS_ENV)
    expect(body.statuses.find(s => s.label === 'Under Mayoral Review')?.explainer).toMatch(/10 working days/)
    expect(body.statuses.find(s => s.label === 'Deemed Approved')).toMatchObject({ stage: 'enacted' })
    expect(body.billTypes.find(t => t.value === 'Emergency Bill')?.explainer).toMatch(/90 days/)
    expect(body.calendarName).toBe('DC Council calendar')
  })

  it('serves LegiScan\'s for DC when LIMS is off', async () => {
    const body = await labels('DC')
    expect(body.statuses.some(s => s.label === 'Under Mayoral Review')).toBe(false)
    expect(body.statuses.some(s => s.label === 'Engrossed')).toBe(true)
  })

  it('requires a two-letter state', async () => {
    expect((await app.request('/api/bills/labels', { headers }, env)).status).toBe(400)
    expect((await app.request('/api/bills/labels?state=DCX', { headers }, env)).status).toBe(400)
  })

  it('requires the admin secret', async () => {
    expect((await app.request('/api/bills/labels?state=RI', {}, env)).status).toBe(401)
  })
})

describe('GET /bills/:id status fields', () => {
  beforeEach(async () => {
    await drizzle(env.DB, { schema }).insert(schema.sessions).values({
      sessionId: 1, state: 'RI', stateId: 39, yearStart: 2025, yearEnd: 2026, sessionTitle: 'Regular Session', sessionName: '2025-2026 Regular Session',
    })
  })

  async function seedBill(billId: number, status: number) {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values({
      billId, sessionId: 1, state: 'RI', stateId: 39, billNumber: `H${billId}`, title: `Bill ${billId}`, changeHash: 'h', status,
    })
  }

  async function statusOf(billId: number) {
    const res = await app.request(`/api/bills/legiscan:${billId}`, { headers }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; statusStage: string | null; statusRank: number }
    return { status: body.status, statusStage: body.statusStage, statusRank: body.statusRank }
  }

  it('sends the status label with its stage and rank', async () => {
    await seedBill(1, 2)
    await seedBill(2, 8)
    expect(await statusOf(1)).toEqual({ status: 'Engrossed', statusStage: 'passed_one_chamber', statusRank: 301 })
    expect(await statusOf(2)).toEqual({ status: 'Chaptered', statusStage: 'enacted', statusRank: 703 })
  })

  it('sends a code the vocabulary doesn\'t list as its number, with no stage and rank 0', async () => {
    await seedBill(3, 99)
    expect(await statusOf(3)).toEqual({ status: '99', statusStage: null, statusRank: 0 })
  })
})
