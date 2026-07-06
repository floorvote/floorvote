import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'

describe('canVote', () => {
  describe('GET /auth/me', () => {
    it('returns canVote true by default', async () => {
      await resetDb()
      await applyMigrations()
      const userId = await seedUser()
      const token = await seedSession(userId)
      const res = await SELF.fetch('http://localhost/api/auth/me', {
        headers: { Cookie: `session=${token}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.canVote).toBe(true)
    })

    it('returns canVote false for non-voting user', async () => {
      await resetDb()
      await applyMigrations()
      const userId = await seedUser({ canVote: false })
      const token = await seedSession(userId)
      const res = await SELF.fetch('http://localhost/api/auth/me', {
        headers: { Cookie: `session=${token}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.canVote).toBe(false)
    })
  })

  describe('vote permission enforcement', () => {
    let nonVoterToken: string
    let voterToken: string
    let billId: string

    beforeEach(async () => {
      await resetDb()
      await applyMigrations()
      const nonVoterId = await seedUser({ canVote: false, email: 'nonvoter@test.com' })
      nonVoterToken = await seedSession(nonVoterId)
      const voterId = await seedUser({ email: 'voter@test.com' })
      voterToken = await seedSession(voterId)
      billId = await seedBill()
    })

    it('rejects POST /bills/:id/votes for non-voting user', async () => {
      const res = await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
        method: 'POST',
        headers: { Cookie: `session=${nonVoterToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: 'support' }),
      })
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/not eligible to vote/i)
    })

    it('rejects DELETE /bills/:id/votes for non-voting user', async () => {
      const res = await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
        method: 'DELETE',
        headers: { Cookie: `session=${nonVoterToken}` },
      })
      expect(res.status).toBe(403)
    })

    it('allows POST /bills/:id/votes for voting user', async () => {
      const res = await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
        method: 'POST',
        headers: { Cookie: `session=${voterToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: 'support' }),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('PATCH /admin/members/:id canVote', () => {
    let adminToken: string
    let memberId: string

    beforeEach(async () => {
      await resetDb()
      await applyMigrations()
      const adminId = await seedUser({ role: 'admin', email: 'admin@test.com' })
      adminToken = await seedSession(adminId)
      memberId = await seedUser({ email: 'member@test.com' })
    })

    it('sets canVote to false', async () => {
      const res = await SELF.fetch(`http://localhost/api/admin/members/${memberId}`, {
        method: 'PATCH',
        headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ canVote: false }),
      })
      expect(res.status).toBe(200)

      // Verify via GET /admin/members
      const listRes = await SELF.fetch('http://localhost/api/admin/members', {
        headers: { Cookie: `session=${adminToken}` },
      })
      const members = await listRes.json() as { id: string; canVote: boolean }[]
      const updated = members.find(m => m.id === memberId)
      expect(updated?.canVote).toBe(false)
    })

    it('sets canVote back to true', async () => {
      // First set to false
      await SELF.fetch(`http://localhost/api/admin/members/${memberId}`, {
        method: 'PATCH',
        headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ canVote: false }),
      })
      // Then set back to true
      const res = await SELF.fetch(`http://localhost/api/admin/members/${memberId}`, {
        method: 'PATCH',
        headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ canVote: true }),
      })
      expect(res.status).toBe(200)

      const listRes = await SELF.fetch('http://localhost/api/admin/members', {
        headers: { Cookie: `session=${adminToken}` },
      })
      const members = await listRes.json() as { id: string; canVote: boolean }[]
      const updated = members.find(m => m.id === memberId)
      expect(updated?.canVote).toBe(true)
    })
  })
})
