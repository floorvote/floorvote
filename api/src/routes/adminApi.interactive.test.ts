/**
 * Interactive flag origination invariant tests.
 *
 * Only two admin routes are allowed to set interactive: true on queue messages:
 *   1. POST /admin/reprocess-bill/:externalId — sends directly to BILL_QUEUE
 *   2. POST /admin/promote-bill/:billId — POSTs to central with { interactive: true }
 *
 * All background bulk routes must NOT set interactive on any queue message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../index'
import {
  resetDb,
  applyMigrations,
  seedUser,
  seedSession,
  seedBill,
} from '../../test/helpers'
import { getDb } from '../db/client'
import { associationConfig, bills } from '../db/schema'
import { eq } from 'drizzle-orm'

vi.mock('../lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))

vi.mock('../lib/email', () => ({
  sendMagicLink: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../cron/sync', () => ({
  registerWithCentral: vi.fn().mockResolvedValue(undefined),
}))

describe('interactive flag origination invariant', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`

    // Reset centralFetch mock before each test
    const { centralFetch } = await import('../lib/centralFetch')
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response)
  })

  describe('POST /admin/reprocess-bill/:externalId — MUST set interactive: true', () => {
    it('sends interactive: true on the queue message', async () => {
      let sent: unknown = undefined
      const mockQueue = {
        send: vi.fn().mockImplementation((msg: unknown) => {
          sent = msg
          return Promise.resolve()
        }),
      }

      const res = await app.request('/api/admin/reprocess-bill/legiscan%3A12345', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      expect(res.status).toBe(200)
      expect(mockQueue.send).toHaveBeenCalledOnce()
      const msg = sent as Record<string, unknown>
      expect(msg.interactive).toBe(true)
    })
  })

  describe('POST /admin/promote-bill/:billId — MUST send interactive: true to central', () => {
    it('sends { interactive: true } in the central fetch body', async () => {
      const { centralFetch } = await import('../lib/centralFetch')
      vi.mocked(centralFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, matchType: 'keyword' }),
      } as Response)

      // Seed a bill with a legiscan externalId so promote-bill can find it
      const db = getDb(env.DB)
      const billId = await seedBill({
        externalId: 'legiscan:99999',
        billNumber: 'HB 99',
        title: 'Test Promote Bill',
        matchType: null,
      })

      const res = await app.request(`/api/admin/promote-bill/${billId}`, {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, env)

      expect(res.status).toBe(200)
      expect(vi.mocked(centralFetch)).toHaveBeenCalledOnce()

      const [, , opts] = vi.mocked(centralFetch).mock.calls[0]
      const body = JSON.parse((opts as RequestInit & { body: string }).body)
      expect(body.interactive).toBe(true)
    })
  })

  describe('POST /admin/reprocess-llm-all — must NOT set interactive', () => {
    it('sends no interactive flag on any queued message', async () => {
      await seedBill({ externalId: 'legiscan:1', billNumber: 'HB 1', matchType: 'keyword' })
      await seedBill({ externalId: 'legiscan:2', billNumber: 'HB 2', matchType: 'manual' })

      const sent: Array<{ body: Record<string, unknown> }> = []
      const mockQueue = {
        sendBatch: vi.fn().mockImplementation((msgs: Array<{ body: Record<string, unknown> }>) => {
          sent.push(...msgs)
          return Promise.resolve()
        }),
      }

      const res = await app.request('/api/admin/reprocess-llm-all', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      expect(res.status).toBe(200)
      expect(sent.length).toBeGreaterThan(0)
      // No message may carry interactive
      for (const msg of sent) {
        expect(msg.body).not.toHaveProperty('interactive')
      }
    })
  })

  describe('POST /admin/keyword-resync — must NOT set interactive', () => {
    it('sends no interactive flag on any queued message', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({
        key: 'keywords',
        value: JSON.stringify(['election', 'ballot']),
      })

      // Unprocessed bill that matches keywords — will be queued
      await seedBill({
        externalId: 'legiscan:10',
        billNumber: 'HB 10',
        title: 'Election Reform Bill',
        matchType: null,
        aiProcessedAt: undefined,
      })

      const sent: Array<{ body: Record<string, unknown> }> = []
      const mockQueue = {
        sendBatch: vi.fn().mockImplementation((msgs: Array<{ body: Record<string, unknown> }>) => {
          sent.push(...msgs)
          return Promise.resolve()
        }),
      }

      const res = await app.request('/api/admin/keyword-resync', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      expect(res.status).toBe(200)
      expect(sent.length).toBeGreaterThan(0)
      // No message may carry interactive
      for (const msg of sent) {
        expect(msg.body).not.toHaveProperty('interactive')
      }
    })
  })
})
