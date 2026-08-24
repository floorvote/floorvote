import { describe, it, expect } from 'vitest'
import { DEMO_WRITE_ALLOWLIST } from '../../src/middleware/auth'

/**
 * On a demo tenant every anonymous visitor shares one auto-logged-in `demo-user`
 * that holds role 'admin'. The only thing standing between that and the whole
 * admin surface is DEMO_WRITE_ALLOWLIST: `demoReadOnly` denies every non-GET
 * `/api/*` request that isn't listed, with 403 "This action is locked in the demo".
 *
 * For most routes that is fine — the worst case is rows the six-hourly reset
 * clears. For routes that SEND EMAIL it is not: demo tenants carry a live
 * send_email binding and the same EMAIL_FROM as production tenants
 * (`notifications@floorvote.org`), so allowlisting one would let an anonymous
 * visitor mail arbitrary addresses from the operator's real sender — costing
 * sender reputation and deliverability for every other tenant on that domain.
 *
 * That invariant was implicit: nothing recorded it, and nothing would have failed
 * if a future change allowlisted an email route. This test records it. If you are
 * here because it failed, the answer is almost certainly NOT to edit this list —
 * it is that the route you allowlisted sends mail and must not be reachable
 * anonymously.
 *
 * `sendMagicLink` separately refuses to send INVITE links on a demo, so an
 * accidental invite-route allowlisting is caught at runtime too. Login links are
 * deliberately still sent: superadmin access to a demo is `/login?manual=1`.
 */
const EMAIL_SENDING_ROUTES = [
  'POST /api/admin/members/bulk-invite',
  'POST /api/admin/members/:id/resend-invite',
  'POST /api/admin/members/:id/resend-login',
  'POST /api/auth/request-link',
  'POST /api/auth/resend-login',
  'POST /api/feedback',
]

describe('DEMO_WRITE_ALLOWLIST', () => {
  it('contains no email-sending route', () => {
    const listed = EMAIL_SENDING_ROUTES.filter(r => DEMO_WRITE_ALLOWLIST.has(r))
    expect(listed).toEqual([])
  })

  it('still allows the writes the demo is meant to demonstrate', () => {
    // Guards against the opposite failure: someone "fixing" the above by
    // emptying the list, which would silently turn the demo read-only.
    expect(DEMO_WRITE_ALLOWLIST.has('POST /api/bills/:id/comments')).toBe(true)
    expect(DEMO_WRITE_ALLOWLIST.has('PATCH /api/bills/:id/priority')).toBe(true)
    expect(DEMO_WRITE_ALLOWLIST.has('POST /api/auth/demo-login')).toBe(true)
  })
})
