import { describe, it, expect } from 'vitest'
import { renderMentionEmail, type MentionEmailInput } from '../../src/lib/mentions'

const base: MentionEmailInput = {
  appUrl: 'https://x.test',
  instanceName: 'Rhode Island Association',
  author: { name: 'Sam Ortiz', subtitle: 'Town Clerk, Cranston' },
  bill: { id: 'b1', billNumber: 'HB 1234', title: 'Voter ID Act', state: 'RI', session: '2026 Regular Session', priority: 'high', tenantSummary: 'Requires photo identification to vote.' },
  comment: { id: 'c9', createdAt: '2026-06-10 16:45:00', html: '<p>Hey <span data-type="mention" data-id="user:u2" data-label="@Dana">@Dana</span> — testify?</p>' },
  via: 'user',
}

describe('renderMentionEmail', () => {
  it('renders the shared card chrome (navy badge, priority chip, serif title, summary)', () => {
    const html = renderMentionEmail(base)
    expect(html).toContain('RI HB 1234')
    expect(html).toContain('High priority')
    expect(html).toContain('Voter ID Act')
    expect(html).toContain('Requires photo identification to vote.')
    expect(html).toContain('Source Serif')
  })
  it('renders the comment row: purple icon, author name + subtitle, absolute date', () => {
    const html = renderMentionEmail(base)
    expect(html).toContain('/email-icons/chat__7c3aed.png')
    expect(html).toContain('Sam Ortiz')
    expect(html).toContain('Town Clerk, Cranston')
    expect(html).toContain('June 10, 2026')
  })
  it('renders the comment body via tiptapToEmailHtml (mention chip kept)', () => {
    const html = renderMentionEmail(base)
    expect(html).toContain('@Dana')
    expect(html).toContain('testify?')
  })
  it('links the card to the canonical bill URL and the CTA to the comment anchor', () => {
    const html = renderMentionEmail(base)
    expect(html).toContain('https://x.test/RI/2026/HB 1234')
    expect(html).toContain('https://x.test/RI/2026/HB 1234#comment-c9')
  })
  it('varies the intro line by via', () => {
    expect(renderMentionEmail(base)).toContain('mentioned you in a comment')
    const role = renderMentionEmail({ ...base, via: 'role', roleName: 'Hearing Team' })
    expect(role).toContain('mentioned <strong')
    expect(role).toContain('@Hearing Team')
    expect(renderMentionEmail({ ...base, via: 'everyone' })).toContain('notified everyone')
  })
  it('wraps in the gray shell (full document)', () => {
    expect(renderMentionEmail(base)).toContain('<!DOCTYPE html>')
  })
  it('truncates an overlong subtitle', () => {
    const long = 'x'.repeat(120)
    const html = renderMentionEmail({ ...base, author: { name: 'Sam', subtitle: long } })
    expect(html).toContain('…')
    expect(html).not.toContain(long)
  })
})
