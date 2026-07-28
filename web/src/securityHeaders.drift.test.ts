import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CONTENT_SECURITY_POLICY } from '../../shared/securityHeaders'

// The SPA HTML shell is served directly by Workers Assets, which BYPASSES the
// Worker — so the security headers are delivered via each app's static
// `_headers` file, not the Worker middleware. Those files are hand-maintained
// text and can silently drift from the shared policy constant. This test keeps
// them honest: if it fails, sync the `_headers` file(s) with
// CONTENT_SECURITY_POLICY in shared/securityHeaders.ts.

const here = dirname(fileURLToPath(import.meta.url))
const HEADERS_FILES: Record<string, string> = {
  tenant: resolve(here, '../public/_headers'),
  central: resolve(here, '../../central/web/public/_headers'),
}

describe('static _headers CSP stays in sync with shared/securityHeaders.ts', () => {
  for (const [name, path] of Object.entries(HEADERS_FILES)) {
    describe(name, () => {
      const text = readFileSync(path, 'utf8')

      it('delivers the exact enforcing CSP', () => {
        expect(text).toContain(`Content-Security-Policy: ${CONTENT_SECURITY_POLICY}`)
      })

      it('no longer ships a report-only CSP', () => {
        expect(text).not.toContain('Content-Security-Policy-Report-Only')
      })

      it('denies framing and MIME-sniffing', () => {
        expect(text).toContain('X-Frame-Options: DENY')
        expect(text).toContain('X-Content-Type-Options: nosniff')
      })
    })
  }
})
