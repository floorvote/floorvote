import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Which emails fall back is the purposes' rule (shared/emailSender.ts), and the
// operator reads it in four places: the tenants guide, AGENTS.md, the
// new-instance prompt, and the email-health alert (whose wording is pinned in
// api/test/lib/emailHealthJob.test.ts). They must all say the same thing:
// sign-in, account, notification, and operator email falls back, and digests
// and week-ahead mail never do. This pins the three that are plain files, and
// the older claims they replaced.

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('what the docs say falls back', () => {
  const tenants = read('docs/content/self-hosting/tenants.md')
  const agents = read('AGENTS.md')
  const newInstance = read('scripts/new-instance.sh')
  const operating = read('docs/content/self-hosting/operating.md')

  it('the tenants guide names the four kinds that fall back, and the two that never do', () => {
    expect(tenants).toContain('Sign-in, account, notification, and operator email falls back.')
    expect(tenants).toContain('Digests and week-ahead mail never do')
  })

  it('the tenants guide says the outage alert goes through the healthy provider first', () => {
    expect(tenants).toContain('alerts `ALERT_EMAILS` through the healthy provider first, then the failing one')
  })

  it('AGENTS.md says the same on the RESEND_API_KEY line, and in the stack table', () => {
    const line = agents.split('\n').find(l => l.startsWith('| `RESEND_API_KEY`'))
    expect(line).toBeDefined()
    expect(line).toContain('sign-in, account, notification, and operator email')
    expect(line).toContain('Digests and week-ahead mail never fall back')
    const stack = agents.split('\n').find(l => l.startsWith('| Email |'))
    expect(stack).toContain('sign-in, account, notification, and operator email')
    expect(stack).toContain('Digests and week-ahead mail never fall back')
  })

  it('the new-instance prompt says the same', () => {
    expect(newInstance).toContain('sign-in, account, notification,')
    expect(newInstance).toContain('Digests and week-ahead mail never fall back')
  })

  it('none of them says a binding is the only thing that counts, or that login links are the only mail that falls back', () => {
    expect(tenants).not.toContain('login and invite links that the primary fails to send')
    expect(agents).not.toContain('(only when `EMAIL_PROVIDER=resend` or the Cloudflare `EMAIL` binding is absent)')
    expect(agents).not.toContain('Resend available as a fallback via `EMAIL_PROVIDER`')
    expect(newInstance).not.toContain('is only used if EMAIL_PROVIDER=resend')
  })

  it('every place that frames Cloudflare Email says a bound binding counts as a sender, and EMAIL_PROVIDER only picks the first tried', () => {
    expect(tenants).toContain('`EMAIL_PROVIDER` only picks which one is tried first')
    expect(operating).toContain('a bound EMAIL binding counts as a sender')
    expect(operating).toContain('EMAIL_PROVIDER only picks which one is tried first')
    expect(agents).toContain('`EMAIL_PROVIDER` only picks which is tried first')
  })
})
