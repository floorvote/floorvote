import { describe, it, expect } from 'vitest'
import { emailChangedLabel } from './emailChangedLabel'

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
