import { describe, it, expect } from 'vitest'
// shared/*.test.ts never runs in CI (per-package vitest roots), so this shared
// module is tested from the api tree — same as turnstile.test.ts.
import { setSecurityHeaders, CONTENT_SECURITY_POLICY } from '../../../shared/securityHeaders'

describe('setSecurityHeaders', () => {
  const applied = () => {
    const h = new Headers()
    setSecurityHeaders(h)
    return h
  }

  it('denies framing (clickjacking)', () => {
    expect(applied().get('X-Frame-Options')).toBe('DENY')
  })

  it('disables MIME sniffing', () => {
    expect(applied().get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('ships the CSP in report-only mode (never enforcing yet)', () => {
    const h = applied()
    expect(h.get('Content-Security-Policy-Report-Only')).toBe(CONTENT_SECURITY_POLICY)
    // Must NOT set the enforcing header — the enforce flip is a deliberate follow-up.
    expect(h.get('Content-Security-Policy')).toBeNull()
  })

  it('does not set HSTS (owned by the TLS-terminating edge, not the app)', () => {
    expect(applied().get('Strict-Transport-Security')).toBeNull()
  })
})

describe('CONTENT_SECURITY_POLICY', () => {
  it('locks the default to self', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'")
  })

  it('allows the app bundle and Turnstile script, but never unsafe-inline scripts', () => {
    const scriptSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('script-src '))
    expect(scriptSrc).toBeDefined()
    expect(scriptSrc).toContain("'self'")
    expect(scriptSrc).toContain('https://challenges.cloudflare.com')
    // The whole point of a script CSP: inline scripts stay disallowed.
    expect(scriptSrc).not.toContain("'unsafe-inline'")
  })

  it('allows Google Fonts and inline styles', () => {
    const styleSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('style-src '))
    expect(styleSrc).toContain("'unsafe-inline'")
    expect(styleSrc).toContain('https://fonts.googleapis.com')
    expect(CONTENT_SECURITY_POLICY).toContain('font-src')
    expect(CONTENT_SECURITY_POLICY).toContain('https://fonts.gstatic.com')
  })

  it('allows the Turnstile iframe', () => {
    const frameSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('frame-src '))
    expect(frameSrc).toContain('https://challenges.cloudflare.com')
  })

  it('blocks clickjacking and plugin/object embedding at the CSP layer too', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
  })
})
