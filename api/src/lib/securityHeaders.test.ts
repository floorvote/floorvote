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

  it('ships the CSP in enforcing mode', () => {
    const h = applied()
    expect(h.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY)
    // Report-only was the rollout mode; enforcing must not also emit it.
    expect(h.get('Content-Security-Policy-Report-Only')).toBeNull()
  })

  it('does not set HSTS (owned by the TLS-terminating edge, not the app)', () => {
    expect(applied().get('Strict-Transport-Security')).toBeNull()
  })
})

// --- CSP resource-dependency contract ---------------------------------------
// The tests above check the CSP is *well-formed*. This block checks it is
// *sufficient*: every resource the app actually loads at runtime is pinned to
// the directive that must permit it, with a pointer to the code that needs it.
// This is the guard the PDF-viewer regression should have tripped — tightening
// a directive (or the Report-Only → enforce flip) that would break one of these
// fails here BY NAME, instead of silently in a browser after deploy.
//
// COVERAGE LIMIT: this is a *declared* contract, not a live browser check — it
// cannot see a brand-new resource type nobody added here. When you add a
// feature that loads a resource (an <iframe>, a Worker, <video>/<audio>, an
// external fetch, or a web font), add its row below AND, if needed, the
// directive it requires. Two directives are deliberately UNSET today, so they
// inherit `default-src 'self'`:
//   - media-src  — the app renders no <video>/<audio>. Cross-origin or blob:
//                  media would need media-src added here.
//   - worker-src — the app spawns no Web/Service Worker or PWA. Some libraries
//                  mint workers from blob: URLs; that would need worker-src blob:.
// (Audited 2026-08-03: no media/worker/external-fetch usage exists in the client.)

/** Source list for a directive, e.g. directive('frame-src') → ["https://…", "blob:"]. */
function directive(name: string): string[] {
  const entry = CONTENT_SECURITY_POLICY.split('; ').find((d) => d === name || d.startsWith(`${name} `))
  return entry ? entry.split(' ').slice(1) : []
}

// feature → the directive + source(s) it depends on → the code that needs it.
const RESOURCE_CONTRACT: { feature: string; directive: string; needs: string[]; code: string }[] = [
  { feature: 'Bill-text PDF viewer frames a same-origin URL.createObjectURL() blob', directive: 'frame-src', needs: ['blob:'], code: 'web/src/components/BillTextPanel.tsx' },
  { feature: 'Turnstile widget iframe', directive: 'frame-src', needs: ['https://challenges.cloudflare.com'], code: 'web/src/components/Turnstile.tsx' },
  { feature: 'App bundle + externalized reload-guard (classic <script src>)', directive: 'script-src', needs: ["'self'"], code: 'web/index.html, web/public/reload-guard.js' },
  { feature: 'Turnstile challenge script', directive: 'script-src', needs: ['https://challenges.cloudflare.com'], code: 'web/src/components/Turnstile.tsx' },
  { feature: 'Cloudflare Web Analytics RUM beacon (edge-injected)', directive: 'script-src', needs: ['https://static.cloudflareinsights.com'], code: 'shared/securityHeaders.ts (edge-injected)' },
  { feature: 'Inline style={{}} attributes + inline <style>', directive: 'style-src', needs: ["'unsafe-inline'"], code: 'web/src (pervasive inline styles)' },
  { feature: 'Google Fonts stylesheet', directive: 'style-src', needs: ['https://fonts.googleapis.com'], code: 'web/index.html, central/web/index.html' },
  { feature: 'Google Fonts font files', directive: 'font-src', needs: ['https://fonts.gstatic.com'], code: 'web/index.html, central/web/index.html' },
  { feature: 'App images/favicons, data: URIs, and external https images in sanitized content', directive: 'img-src', needs: ["'self'", 'data:', 'https:'], code: 'web/index.html, web/src/lib/sanitizeHtml.ts' },
]

describe('CSP resource-dependency contract', () => {
  for (const { feature, directive: name, needs, code } of RESOURCE_CONTRACT) {
    it(`${name} permits — ${feature} (${code})`, () => {
      const allowed = directive(name)
      for (const src of needs) expect(allowed).toContain(src)
    })
  }

  it("default-src is locked to 'self'", () => {
    expect(directive('default-src')).toEqual(["'self'"])
  })

  it('connect-src stays same-origin only — the client makes no external network calls', () => {
    // Audited: no fetch/XHR/WebSocket/EventSource/sendBeacon to a non-self
    // origin (the RUM beacon POSTs same-origin /cdn-cgi/rum). If a feature ever
    // calls an external API from the browser, add its origin here.
    expect(directive('connect-src')).toEqual(["'self'"])
  })

  it("script-src never allows inline scripts (the XSS invariant that must not regress)", () => {
    expect(directive('script-src')).not.toContain("'unsafe-inline'")
    expect(directive('script-src')).not.toContain("'unsafe-eval'")
  })

  it('locks down clickjacking and plugin/object embedding at the CSP layer', () => {
    expect(directive('frame-ancestors')).toEqual(["'none'"])
    expect(directive('object-src')).toEqual(["'none'"])
  })
})
