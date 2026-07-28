// Shared security response headers for both apps (tenant + central).
//
// DELIVERY IS TWO-LAYER, because the SPA HTML is served directly by Workers
// Assets, which BYPASSES the Worker (no `run_worker_first`):
//   - Static assets, incl. the HTML document → each app's `web/public/_headers`
//     file carries the CSP + X-Frame-Options + nosniff. That is where the CSP
//     actually lands on the page. A test (web/src/securityHeaders.drift.test.ts)
//     asserts those files stay in sync with CONTENT_SECURITY_POLICY below.
//   - Worker-served responses (`/api/*`) → `setSecurityHeaders()` below, wired
//     as Hono middleware in each Worker entrypoint.
//
// SCOPE: the headers that belong in the application layer and are portable
// across any host —
//   - Content-Security-Policy      (app-specific allowlist; see below)
//   - X-Frame-Options              (clickjacking: this app is never framed)
//   - X-Content-Type-Options       (MIME-sniffing)
//
// Strict-Transport-Security is intentionally NOT set here. HSTS belongs at the
// TLS-terminating layer (e.g. the Cloudflare edge: SSL/TLS -> Edge Certificates
// -> HSTS), where it can be applied to the apex/subdomains consistently and
// preloaded. Setting it in-app as well risks a duplicate/conflicting header.
//
// ROLLOUT: the CSP shipped in REPORT-ONLY mode first (browser reports what it
// *would* block but blocks nothing); this change flips it to ENFORCING. The flip
// is gated on a real-browser DevTools sweep of the authenticated surfaces
// (login/Turnstile, feed AI-HTML, bill detail, admin) confirming no unexpected
// blocked origins. To revert, change `Content-Security-Policy` back to
// `Content-Security-Policy-Report-Only` here AND in both `_headers` files (the
// drift test pins the header name, so all three move together).
//
// Two blockers were resolved before enforcing (both surfaced under Report-Only):
//   - web/index.html's one INLINE <script> (the stale-deploy asset-reload guard)
//     was externalized to web/public/reload-guard.js and loaded as a classic
//     `<script src>`, so `script-src 'self'` covers it with no hash to maintain.
//   - The Cloudflare Web Analytics RUM beacon is an external script from
//     static.cloudflareinsights.com (edge-injected), added to `script-src`; its
//     data POST is same-origin (/cdn-cgi/rum), already covered by connect-src.

// CSP directives. `style-src 'unsafe-inline'` is required because the app styles
// via inline `style={{}}` attributes and an inline <style> block; inline STYLE
// injection is far lower risk than script injection, which stays locked down
// (no 'unsafe-inline' in script-src).
const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  // app bundle + reload-guard.js ('self') + Turnstile + Cloudflare Web Analytics
  // (RUM beacon, injected at the edge). No 'unsafe-inline': the one classic
  // inline script (the asset-reload guard) is externalized to /reload-guard.js.
  'script-src': ["'self'", 'https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // inline styles + Google Fonts CSS
  // 'self' + data: URIs, plus any https: image. AI summaries are stored raw and
  // may reference external images (AGENTS.md rule 17); allowing https: images
  // avoids enforcing breaking a summary. script-src stays strict, so inline
  // scripts inside AI content are still blocked — the XSS protection that matters.
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'connect-src': ["'self'"], // SPA talks only to its own /api (RUM POSTs same-origin /cdn-cgi/rum)
  'frame-src': ['https://challenges.cloudflare.com'], // Turnstile widget iframe
  'frame-ancestors': ["'none'"], // CSP-native clickjacking guard (pairs with X-Frame-Options)
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'object-src': ["'none'"],
}

/** Serialized CSP string, e.g. "default-src 'self'; script-src 'self' ...". */
export const CONTENT_SECURITY_POLICY: string = Object.entries(CSP_DIRECTIVES)
  .map(([directive, values]) => `${directive} ${values.join(' ')}`)
  .join('; ')

/**
 * Set the application-layer security headers on a response `Headers` object.
 * Call BEFORE `await next()` in a Hono middleware so the values merge onto the
 * final response (including immutable Workers-Assets responses, which cannot be
 * mutated after the fact).
 */
export function setSecurityHeaders(headers: Headers): void {
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-Content-Type-Options', 'nosniff')
  // Enforcing — see ROLLOUT note above (shipped Report-Only first, then flipped).
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
}
