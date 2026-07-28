import { describe, it, expect } from 'vitest'
import { renderMentionEmail, tiptapToEmailHtml, type MentionEmailInput } from '../../src/lib/mentions'
import { MENTION_STYLE } from '../../../shared/mentionStyle'

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

  // Drift guard: the email mention pills must use the shared MENTION_STYLE, so
  // they can't diverge from the app (the old bug — email hardcoded its own hexes).
  describe('mention pills match the app (shared MENTION_STYLE)', () => {
    const roleHtml = tiptapToEmailHtml('<p><span data-type="mention" data-id="role:r1" data-label="@Team">@Team</span></p>')
    const everyoneHtml = tiptapToEmailHtml('<p><span data-type="mention" data-id="everyone:all" data-label="@everyone">@everyone</span></p>')
    const userHtml = tiptapToEmailHtml('<p><span data-type="mention" data-id="user:u1" data-label="@Sam">@Sam</span></p>')
    it('role / @everyone mentions render in the shared indigo', () => {
      for (const html of [roleHtml, everyoneHtml]) {
        expect(html).toContain(`background:${MENTION_STYLE.role.bg}`)
        expect(html).toContain(`color:${MENTION_STYLE.role.text}`)
      }
    })
    it('a specific-user mention renders in the shared gray', () => {
      expect(userHtml).toContain(`background:${MENTION_STYLE.user.bg}`)
      expect(userHtml).toContain(`color:${MENTION_STYLE.user.text}`)
    })
    it('the role footer pill uses the shared indigo', () => {
      const html = renderMentionEmail({ ...base, via: 'role', roleName: 'Hearing Team' })
      expect(html).toContain(`background:${MENTION_STYLE.role.bg}`)
      expect(html).toContain(`color:${MENTION_STYLE.role.text}`)
    })
  })
  it('truncates an overlong subtitle', () => {
    const long = 'x'.repeat(120)
    const html = renderMentionEmail({ ...base, author: { name: 'Sam', subtitle: long } })
    expect(html).toContain('…')
    expect(html).not.toContain(long)
  })
})
