import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedAuthEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { previouslyBouncedAddresses } from '../../src/lib/bouncedAddresses'

type Status = { suppressed: boolean | null; reason?: string }

/** A central binding whose batch suppression lookup answers with `answer` (or throws it). */
function centralWith(answer: Record<string, Status> | Error | unknown) {
  const emailSuppressionMany = vi.fn(async (_emails: string[]) => {
    if (answer instanceof Error) throw answer
    return answer as Record<string, Status>
  })
  return { emailSuppressionMany }
}

function check(central: unknown, emails: string[]) {
  return previouslyBouncedAddresses({ CENTRAL: central as Fetcher }, getDb(env.DB), emails)
}

describe('previouslyBouncedAddresses', () => {
  let memberId: string

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await resetDb()
    await applyMigrations()
    memberId = await seedUser({ email: 'someone@example.com' })
  })

  describe('recorded bounces', () => {
    it('counts an address with a recorded email_bounced event', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'bad@example.com' })
      expect(await check({}, ['bad@example.com', 'good@example.com'])).toEqual(new Set(['bad@example.com']))
    })

    it('matches without regard to case or surrounding spaces, on either side', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'Mixed.Case@Example.COM' })
      expect(await check({}, ['  MIXED.case@example.com '])).toEqual(new Set(['mixed.case@example.com']))
    })

    it("counts a bounce recorded against a different member's row", async () => {
      const otherId = await seedUser({ email: 'other@example.com' })
      await seedAuthEvent(otherId, 'email_bounced', { email: 'bad@example.com' })
      expect(await check({}, ['bad@example.com'])).toEqual(new Set(['bad@example.com']))
    })

    it("counts a deactivated member's recorded bounce", async () => {
      const goneId = await seedUser({ email: 'gone@example.com', deactivatedAt: '2026-01-01 00:00:00' })
      await seedAuthEvent(goneId, 'email_bounced', { email: 'gone@example.com' })
      expect(await check({}, ['gone@example.com'])).toEqual(new Set(['gone@example.com']))
    })

    it.each(['email_delivered', 'email_send_failed', 'email_sent', 'link_requested', 'email_changed'])(
      'does not count a %s event',
      async (event) => {
        await seedAuthEvent(memberId, event, { email: 'fine@example.com' })
        expect(await check({}, ['fine@example.com'])).toEqual(new Set())
      },
    )

    it('finds recorded bounces across a batch larger than one lookup can bind', async () => {
      for (const i of [0, 89, 90, 149]) await seedAuthEvent(memberId, 'email_bounced', { email: `big${i}@example.com` })
      const emails = Array.from({ length: 150 }, (_, i) => `big${i}@example.com`)
      expect(await check({}, emails)).toEqual(new Set(['big0@example.com', 'big89@example.com', 'big90@example.com', 'big149@example.com']))
    })

    it('returns an empty set for no addresses without asking central', async () => {
      const central = centralWith({})
      expect(await check(central, [])).toEqual(new Set())
      expect(central.emailSuppressionMany).not.toHaveBeenCalled()
    })
  })

  describe('suppression list', () => {
    it('counts an address only the suppression list has', async () => {
      const central = centralWith({ 'listed@example.com': { suppressed: true, reason: 'hard_bounce' }, 'clean@example.com': { suppressed: false } })
      expect(await check(central, ['listed@example.com', 'clean@example.com'])).toEqual(new Set(['listed@example.com']))
    })

    it('asks once for the whole batch, with normalized, de-duplicated addresses', async () => {
      const central = centralWith({})
      await check(central, [' A@Example.com', 'a@example.com', 'b@example.com'])
      expect(central.emailSuppressionMany).toHaveBeenCalledOnce()
      expect(central.emailSuppressionMany).toHaveBeenCalledWith(['a@example.com', 'b@example.com'])
    })

    it('does not count an address the list reports as unknown', async () => {
      const central = centralWith({ 'maybe@example.com': { suppressed: null } })
      expect(await check(central, ['maybe@example.com'])).toEqual(new Set())
    })
  })

  describe('both sources', () => {
    it('returns the union of recorded bounces and the suppression list', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'recorded@example.com' })
      await seedAuthEvent(memberId, 'email_bounced', { email: 'both@example.com' })
      const central = centralWith({
        'listed@example.com': { suppressed: true },
        'both@example.com': { suppressed: true },
        'clean@example.com': { suppressed: false },
      })
      expect(await check(central, ['recorded@example.com', 'listed@example.com', 'both@example.com', 'clean@example.com']))
        .toEqual(new Set(['recorded@example.com', 'listed@example.com', 'both@example.com']))
    })
  })

  describe('falls back to recorded bounces alone', () => {
    beforeEach(async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'recorded@example.com' })
    })

    const emails = ['recorded@example.com', 'other@example.com']
    const expected = new Set(['recorded@example.com'])

    it('when there is no central binding', async () => {
      expect(await previouslyBouncedAddresses({ CENTRAL: undefined } as never, getDb(env.DB), emails)).toEqual(expected)
    })

    it('when central lacks the batch method (an older central)', async () => {
      expect(await check({ emailSuppression: vi.fn() }, emails)).toEqual(expected)
    })

    it('when the method throws', async () => {
      expect(await check(centralWith(new Error('lookup down')), emails)).toEqual(expected)
    })

    it.each([
      ['unknown for every address', { 'recorded@example.com': { suppressed: null }, 'other@example.com': { suppressed: null } }],
      ['an empty object', {}],
      ['null', null],
      ['undefined', undefined],
      ['a non-object', 'nope'],
    ])('when the method returns %s', async (_label, answer) => {
      expect(await check(centralWith(answer), emails)).toEqual(expected)
    })
  })
})
