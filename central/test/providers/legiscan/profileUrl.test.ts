import { describe, it, expect } from 'vitest'
import { legiscan } from '../../../src/providers/legiscan'
import { lims } from '../../../src/providers/lims'
import { lis } from '../../../src/providers/lis'
import { mga } from '../../../src/providers/mga'

const stored = (p: { biography?: string | null; ballotpedia?: string | null }) => ({
  bio: p.biography === undefined || p.biography === null ? null : { social: { biography: p.biography } },
  ballotpedia: p.ballotpedia ?? null,
})

describe('LegiScan profileUrl', () => {
  const profileUrl = (p: Parameters<typeof stored>[0]) => legiscan.profileUrl!(stored(p))

  it('prefers the official bio page', () => {
    expect(profileUrl({ biography: 'https://legislature.example/members/diaz', ballotpedia: 'Ana_Diaz' })).toBe('https://legislature.example/members/diaz')
  })
  it('falls back to Ballotpedia', () => {
    expect(profileUrl({ ballotpedia: 'Ana_Diaz' })).toBe('https://ballotpedia.org/Ana_Diaz')
  })
  it('is null with neither, so the last-resort page stays a sponsor-only link', () => {
    expect(profileUrl({})).toBeNull()
  })
  it('skips a bio page that is not http(s)', () => {
    expect(profileUrl({ biography: 'javascript:alert(1)', ballotpedia: 'Ana_Diaz' })).toBe('https://ballotpedia.org/Ana_Diaz')
    expect(profileUrl({ biography: 'data:text/html,hi' })).toBeNull()
  })
  it('keeps the legiscan.com page as personUrl', () => {
    expect(legiscan.personUrl!({ state: 'RI', name: 'Ana Diaz', peopleId: 1 })).toBe('https://legiscan.com/RI/people/Ana-Diaz/id/1')
  })
})

describe('providers that declare no profile url', () => {
  it.each([['lims', lims], ['lis', lis], ['mga', mga]])('%s declares none', (_id, provider) => {
    expect(provider.profileUrl).toBeUndefined()
  })
})
