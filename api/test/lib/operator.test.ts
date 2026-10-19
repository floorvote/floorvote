import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseEmailList, validEmailList } from '../../../shared/operator'

describe('parseEmailList', () => {
  it('returns [] for undefined or empty', () => {
    expect(parseEmailList(undefined)).toEqual([])
    expect(parseEmailList('')).toEqual([])
    expect(parseEmailList('  ')).toEqual([])
  })
  it('splits, trims, and drops empties', () => {
    expect(parseEmailList('a@x.org')).toEqual(['a@x.org'])
    expect(parseEmailList(' a@x.org , b@y.org ')).toEqual(['a@x.org', 'b@y.org'])
    expect(parseEmailList('a@x.org,,b@y.org,')).toEqual(['a@x.org', 'b@y.org'])
  })
})

// The one list every alert and operator-mail caller sends to (#781): the valid
// entries of an env var, so one typo can't block the good addresses. Each
// caller's own tests check that it uses this.
describe('validEmailList', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => vi.restoreAllMocks())
  const logged = () => errorSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n')

  it('returns [] for undefined, empty, or blank, and logs nothing: an unset var is not a typo', () => {
    expect(validEmailList(undefined, 'ALERT_EMAILS')).toEqual([])
    expect(validEmailList('', 'ALERT_EMAILS')).toEqual([])
    expect(validEmailList('  ', 'ALERT_EMAILS')).toEqual([])
    expect(validEmailList(' , ,, ', 'ALERT_EMAILS')).toEqual([])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('returns every address, in order and unchanged, and logs nothing, when all are valid', () => {
    expect(validEmailList('a@x.org,b@y.org', 'ALERT_EMAILS')).toEqual(['a@x.org', 'b@y.org'])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('drops an invalid entry, keeps the valid ones, and logs the dropped entry and which variable it came from', () => {
    expect(validEmailList('ops@example.com, not-an-address, ops2@example.com', 'ALERT_EMAILS')).toEqual(['ops@example.com', 'ops2@example.com'])
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(logged()).toContain('ALERT_EMAILS')
    expect(logged()).toContain('not-an-address')
    expect(logged()).not.toContain('ops@example.com')
  })

  it('logs every dropped entry in one line, naming the variable it was given', () => {
    expect(validEmailList('bad one, ops@example.com, bad@two', 'OPERATOR_CONTACT_EMAILS')).toEqual(['ops@example.com'])
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(logged()).toContain('OPERATOR_CONTACT_EMAILS')
    expect(logged()).toContain('bad one')
    expect(logged()).toContain('bad@two')
  })

  it('returns [] and still logs the entries when none are valid', () => {
    expect(validEmailList('nope, also nope@', 'ALERT_EMAILS')).toEqual([])
    expect(logged()).toContain('nope@')
  })

  it('trims whitespace around entries and drops blank ones without logging them', () => {
    expect(validEmailList('  a@x.org ,, \t, b@y.org  ,', 'ALERT_EMAILS')).toEqual(['a@x.org', 'b@y.org'])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('sends to an address once when it is listed twice, ignoring case, and keeps the first spelling', () => {
    expect(validEmailList('Ops@Example.com, a@x.org, ops@example.com, A@X.ORG', 'ALERT_EMAILS')).toEqual(['Ops@Example.com', 'a@x.org'])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs an invalid entry once when it is listed twice', () => {
    validEmailList('typo, a@x.org, typo', 'ALERT_EMAILS')
    expect(logged().match(/typo/g)).toHaveLength(1)
  })

  it('keeps the case an address was written in: the local part may be case-sensitive', () => {
    expect(validEmailList('Ops.Team@Example.COM', 'ALERT_EMAILS')).toEqual(['Ops.Team@Example.COM'])
  })

  it('drops the display-name form: the sender takes bare addresses only, so `Name <addr>` would fail the whole send', () => {
    expect(validEmailList('Ops <ops@example.com>, a@x.org', 'ALERT_EMAILS')).toEqual(['a@x.org'])
    expect(logged()).toContain('Ops <ops@example.com>')
  })

  it('drops both halves of a quoted display name that holds a comma', () => {
    expect(validEmailList('"Doe, Jane" <jane@example.com>, a@x.org', 'ALERT_EMAILS')).toEqual(['a@x.org'])
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('drops an address stuck to stray punctuation, as a pasted list leaves it', () => {
    expect(validEmailList('a@x.org;, b@y.org., c@z.org', 'ALERT_EMAILS')).toEqual(['c@z.org'])
  })

  it('drops a semicolon-separated pair, which is one entry to a comma split', () => {
    expect(validEmailList('a@x.org;b@y.org, c@z.org', 'ALERT_EMAILS')).toEqual(['c@z.org'])
  })
})
