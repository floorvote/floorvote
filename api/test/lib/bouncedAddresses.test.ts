import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedAuthEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { previouslyBouncedAddresses, isPreviouslyBounced } from '../../src/lib/bouncedAddresses'

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

function checkOne(central: unknown, email: string) {
  return isPreviouslyBounced({ CENTRAL: central as Fetcher }, getDb(env.DB), email)
}

/** How a deployed binding behaves when the remote worker lacks a method: calling it throws. */
const missingRpcMethod = () => vi.fn(async () => { throw new TypeError('The RPC receiver does not implement the method "emailSuppressionMany".') })

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

  describe('latest recorded outcome', () => {
    it('does not count an address delivered to after it bounced', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'back@example.com', createdAt: '2026-01-01 00:00:00' })
      await seedAuthEvent(memberId, 'email_delivered', { email: 'back@example.com', createdAt: '2026-01-02 00:00:00' })
      expect(await check({}, ['back@example.com'])).toEqual(new Set())
    })

    it('counts an address that bounced after a delivery', async () => {
      await seedAuthEvent(memberId, 'email_delivered', { email: 'gone-bad@example.com', createdAt: '2026-01-01 00:00:00' })
      await seedAuthEvent(memberId, 'email_bounced', { email: 'gone-bad@example.com', createdAt: '2026-01-02 00:00:00' })
      expect(await check({}, ['gone-bad@example.com'])).toEqual(new Set(['gone-bad@example.com']))
    })

    it('judges by time, not insertion order, when the times differ', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'late@example.com', createdAt: '2026-01-02 00:00:00' })
      await seedAuthEvent(memberId, 'email_delivered', { email: 'late@example.com', createdAt: '2026-01-01 00:00:00' })
      expect(await check({}, ['late@example.com'])).toEqual(new Set(['late@example.com']))
    })

    it('breaks a same-second tie by insertion order', async () => {
      const at = '2026-01-01 00:00:00'
      await seedAuthEvent(memberId, 'email_bounced', { email: 'cleared@example.com', createdAt: at })
      await seedAuthEvent(memberId, 'email_delivered', { email: 'cleared@example.com', createdAt: at })
      await seedAuthEvent(memberId, 'email_delivered', { email: 'still-bad@example.com', createdAt: at })
      await seedAuthEvent(memberId, 'email_bounced', { email: 'still-bad@example.com', createdAt: at })
      expect(await check({}, ['cleared@example.com', 'still-bad@example.com'])).toEqual(new Set(['still-bad@example.com']))
    })

    it("clears a bounce with a later delivery recorded under a different member's row, in any case", async () => {
      const otherId = await seedUser({ email: 'other@example.com' })
      await seedAuthEvent(memberId, 'email_bounced', { email: 'moved@example.com', createdAt: '2026-01-01 00:00:00' })
      await seedAuthEvent(otherId, 'email_delivered', { email: ' Moved@Example.COM', createdAt: '2026-01-02 00:00:00' })
      expect(await check({}, ['moved@example.com'])).toEqual(new Set())
    })

    it.each(['email_send_failed', 'email_sent', 'link_requested', 'email_complained'])(
      'is not cleared by a later %s event',
      async (event) => {
        await seedAuthEvent(memberId, 'email_bounced', { email: 'bad@example.com', createdAt: '2026-01-01 00:00:00' })
        await seedAuthEvent(memberId, event, { email: 'bad@example.com', createdAt: '2026-01-02 00:00:00' })
        expect(await check({}, ['bad@example.com'])).toEqual(new Set(['bad@example.com']))
      },
    )

    it('judges each address by its own latest outcome', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'a@example.com', createdAt: '2026-01-01 00:00:00' })
      await seedAuthEvent(memberId, 'email_bounced', { email: 'b@example.com', createdAt: '2026-01-01 00:00:00' })
      await seedAuthEvent(memberId, 'email_delivered', { email: 'a@example.com', createdAt: '2026-01-02 00:00:00' })
      expect(await check({}, ['a@example.com', 'b@example.com'])).toEqual(new Set(['b@example.com']))
    })

    it('still counts an address the suppression list has, even after a recorded delivery', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'listed@example.com', createdAt: '2026-01-01 00:00:00' })
      await seedAuthEvent(memberId, 'email_delivered', { email: 'listed@example.com', createdAt: '2026-01-02 00:00:00' })
      const central = centralWith({ 'listed@example.com': { suppressed: true } })
      expect(await check(central, ['listed@example.com'])).toEqual(new Set(['listed@example.com']))
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

    it('when central lacks the batch method (an older central), without asking one address at a time', async () => {
      const central = { emailSuppression: vi.fn(async () => ({ suppressed: true })) }
      expect(await check(central, emails)).toEqual(expected)
      expect(central.emailSuppression).not.toHaveBeenCalled()
    })

    it('when calling the batch method throws because central lacks it, without asking one address at a time', async () => {
      const central = { emailSuppressionMany: missingRpcMethod(), emailSuppression: vi.fn(async () => ({ suppressed: true })) }
      expect(await check(central, emails)).toEqual(expected)
      expect(central.emailSuppression).not.toHaveBeenCalled()
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

  describe('isPreviouslyBounced (one address)', () => {
    it('counts a recorded bounce, normalizing the address', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'bad@example.com' })
      expect(await checkOne({}, ' Bad@Example.com ')).toBe(true)
      expect(await checkOne({}, 'good@example.com')).toBe(false)
    })

    it('does not count an address delivered to after it bounced', async () => {
      await seedAuthEvent(memberId, 'email_bounced', { email: 'back@example.com', createdAt: '2026-01-01 00:00:00' })
      await seedAuthEvent(memberId, 'email_delivered', { email: 'back@example.com', createdAt: '2026-01-02 00:00:00' })
      expect(await checkOne({}, 'back@example.com')).toBe(false)
    })

    it('uses the batch method when central has it, and never the single lookup', async () => {
      const central = { ...centralWith({ 'listed@example.com': { suppressed: true } }), emailSuppression: vi.fn(async () => ({ suppressed: false })) }
      expect(await checkOne(central, 'Listed@Example.com')).toBe(true)
      expect(central.emailSuppressionMany).toHaveBeenCalledWith(['listed@example.com'])
      expect(central.emailSuppression).not.toHaveBeenCalled()
    })

    describe('falls back to the single-address lookup when central lacks the batch method', () => {
      it.each([
        ['is undefined', undefined],
        ['throws when called, as a deployed binding does', missingRpcMethod()],
      ])('refuses a suppressed address when the batch method %s', async (_label, emailSuppressionMany) => {
        const emailSuppression = vi.fn(async (_email: string) => ({ suppressed: true, reason: 'hard_bounce' }))
        expect(await checkOne({ emailSuppressionMany, emailSuppression }, ' Listed@Example.com')).toBe(true)
        expect(emailSuppression).toHaveBeenCalledOnce()
        expect(emailSuppression).toHaveBeenCalledWith('listed@example.com')
      })

      it.each([
        ['is undefined', undefined],
        ['throws when called, as a deployed binding does', missingRpcMethod()],
      ])('allows the address when the batch method %s and the single lookup throws', async (_label, emailSuppressionMany) => {
        const emailSuppression = vi.fn(async () => { throw new Error('lookup down') })
        expect(await checkOne({ emailSuppressionMany, emailSuppression }, 'maybe@example.com')).toBe(false)
        expect(emailSuppression).toHaveBeenCalledOnce()
      })

      it.each([
        ['cannot tell', { suppressed: null }],
        ['says not suppressed', { suppressed: false }],
        ['returns nothing', undefined],
      ])('allows the address when the single lookup %s', async (_label, answer) => {
        expect(await checkOne({ emailSuppression: vi.fn(async () => answer) }, 'maybe@example.com')).toBe(false)
      })

      it('still counts a recorded bounce when the single lookup throws', async () => {
        await seedAuthEvent(memberId, 'email_bounced', { email: 'bad@example.com' })
        const central = { emailSuppressionMany: missingRpcMethod(), emailSuppression: vi.fn(async () => { throw new Error('lookup down') }) }
        expect(await checkOne(central, 'bad@example.com')).toBe(true)
      })

      it('counts only recorded bounces when central has neither method', async () => {
        await seedAuthEvent(memberId, 'email_bounced', { email: 'bad@example.com' })
        expect(await checkOne({}, 'bad@example.com')).toBe(true)
        expect(await checkOne({}, 'fine@example.com')).toBe(false)
        expect(await isPreviouslyBounced({ CENTRAL: undefined } as never, getDb(env.DB), 'fine@example.com')).toBe(false)
      })
    })

    it('returns false for an empty address without asking central', async () => {
      const central = { ...centralWith({}), emailSuppression: vi.fn() }
      expect(await checkOne(central, '   ')).toBe(false)
      expect(central.emailSuppressionMany).not.toHaveBeenCalled()
      expect(central.emailSuppression).not.toHaveBeenCalled()
    })
  })
})
