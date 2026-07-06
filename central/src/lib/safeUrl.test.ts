import { describe, it, expect } from 'vitest'
import { isSafeTenantApiUrl } from './safeUrl'

describe('isSafeTenantApiUrl', () => {
  // --- accepted ---
  it('accepts a normal https hostname', () => {
    expect(isSafeTenantApiUrl('https://ri.example.com')).toBe(true)
  })
  it('accepts https with subdomain', () => {
    expect(isSafeTenantApiUrl('https://staging.example.com')).toBe(true)
  })
  it('accepts https with path', () => {
    expect(isSafeTenantApiUrl('https://ri.example.com/some/path')).toBe(true)
  })
  it('accepts https with port on a real hostname', () => {
    expect(isSafeTenantApiUrl('https://ri.example.com:8443')).toBe(true)
  })

  // --- scheme rejections ---
  it('rejects http scheme', () => {
    expect(isSafeTenantApiUrl('http://ri.example.com')).toBe(false)
  })
  it('rejects ftp scheme', () => {
    expect(isSafeTenantApiUrl('ftp://ri.example.com')).toBe(false)
  })
  it('rejects file scheme', () => {
    expect(isSafeTenantApiUrl('file:///etc/passwd')).toBe(false)
  })
  it('rejects malformed / non-URL string', () => {
    expect(isSafeTenantApiUrl('not-a-url')).toBe(false)
  })
  it('rejects empty string', () => {
    expect(isSafeTenantApiUrl('')).toBe(false)
  })

  // --- loopback ---
  it('rejects https://localhost', () => {
    expect(isSafeTenantApiUrl('https://localhost')).toBe(false)
  })
  it('rejects https://LOCALHOST (case-insensitive)', () => {
    expect(isSafeTenantApiUrl('https://LOCALHOST')).toBe(false)
  })
  it('rejects https://127.0.0.1', () => {
    expect(isSafeTenantApiUrl('https://127.0.0.1')).toBe(false)
  })
  it('rejects https://127.1.2.3 (127/8 range)', () => {
    expect(isSafeTenantApiUrl('https://127.1.2.3')).toBe(false)
  })
  it('rejects https://[::1] IPv6 loopback', () => {
    expect(isSafeTenantApiUrl('https://[::1]')).toBe(false)
  })

  // --- link-local / metadata ---
  it('rejects http://169.254.169.254 (AWS metadata)', () => {
    expect(isSafeTenantApiUrl('http://169.254.169.254')).toBe(false)
  })
  it('rejects https://169.254.1.1 (169.254/16 range)', () => {
    expect(isSafeTenantApiUrl('https://169.254.1.1')).toBe(false)
  })

  // --- RFC-1918 private ranges ---
  it('rejects https://10.0.0.1 (10/8)', () => {
    expect(isSafeTenantApiUrl('https://10.0.0.1')).toBe(false)
  })
  it('rejects https://10.255.255.255', () => {
    expect(isSafeTenantApiUrl('https://10.255.255.255')).toBe(false)
  })
  it('rejects https://172.16.0.1 (172.16/12)', () => {
    expect(isSafeTenantApiUrl('https://172.16.0.1')).toBe(false)
  })
  it('rejects https://172.31.255.255 (top of 172.16/12)', () => {
    expect(isSafeTenantApiUrl('https://172.31.255.255')).toBe(false)
  })
  it('rejects https://192.168.1.1 (192.168/16)', () => {
    expect(isSafeTenantApiUrl('https://192.168.1.1')).toBe(false)
  })
  it('rejects https://192.168.0.0', () => {
    expect(isSafeTenantApiUrl('https://192.168.0.0')).toBe(false)
  })

  // --- IPv6 private / unique-local ---
  it('rejects https://[fc00::1] (fc00::/7 unique-local)', () => {
    expect(isSafeTenantApiUrl('https://[fc00::1]')).toBe(false)
  })
  it('rejects https://[fd12:3456:789a::1] (fd00::/8 sub-range of fc00::/7)', () => {
    expect(isSafeTenantApiUrl('https://[fd12:3456:789a::1]')).toBe(false)
  })

  // --- bare hostnames / .local ---
  it('rejects https://internal (no dot = bare hostname)', () => {
    expect(isSafeTenantApiUrl('https://internal')).toBe(false)
  })
  it('rejects https://myapp (no dot)', () => {
    expect(isSafeTenantApiUrl('https://myapp')).toBe(false)
  })
  it('rejects https://foo.local', () => {
    expect(isSafeTenantApiUrl('https://foo.local')).toBe(false)
  })
  it('rejects https://bar.local with subdomain', () => {
    expect(isSafeTenantApiUrl('https://svc.bar.local')).toBe(false)
  })

  // --- raw IP rejection (any IP, even public) ---
  it('rejects https://8.8.8.8 (raw public IP)', () => {
    expect(isSafeTenantApiUrl('https://8.8.8.8')).toBe(false)
  })
  it('rejects https://1.2.3.4 (raw public IP)', () => {
    expect(isSafeTenantApiUrl('https://1.2.3.4')).toBe(false)
  })

  // --- trailing-dot (FQDN form) bypasses ---
  it('rejects https://localhost. (trailing-dot FQDN form of loopback)', () => {
    expect(isSafeTenantApiUrl('https://localhost.')).toBe(false)
  })
  it('rejects https://foo.local. (trailing-dot .local)', () => {
    expect(isSafeTenantApiUrl('https://foo.local.')).toBe(false)
  })
  it('rejects https://127.0.0.1. (trailing-dot IPv4 literal)', () => {
    expect(isSafeTenantApiUrl('https://127.0.0.1.')).toBe(false)
  })

  // --- IP encoding / obfuscation (locked-in regression: these are rejected
  //     today because WHATWG URL normalizes them or they are flatly malformed.
  //     Assert we don't regress if a future refactor reads .host/.href instead
  //     of .hostname) ---
  it('rejects https://2130706433 (decimal-encoded 127.0.0.1)', () => {
    expect(isSafeTenantApiUrl('https://2130706433')).toBe(false)
  })
  it('rejects https://0x7f000001 (hex-encoded 127.0.0.1)', () => {
    expect(isSafeTenantApiUrl('https://0x7f000001')).toBe(false)
  })
  it('rejects https://127.1 (short-form 127.0.0.1)', () => {
    expect(isSafeTenantApiUrl('https://127.1')).toBe(false)
  })
  it('rejects https://ri.example.com@127.0.0.1 (userinfo trick — real host is 127.0.0.1)', () => {
    expect(isSafeTenantApiUrl('https://ri.example.com@127.0.0.1')).toBe(false)
  })
  it('rejects https://[::ffff:127.0.0.1] (IPv4-mapped IPv6)', () => {
    expect(isSafeTenantApiUrl('https://[::ffff:127.0.0.1]')).toBe(false)
  })
  it('rejects https:/\\127.0.0.1 (backslash path confusion)', () => {
    expect(isSafeTenantApiUrl('https:/\\127.0.0.1')).toBe(false)
  })
})
