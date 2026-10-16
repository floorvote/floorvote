import { describe, it, expect } from 'vitest'
import { emailChangedLabel, ownEmailChangeLabel, memberEmailChangeLabel } from './emailChangedLabel'

const step = (event: string, actorId: string | null, actorName: string | null = null) =>
  ({ event, email: 'jane@newjob.org', reason: 'jane@oldjob.org', actorId, actorName })

describe('ownEmailChangeLabel (the member reading their own history)', () => {
  it('says "you" for their own request and confirmation', () => {
    expect(ownEmailChangeLabel(step('email_change_requested', 'me'), 'me')).toBe('You asked to change your email to jane@newjob.org')
    expect(ownEmailChangeLabel(step('email_change_confirmed', 'me'), 'me')).toBe('You changed your email from jane@oldjob.org to jane@newjob.org')
  })

  it('names someone else who asked', () => {
    expect(ownEmailChangeLabel(step('email_change_requested', 'a1', 'Ada Admin'), 'me')).toBe('Ada Admin asked to change your email to jane@newjob.org')
    expect(ownEmailChangeLabel(step('email_change_confirmed', 'a1', 'Ada Admin'), 'me'))
      .toBe('Your email was changed from jane@oldjob.org to jane@newjob.org at the request of Ada Admin')
  })

  it('reads a cancel the same whoever caused it', () => {
    expect(ownEmailChangeLabel(step('email_change_cancelled', null), 'me')).toBe('Email change to jane@newjob.org cancelled')
  })

  it('reports "This wasn\'t me" neutrally, since the one who pressed it was not signed in', () => {
    expect(ownEmailChangeLabel(step('email_change_reported', null), 'me'))
      .toBe('"This wasn\'t me" was pressed for the change of your email from jane@oldjob.org to jane@newjob.org, and every session was signed out')
  })

  it('is null for any other event', () => {
    expect(ownEmailChangeLabel(step('verify_success', null), 'me')).toBeNull()
  })
})

describe('memberEmailChangeLabel (an admin reading a member history)', () => {
  it('says the member asked when they changed their own', () => {
    expect(memberEmailChangeLabel(step('email_change_requested', 'm1', 'Jane Doe'), 'm1')).toBe('Email change to jane@newjob.org requested by the member')
    expect(memberEmailChangeLabel(step('email_change_confirmed', 'm1', 'Jane Doe'), 'm1'))
      .toBe('Email changed from jane@oldjob.org to jane@newjob.org, requested by the member')
  })

  it('names the admin who asked', () => {
    expect(memberEmailChangeLabel(step('email_change_requested', 'a1', 'Ada Admin'), 'm1')).toBe('Email change to jane@newjob.org requested by Ada Admin')
  })

  it('reports "This wasn\'t me" with both addresses', () => {
    expect(memberEmailChangeLabel(step('email_change_reported', null), 'm1'))
      .toBe('"This wasn\'t me" was pressed for the change from jane@oldjob.org to jane@newjob.org, and all of the member\'s sessions were signed out')
  })

  it('reads a cancel plainly, and is null for any other event', () => {
    expect(memberEmailChangeLabel(step('email_change_cancelled', null), 'm1')).toBe('Email change to jane@newjob.org cancelled')
    expect(memberEmailChangeLabel(step('logout', null), 'm1')).toBeNull()
  })
})

describe('emailChangedLabel', () => {
  it('names the old address, the new address, and the admin', () => {
    expect(emailChangedLabel({ reason: 'jane@exmaple.com', email: 'jane@example.com', actorName: 'Ada Admin' }))
      .toBe('Email changed from jane@exmaple.com to jane@example.com by Ada Admin')
  })

  it('leaves out the admin once they are gone', () => {
    expect(emailChangedLabel({ reason: 'jane@exmaple.com', email: 'jane@example.com', actorName: null }))
      .toBe('Email changed from jane@exmaple.com to jane@example.com')
  })

  it('leaves out the admin when the field is missing or blank', () => {
    expect(emailChangedLabel({ reason: 'a@exmaple.com', email: 'a@example.com' })).toBe('Email changed from a@exmaple.com to a@example.com')
    expect(emailChangedLabel({ reason: 'a@exmaple.com', email: 'a@example.com', actorName: '' })).toBe('Email changed from a@exmaple.com to a@example.com')
  })
})
