import { describe, it, expect } from 'vitest'
import { renderWeekAheadEmail, type WeekAheadDay } from './weekAheadEmail'

const SAMPLE_DAYS: WeekAheadDay[] = [
  {
    date: '2026-06-15',
    label: 'Monday, June 15',
    events: [
      {
        id: 'ev1',
        source: 'hearing',
        description: 'House Committee on Elections',
        location: 'Room 101',
        time: '09:00',
        status: 'confirmed',
        details: 'Public testimony at 9am.',
        url: 'https://www.rilegislature.gov/hearings',
        bills: [{ id: 'b1', billNumber: 'HB 1234', state: 'RI', priority: 'high', billTitle: 'Voter ID Act' }],
      },
      {
        id: 'ev2',
        source: 'custom',
        description: 'Staff training',
        location: null,
        time: null,
        status: 'confirmed',
        bills: [],
      },
    ],
  },
]

function render(days = SAMPLE_DAYS) {
  return renderWeekAheadEmail({
    days,
    assocName: 'Test Association',
    appUrl: 'https://example.com',
    icsUrl: 'https://example.com/api/calendar/ics',
  })
}

describe('renderWeekAheadEmail', () => {
  it('includes the day label', () => {
    expect(render()).toContain('Monday, June 15')
  })

  it('shows the event-count signal sentence and the date range', () => {
    const html = render()  // SAMPLE_DAYS has 2 events
    expect(html).toContain('2 events in the week ahead')
    expect(html).toContain('June 15')
  })

  it('uses the singular signal for a single event', () => {
    const days: WeekAheadDay[] = [{
      date: '2026-06-15', label: 'Monday, June 15',
      events: [{ id: 'e1', source: 'custom', description: 'Meeting', location: null, time: null, status: 'confirmed', bills: [] }],
    }]
    const html = renderWeekAheadEmail({ days, assocName: 'A', appUrl: 'https://x.com', icsUrl: 'https://x.com/ics' })
    expect(html).toContain('1 event in the week ahead')
  })

  it('includes priority dot color for high-priority bill', () => {
    expect(render()).toContain('#850028')  // priorityHigh fill/dot
  })

  it('includes bill chip with state and bill number', () => {
    expect(render()).toContain('RI HB 1234')
  })

  it('includes ICS subscribe link', () => {
    const html = render()
    expect(html).toContain('Subscribe to your calendar')
    expect(html).toContain('https://example.com/api/calendar/ics')
  })

  it('includes unsubscribe link to /profile', () => {
    const html = render()
    expect(html).toContain('https://example.com/profile')
  })

  it('escapes HTML in event description', () => {
    const days: WeekAheadDay[] = [{
      date: '2026-06-15', label: 'Monday, June 15',
      events: [{
        id: 'e1', source: 'custom',
        description: '<script>alert(1)</script>',
        location: null, time: null, status: 'confirmed', bills: [],
      }],
    }]
    const html = renderWeekAheadEmail({ days, assocName: 'A', appUrl: 'https://x.com', icsUrl: 'https://x.com/ics' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders no priority dot color for bill with null priority', () => {
    const days: WeekAheadDay[] = [{
      date: '2026-06-15', label: 'Monday, June 15',
      events: [{
        id: 'e1', source: 'custom', description: 'Meeting', location: null,
        time: null, status: 'confirmed',
        bills: [{ id: 'b1', billNumber: 'SB 5', state: 'RI', priority: null, billTitle: 'Test' }],
      }],
    }]
    const html = renderWeekAheadEmail({ days, assocName: 'A', appUrl: 'https://x.com', icsUrl: 'https://x.com/ics' })
    // None of the three priority dot colors should appear
    expect(html).not.toContain('#850028')
    expect(html).not.toContain('#be2342')
    expect(html).not.toContain('#c27a83')
  })

  it('includes assocName in email', () => {
    expect(render()).toContain('Test Association')
  })

  it('renders source-icon tiles (gavel for hearing, calendar for custom), not a colored left edge', () => {
    const html = render()  // SAMPLE_DAYS has a hearing (ev1) and a custom event (ev2)
    expect(html).toContain('/email-icons/gavel__')
    expect(html).toContain('/email-icons/calendar_today__')
    expect(html).not.toContain('border-left:3px')  // old source-colored edge is gone
  })

  it('links each event card to the agenda focusEvent deep-link', () => {
    const html = render()
    expect(html).toContain('/calendar?focusEvent=ev1')  // ev1 has no eventHash → DB id
    expect(html).toContain('/calendar?focusEvent=ev2')
  })

  it('adds native title tooltips to the source tile and priority square', () => {
    const html = render()
    expect(html).toContain('title="Hearing"')
    expect(html).toContain('title="Custom event"')
    expect(html).toContain('title="High priority"')
  })

  it('points the unsubscribe footer link at the week-ahead setting anchor', () => {
    expect(render()).toContain('/profile#setting-week-ahead')
  })

  it('shows the link with the scheme and www stripped', () => {
    const html = render()
    expect(html).toContain('rilegislature.gov/hearings')
    // Visible link label is stripped; the full URL only appears inside the href attribute
    expect(html).not.toContain('>https://www.rilegislature.gov/hearings<')
    expect(html).toContain('href="https://www.rilegislature.gov/hearings"')
  })

  it('shows the details block', () => {
    expect(render()).toContain('Public testimony at 9am.')
  })

  it('renders the meta-line icon PNGs', () => {
    const html = render()
    expect(html).toContain('email-icons/schedule__667386.png')
    expect(html).toContain('email-icons/location_on__667386.png')
    expect(html).toContain('email-icons/link_2__667386.png')
  })
})
