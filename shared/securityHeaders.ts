// Shared security response headers for both Workers (tenant API + SPA, central
// dashboard + SPA). Applied as a Hono middleware in each Worker's entrypoint.
//
// SCOPE: this sets the headers that belong in the application layer and are
// portable across any host —
//   - Content-Security-Policy      (app-specific allowlist; see below)
//   - X-Frame-Options              (clickjacking: this app is never framed)
//   - X-Content-Type-Options       (MIME-sniffing)
//
// Strict-Transport-Security is intentionally NOT set here. HSTS belongs at the
// TLS-terminating layer (e.g. the Cloudflare edge: SSL/TLS -> Edge Certificates
// -> HSTS), where it can be applied to the apex/subdomains consistently and
// preloaded. Setting it in-app as well risks a duplicate/conflicting header.
//
// ROLLOUT: the CSP ships in REPORT-ONLY mode first. In that mode the browser
// reports what it *would* block but blocks nothing, so it is safe to deploy to
// real users. Deploy to staging, read the violation reports, then a follow-up
// flips `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
//
// KNOWN follow-ups before enforcing (surfaced by Report-Only, noted here so the
// enforce PR is mechanical):
//   - web/index.html has one INLINE <script> (the stale-deploy asset-reload
//     guard). Enforcing `script-src 'self' ...` will block it unless we add its
//     'sha256-...' hash (the browser's Report-Only violation prints the exact
//     hash) or move it to an external file under /.
//   - img-src is 'self' data: for now. If the app later renders images from an
//     external host (e.g. legislator headshots), add that origin here.

// CSP directives. `style-src 'unsafe-inline'` is required because the app styles
// via inline `style={{}}` attributes and an inline <style> block; inline STYLE
// injection is far lower risk than script injection, which stays locked down
// (no 'unsafe-inline' in script-src).
const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'https://challenges.cloudflare.com'], // app bundle + Turnstile
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // inline styles + Google Fonts CSS
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'connect-src': ["'self'"], // SPA talks only to its own /api
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
  // Report-Only during rollout — see ROLLOUT note above.
  headers.set('Content-Security-Policy-Report-Only', CONTENT_SECURITY_POLICY)
}
