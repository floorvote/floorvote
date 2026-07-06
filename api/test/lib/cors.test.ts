import { describe, it, expect } from 'vitest'
import { isAllowedOrigin } from '../../src/lib/cors'

const APP_URL = 'https://demo.example.com'
const DOMAINS = ['example.com', 'example.org']

describe('isAllowedOrigin', () => {
  it('allows the exact APP_URL even with an empty domain list', () => {
    expect(isAllowedOrigin('https://demo.example.com', APP_URL, [])).toBe(true)
  })

  it('allows the localhost dev origin', () => {
    expect(isAllowedOrigin('http://localhost:5173', APP_URL, [])).toBe(true)
  })

  it('allows any subdomain of a configured domain', () => {
    expect(isAllowedOrigin('https://ri.example.com', APP_URL, DOMAINS)).toBe(true)
  })

  it('allows a second configured domain (migration alias)', () => {
    expect(isAllowedOrigin('https://demo.example.org', APP_URL, DOMAINS)).toBe(true)
  })

  it('rejects a configured-domain subdomain when the list is empty (same-origin only)', () => {
    expect(isAllowedOrigin('https://ri.example.com', APP_URL, [])).toBe(false)
  })

  it('allows a single-domain deployment', () => {
    expect(isAllowedOrigin('https://app.example.org', 'https://app.example.org', ['example.org'])).toBe(true)
  })

  it('rejects an unrelated origin', () => {
    expect(isAllowedOrigin('https://evil.com', APP_URL, DOMAINS)).toBe(false)
  })

  it('rejects a lookalike suffix', () => {
    expect(isAllowedOrigin('https://example.com.evil.com', APP_URL, DOMAINS)).toBe(false)
  })

  it('rejects a missing origin', () => {
    expect(isAllowedOrigin(undefined, APP_URL, DOMAINS)).toBe(false)
  })
})
