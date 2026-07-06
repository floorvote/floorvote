import { describe, it, expect } from 'vitest'
import { getSuperAdminCookieDomain } from '../../src/lib/superadmin'

const DOMAINS = ['example.com', 'example.org']

describe('getSuperAdminCookieDomain', () => {
  it('returns .example.com for a *.example.com URL', () => {
    expect(getSuperAdminCookieDomain('https://nj.example.com', DOMAINS)).toBe('.example.com')
  })

  it('returns .example.com for the example.com apex domain', () => {
    expect(getSuperAdminCookieDomain('https://example.com', DOMAINS)).toBe('.example.com')
  })

  it('returns .example.org for a *.example.org URL (migration alias)', () => {
    expect(getSuperAdminCookieDomain('https://nj.example.org', DOMAINS)).toBe('.example.org')
  })

  it('returns the matching apex for a single-domain deployment', () => {
    expect(getSuperAdminCookieDomain('https://app.example.org', ['example.org'])).toBe('.example.org')
  })

  it('returns undefined when the domain list is empty (host-only cookie)', () => {
    expect(getSuperAdminCookieDomain('https://nj.example.com', [])).toBeUndefined()
  })

  it('returns undefined for a host matching no configured domain (e.g. workers.dev)', () => {
    expect(getSuperAdminCookieDomain('https://my-app.acct.workers.dev', DOMAINS)).toBeUndefined()
  })

  it('returns undefined for localhost', () => {
    expect(getSuperAdminCookieDomain('http://localhost:5173', DOMAINS)).toBeUndefined()
  })
})
