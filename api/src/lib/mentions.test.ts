import { describe, it, expect } from 'vitest'
import { renderMentionEmail, tiptapToEmailHtml, type MentionEmailInput } from './mentions'

const sample: MentionEmailInput = {
  appUrl: 'https://ri.example.com',
  author: { name: 'Sam Ortiz', subtitle: 'Policy Director' },
  bill: {
    id: 'legiscan:1001',
    billNumber: 'H 5001',
    title: 'An Act Relating to Elections',
    state: 'RI',
    session: '2026',
    priority: 'high',
    tenantSummary: 'Updates voter registration deadlines.',
  },
  comment: { id: 'cmt-1', createdAt: '2026-06-24 09:30:00', html: '<p>Take a look at this.</p>' },
  via: 'user',
  instanceName: 'Test Organization',
}

describe('renderMentionEmail', () => {
  it('renders the mention signal, instance name, and comment URL', () => {
    const html = renderMentionEmail(sample)
    expect(html).toContain('mentioned you in a comment')
    expect(html).toContain('Test Organization')
    expect(html).toContain('#comment-cmt-1')
  })

  it('does not emit hostile comment HTML unescaped into the email body (H5)', () => {
    const hostile: MentionEmailInput = {
      ...sample,
      comment: {
        ...sample.comment,
        html: '<p>hi</p><img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>',
      },
    }
    const out = renderMentionEmail(hostile)
    expect(out).not.toMatch(/<img[^>]*onerror/i)
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toMatch(/\son\w+=/i)
    expect(out).not.toMatch(/href="javascript:/i)
  })
})

describe('tiptapToEmailHtml (defensive escaping, H5)', () => {
  it('escapes an <img onerror> rather than passing it through', () => {
    const out = tiptapToEmailHtml('<p>ok</p><img src=x onerror="alert(1)">')
    expect(out).not.toMatch(/<img/i)
    expect(out).not.toMatch(/onerror/i)
    // the styled, known-safe <p> still renders
    expect(out).toContain('<p style=')
  })

  it('escapes <script> tags', () => {
    const out = tiptapToEmailHtml('<script>alert(1)</script>')
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toContain('alert(1)')
  })

  it('strips on* handler attributes from otherwise-known tags', () => {
    const out = tiptapToEmailHtml('<p onclick="steal()">hi</p>')
    expect(out).not.toMatch(/onclick/i)
    expect(out).toContain('hi')
  })

  it('still styles legitimate tiptap tags', () => {
    const out = tiptapToEmailHtml('<p><strong>b</strong> <em>i</em></p><ul><li>x</li></ul>')
    expect(out).toContain('<p style=')
    expect(out).toContain('<strong style=')
    expect(out).toContain('<em style=')
    expect(out).toContain('<ul style=')
    expect(out).toContain('<li style=')
  })

  it('preserves styled mention spans', () => {
    const out = tiptapToEmailHtml('<span data-type="mention" data-id="user:abc" data-label="Jane">@Jane</span>')
    expect(out).toContain('@Jane')
    expect(out).toContain('background:')
  })
})
