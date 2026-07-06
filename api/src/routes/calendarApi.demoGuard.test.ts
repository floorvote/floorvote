import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../../test/helpers'
import { getDb } from '../db/client'
import { calendarEvents } from '../db/schema'

describe('calendarApi demoGuard', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
  })

  // ── DEMO MODE: mutations must be blocked ──────────────────────────────────

  it('POST /api/calendar/backfill is blocked by demoGuard in demo mode', async () => {
    const res = await app.request('/api/calendar/backfill', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/demo/i)
  })

  it('POST /api/calendar/events is blocked by demoGuard in demo mode', async () => {
    const res = await app.request('/api/calendar/events', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Test event', date: '2025-12-01' }),
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/demo/i)
  })

  it('PUT /api/calendar/events/:id is blocked by demoGuard in demo mode', async () => {
    // Seed a calendar event so the route can find it
    const db = getDb(env.DB)
    const eventId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: eventId,
      uid: `custom-${eventId}@example.com`,
      billId: null,
      source: 'custom',
      sequence: 0,
      date: '2025-12-01',
      time: null,
      location: null,
      description: 'Seeded event',
      details: null,
      url: null,
      status: 'confirmed',
      eventHash: null,
    })

    const res = await app.request(`/api/calendar/events/${eventId}`, {
      method: 'PUT',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Updated', date: '2025-12-02' }),
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/demo/i)
  })

  it('DELETE /api/calendar/events/:id is blocked by demoGuard in demo mode', async () => {
    const db = getDb(env.DB)
    const eventId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: eventId,
      uid: `custom-${eventId}@example.com`,
      billId: null,
      source: 'custom',
      sequence: 0,
      date: '2025-12-01',
      time: null,
      location: null,
      description: 'Seeded event',
      details: null,
      url: null,
      status: 'confirmed',
      eventHash: null,
    })

    const res = await app.request(`/api/calendar/events/${eventId}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/demo/i)
  })

  it('POST /api/calendar/events/:id/restore is blocked by demoGuard in demo mode', async () => {
    const db = getDb(env.DB)
    const eventId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: eventId,
      uid: `custom-${eventId}@example.com`,
      billId: null,
      source: 'custom',
      sequence: 0,
      date: '2025-12-01',
      time: null,
      location: null,
      description: 'Seeded event',
      details: null,
      url: null,
      status: 'cancelled',
      eventHash: null,
    })

    const res = await app.request(`/api/calendar/events/${eventId}/restore`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/demo/i)
  })

  it('POST /api/calendar/import is blocked by demoGuard in demo mode', async () => {
    const res = await app.request('/api/calendar/import', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: [] }),
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/demo/i)
  })

  it('POST /api/calendar/regenerate-slug is blocked by demoGuard in demo mode', async () => {
    const res = await app.request('/api/calendar/regenerate-slug', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/demo/i)
  })

  // ── NORMAL MODE: mutations must still work for admins ─────────────────────

  it('POST /api/calendar/events succeeds for admin when DEMO_MODE is unset', async () => {
    const res = await app.request('/api/calendar/events', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Normal event', date: '2025-12-01' }),
    }, { ...env, DEMO_MODE: undefined })
    expect(res.status).toBe(201)
  })

  it('PUT /api/calendar/events/:id succeeds for admin when DEMO_MODE is unset', async () => {
    const db = getDb(env.DB)
    const eventId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: eventId,
      uid: `custom-${eventId}@example.com`,
      billId: null,
      source: 'custom',
      sequence: 0,
      date: '2025-12-01',
      time: null,
      location: null,
      description: 'Original',
      details: null,
      url: null,
      status: 'confirmed',
      eventHash: null,
    })

    const res = await app.request(`/api/calendar/events/${eventId}`, {
      method: 'PUT',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Updated', date: '2025-12-02' }),
    }, { ...env, DEMO_MODE: undefined })
    expect(res.status).toBe(200)
  })
})
