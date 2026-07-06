import { describe, it, expect } from 'vitest'
import { getSuperadminCookieDomain } from './superadminCookie'

describe('getSuperadminCookieDomain', () => {
  it('derives the parent registrable domain from a subdomain admin URL', () => {
    expect(getSuperadminCookieDomain('https://admin.example.com')).toBe('.example.com')
  })

  it('handles a path on the admin URL', () => {
    expect(getSuperadminCookieDomain('https://admin.example.com/admin/dash')).toBe('.example.com')
  })

  it('handles a deeper subdomain (two-level admin host)', () => {
    expect(getSuperadminCookieDomain('https://dash.admin.example.com')).toBe('.admin.example.com')
  })

  it('returns undefined (host-only cookie) for an apex with no registrable parent', () => {
    // A bare two-label host: treating it as `.tld` would be wrong, so fail safe.
    expect(getSuperadminCookieDomain('https://example.com')).toBeUndefined()
  })

  it('drops one label for a multi-label workers.dev host', () => {
    // admin.<acct>.workers.dev → .<acct>.workers.dev — a harmless same-account scope.
    expect(getSuperadminCookieDomain('https://my-app-central-legiscan.my-org.workers.dev')).toBe('.my-org.workers.dev')
  })

  it('returns undefined for an unset / empty URL', () => {
    expect(getSuperadminCookieDomain(undefined)).toBeUndefined()
    expect(getSuperadminCookieDomain('')).toBeUndefined()
  })

  it('returns undefined for a malformed URL', () => {
    expect(getSuperadminCookieDomain('not a url')).toBeUndefined()
  })

  it('returns undefined for an IP host', () => {
    expect(getSuperadminCookieDomain('https://127.0.0.1')).toBeUndefined()
    expect(getSuperadminCookieDomain('https://192.168.1.1:8787')).toBeUndefined()
  })

  it('returns undefined for localhost', () => {
    expect(getSuperadminCookieDomain('http://localhost:5173')).toBeUndefined()
  })
})
