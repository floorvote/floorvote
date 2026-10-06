import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { checkMemberAddresses } from '../../src/lib/memberAddress'

describe('checkMemberAddresses', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('returns an empty list for no addresses', async () => {
    expect(await checkMemberAddresses(getDb(env.DB), [])).toEqual([])
  })

  it('lowercases and trims before checking', async () => {
    const [r] = await checkMemberAddresses(getDb(env.DB), ['  Jane.Doe@Example.ORG '])
    expect(r).toEqual({ email: 'jane.doe@example.org', status: 'available' })
  })

  it('reports an active member, a deactivated member, and a different-case address as taken, with the member id', async () => {
    const activeId = await seedUser({ email: 'active@example.com' })
    const goneId = await seedUser({ email: 'gone@example.com', deactivatedAt: '2026-01-01 00:00:00' })
    const results = await checkMemberAddresses(getDb(env.DB), [
      'active@example.com',
      'gone@example.com',
      ' ACTIVE@Example.com',
    ])
    expect(results).toEqual([
      { email: 'active@example.com', status: 'taken', userId: activeId },
      { email: 'gone@example.com', status: 'taken', userId: goneId },
      { email: 'active@example.com', status: 'taken', userId: activeId },
    ])
  })

  it('finds a member whose stored address has mixed case', async () => {
    // Sign-in paths that predate normalization can store an address as typed.
    const id = await seedUser({ email: 'Pat.Lee@Example.COM' })
    const results = await checkMemberAddresses(getDb(env.DB), ['pat.lee@example.com', ' PAT.LEE@EXAMPLE.COM '])
    expect(results).toEqual([
      { email: 'pat.lee@example.com', status: 'taken', userId: id },
      { email: 'pat.lee@example.com', status: 'taken', userId: id },
    ])
  })

  it('marks malformed, blank, missing, and trailing-punctuation addresses invalid without stripping punctuation', async () => {
    const results = await checkMemberAddresses(getDb(env.DB), [
      'not-an-email',
      '',
      '   ',
      undefined,
      null,
      'Jane@Example.gov;',
      'bob@example.gov.',
      '<pat@example.gov>',
    ])
    expect(results).toEqual([
      { email: 'not-an-email', status: 'invalid' },
      { email: '', status: 'invalid' },
      { email: '', status: 'invalid' },
      { email: '', status: 'invalid' },
      { email: '', status: 'invalid' },
      { email: 'jane@example.gov;', status: 'invalid' },
      { email: 'bob@example.gov.', status: 'invalid' },
      { email: '<pat@example.gov>', status: 'invalid' },
    ])
  })

  it('does not report an invalid address as taken even if a member row holds it', async () => {
    // Rows predating the stricter rule can hold malformed addresses.
    await seedUser({ email: 'legacy@example.gov;' })
    const [r] = await checkMemberAddresses(getDb(env.DB), ['legacy@example.gov;'])
    expect(r.status).toBe('invalid')
  })

  it('keeps one result per input, in order, including repeats', async () => {
    const id = await seedUser({ email: 'taken@example.com' })
    const results = await checkMemberAddresses(getDb(env.DB), [
      'new@example.com',
      'taken@example.com',
      'new@example.com',
      'bad',
      'taken@example.com',
    ])
    expect(results.map(r => r.status)).toEqual(['available', 'taken', 'available', 'invalid', 'taken'])
    expect(results[4]).toEqual({ email: 'taken@example.com', status: 'taken', userId: id })
  })

  it('finds members across more addresses than one query can bind', async () => {
    const ids = new Map<number, string>()
    for (const i of [0, 89, 90, 179, 249]) ids.set(i, await seedUser({ email: `m${i}@example.com` }))
    const results = await checkMemberAddresses(
      getDb(env.DB),
      Array.from({ length: 250 }, (_, i) => `m${i}@example.com`),
    )
    expect(results).toHaveLength(250)
    const taken = results.flatMap((r, i) => (r.status === 'taken' ? [[i, r.userId]] : []))
    expect(taken).toEqual([...ids.entries()])
  })
})
