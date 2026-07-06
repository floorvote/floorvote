import { describe, it, expect } from 'vitest'
import { parseInvitees } from './parseInvitees'

describe('parseInvitees', () => {
  it('parses a bare email with no name', () => {
    expect(parseInvitees('jane@example.com')).toEqual([
      { email: 'jane@example.com', name: undefined, raw: 'jane@example.com' },
    ])
  })

  it('parses "Name <email>"', () => {
    expect(parseInvitees('Jane Doe <jane@example.com>')).toEqual([
      { email: 'jane@example.com', name: 'Jane Doe', raw: 'Jane Doe <jane@example.com>' },
    ])
  })

  it('parses "Name, email" and "email, Name" identically (order-agnostic)', () => {
    const a = parseInvitees('Jane Doe, jane@example.com')[0]
    const b = parseInvitees('jane@example.com, Jane Doe')[0]
    expect(a.email).toBe('jane@example.com')
    expect(a.name).toBe('Jane Doe')
    expect(b.email).toBe('jane@example.com')
    expect(b.name).toBe('Jane Doe')
  })

  it('parses tab-separated spreadsheet paste in either column order', () => {
    expect(parseInvitees('Jane Doe\tjane@example.com')[0]).toMatchObject({ name: 'Jane Doe', email: 'jane@example.com' })
    expect(parseInvitees('jane@example.com\tJane Doe')[0]).toMatchObject({ name: 'Jane Doe', email: 'jane@example.com' })
  })

  it('splits multiple lines and ignores blank lines and surrounding whitespace', () => {
    const out = parseInvitees('  jane@example.com  \n\n bob@example.com \n')
    expect(out.map(o => o.email)).toEqual(['jane@example.com', 'bob@example.com'])
  })

  it('returns rows with empty email for lines that contain no email token', () => {
    const out = parseInvitees('Just A Name')
    expect(out).toEqual([{ email: '', name: 'Just A Name', raw: 'Just A Name' }])
  })

  it('lowercases and trims the email but preserves the name case', () => {
    expect(parseInvitees('Jane Doe, JANE@Example.COM')[0]).toMatchObject({
      name: 'Jane Doe',
      email: 'jane@example.com',
    })
  })

  it('uses the first email-looking token as the email and the rest as the name', () => {
    expect(parseInvitees('Dr. Jane Q. Doe <jane@example.com>')[0]).toMatchObject({
      name: 'Dr. Jane Q. Doe',
      email: 'jane@example.com',
    })
  })

  it('emits one invitee per email when a line holds multiple emails (pasted comma list)', () => {
    const out = parseInvitees('jane@a.com, bob@b.com')
    expect(out).toEqual([
      { email: 'jane@a.com', name: undefined, raw: 'jane@a.com, bob@b.com' },
      { email: 'bob@b.com', name: undefined, raw: 'jane@a.com, bob@b.com' },
    ])
  })

  it('strips quotes and the embedded comma from a quoted "Last, First" name', () => {
    expect(parseInvitees('"Doe, Jane" <j@x.com>')[0]).toEqual({
      email: 'j@x.com',
      name: 'Doe Jane',
      raw: '"Doe, Jane" <j@x.com>',
    })
  })
})
