import { describe, it, expect } from 'vitest'
import { hearingBody, customBody, customUrl } from './calendarIcsBody'

const billHref = 'https://ri.example.com/RI/2026/S3316'
const calendarHref = 'https://ri.example.com/calendar'

describe('hearingBody', () => {
  it('includes title, priority, and tracker link to billHref', () => {
    const b = hearingBody({ billNumber: 'HB 123', billTitle: 'Absentee deadlines', priority: 'high', billHref, assoc: 'RI' })
    expect(b).toContain('HB 123: Absentee deadlines')
    expect(b).toContain('Priority: high')
    expect(b).toContain(billHref)
  })

  it('omits the colon when the bill has no title', () => {
    const b = hearingBody({ billNumber: 'HB 55', billTitle: null, priority: null, billHref, assoc: 'RI' })
    expect(b).toContain('HB 55')
    expect(b).not.toContain('HB 55:')
  })
})

describe('customBody + customUrl', () => {
  const ev = { details: 'Through May 29\nStatute: W.S. 22-5-209', url: 'https://sos.example.gov', billNumbers: ['HB 123'], billHref, calendarHref, assoc: 'RI' }
  it('body has details, related bills, more-info, and tracker link', () => {
    const b = customBody(ev)
    expect(b).toContain('Statute: W.S. 22-5-209')
    expect(b).toContain('Related bills: HB 123')
    expect(b).toContain('More info: https://sos.example.gov')
    expect(b).toContain(billHref)
  })
  it('url precedence A: user url wins, then billHref, then calendarHref', () => {
    expect(customUrl({ url: 'https://sos.example.gov', billHref, calendarHref })).toBe('https://sos.example.gov')
    expect(customUrl({ url: null, billHref, calendarHref })).toBe(billHref)
    expect(customUrl({ url: null, billHref: null, calendarHref })).toBe(calendarHref)
  })
})
