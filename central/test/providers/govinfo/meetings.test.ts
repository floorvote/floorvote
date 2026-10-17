import { describe, it, expect } from 'vitest'
import {
  easternTime, entriesByBill, holdingCommittees, isCancelled, meetingBodyEvent, meetingEntry, meetingType, parseMeeting, parseMeetingList,
  type ListedMeeting, type Meeting,
} from '../../../src/providers/govinfo/meetings'
import { meetingInventory, meetingListInventory } from '../../../src/providers/govinfo/inventory'
import { vocabulary } from '../../../src/providers/govinfo/vocabulary'
import { inventoryProblems } from '../../helpers/fieldInventory'
import { recordedDetails, recordedListPage } from '../../helpers/govinfoMeetings'
import meetingPathsRaw from '../../fixtures/govinfo/meetings/field-paths.json?raw'

// The Congress.gov API's committee meetings (meetings.ts): one answer for the
// list, one for each meeting. Every recorded answer is real, recorded on
// October 17, 2026. These tests read them as the provider does and check what
// comes out, and that anything the API sends that the provider can't read fails
// closed, so a pass that meets it changes nothing.

const raw = (id: string) => JSON.stringify(recordedDetails.get(id))
const listed = (id: string): ListedMeeting => {
  const m = recordedDetails.get(id).committeeMeeting
  return { eventId: m.eventId, chamber: m.chamber.toLowerCase(), updateDate: m.updateDate }
}
/** A recorded meeting's answer with a change made to the meeting. */
function edited(id: string, change: (m: any) => void): string {
  const d = structuredClone(recordedDetails.get(id))
  change(d.committeeMeeting)
  return JSON.stringify(d)
}
const read = (id: string, text = raw(id)) => parseMeeting(text, listed(id), 119)

describe('a recorded meeting', () => {
  it('is read into its event id, chamber, type, status, title, committee, and location', () => {
    expect(read('119544')).toEqual({
      eventId: '119544',
      chamber: 'house',
      congress: 119,
      updateDate: '2026-10-07T13:33:31Z',
      date: '2026-09-15',
      time: '10:15',
      type: 'Hearing',
      status: 'Scheduled',
      title: '"Out of Touch: When Union Politics Leave Workers Behind"',
      location: '2175 Rayburn House Office Building',
      committees: [{ systemCode: 'hsed02', name: 'House Education and Workforce Subcommittee on Health, Employment, Labor, and Pensions' }],
      bills: [],
    })
  })

  it('keeps the date and time in Eastern, which the API gives in UTC', () => {
    // 2026-09-15T14:15:00Z is 10:15 in Washington.
    expect(raw('119544')).toContain('"date":"2026-09-15T14:15:00Z"')
    expect(read('119544')).toMatchObject({ date: '2026-09-15', time: '10:15' })
  })

  it('reads a markup, and a Senate hearing the API types as a meeting', () => {
    expect(read('119567')).toMatchObject({ chamber: 'house', type: 'Markup', date: '2026-09-15', time: '16:00' })
    expect(read('336604')).toMatchObject({ chamber: 'senate', type: 'Meeting', location: '226 Dirksen Senate Office Building' })
  })

  it('reads a joint committee\'s meeting, which the API files under no chamber', () => {
    const m = read('337125')
    expect(m).toMatchObject({ chamber: 'nochamber', committees: [{ systemCode: 'jcse00' }] })
  })

  it('collapses a title\'s line breaks and runs of spaces, as a markup\'s agenda has them', () => {
    const m = read('119567')
    expect(recordedDetails.get('119567').committeeMeeting.title).toContain('\r\n')
    expect(m.title).not.toMatch(/[\r\n\t]|\s{2}/)
    expect(m.title).toMatch(/^Full Committee business meeting to consider the following: 1\) H\.Res\. _____/)
  })

  it('reads a field hearing\'s place, which the API gives as an address in a JSON string', () => {
    expect(read('119583').location).toBe('Northampton Community College, Fowler Family Southside Center, 511 East Third Street, Bethlehem, PA 18015')
    expect(read('119575').location).toBe('Orgill Innovation Center, 4027 Bailey Station Rd, Collierville, TN 38017')
  })

  it('keeps an address that isn\'t JSON as the text it is', () => {
    const m = read('119583', edited('119583', x => { x.location = { address: '  100 Main  Street,\r\nTownsville ' } }))
    expect(m.location).toBe('100 Main Street, Townsville')
  })

  it('has no location when the API gives none, or an empty one', () => {
    expect(read('119583', edited('119583', x => { delete x.location })).location).toBeNull()
    expect(read('119583', edited('119583', x => { x.location = {} })).location).toBeNull()
    expect(read('119544', edited('119544', x => { x.location = { building: 'Rayburn House Office Building', room: '' } })).location).toBe('Rayburn House Office Building')
    expect(read('119544', edited('119544', x => { x.location = { room: '2175' } })).location).toBe('2175')
  })

  it('keeps a committee the API names no name for, so its meeting is held by it all the same', () => {
    expect(recordedDetails.get('119538').committeeMeeting.committees[0].name).toBeUndefined()
    expect(read('119538').committees).toEqual([{ systemCode: 'hlzs00', name: null }])
  })

  it('reads every committee a joint meeting names, in the order given', () => {
    const m = read('119544', edited('119544', x => {
      x.committees.push({ name: 'House Judiciary', systemCode: 'hsju00', url: 'https://api.congress.gov/v3/committee/house/hsju00?format=json' })
    }))
    expect(m.committees.map(c => c.systemCode)).toEqual(['hsed02', 'hsju00'])
  })

  it('has no committee when the API lists none', () => {
    expect(read('119544').committees).toHaveLength(1)
    expect(read('119544', edited('119544', x => { x.committees = [] })).committees).toEqual([])
    expect(read('119544', edited('119544', x => { delete x.committees })).committees).toEqual([])
  })

  it('reads the bills a meeting takes up, and leaves out the nominations a Senate meeting takes up', () => {
    expect(read('118298').bills).toEqual([
      { type: 'HR', number: '3857' }, { type: 'HR', number: '3538' }, { type: 'HR', number: '3858' }, { type: 'HR', number: '1676' },
    ])
    expect(recordedDetails.get('336604').committeeMeeting.relatedItems.nominations.length).toBeGreaterThan(0)
    expect(read('336604').bills).toEqual([])
  })

  it('names a bill once however often the API lists it', () => {
    const m = read('118298', edited('118298', x => { x.relatedItems.bills.push({ ...x.relatedItems.bills[0] }) }))
    expect(m.bills.filter(b => b.number === '3857')).toHaveLength(1)
    expect(m.bills).toHaveLength(4)
  })

  it('reads a bill of each type Congress has', () => {
    const types = ['HR', 'S', 'HRES', 'SRES', 'HJRES', 'SJRES', 'HCONRES', 'SCONRES']
    const m = read('118298', edited('118298', x => { x.relatedItems.bills = types.map((type, i) => ({ congress: 119, number: String(i + 1), type, url: 'https://api.congress.gov/v3/bill/119/x/1?format=json' })) }))
    expect(m.bills.map(b => b.type)).toEqual(types)
  })

  it('has no bills when the meeting names none', () => {
    expect(read('118298').bills).toHaveLength(4)
    expect(read('119544').bills).toEqual([])
    expect(read('118298', edited('118298', x => { x.relatedItems = {} })).bills).toEqual([])
    expect(read('118298', edited('118298', x => { x.relatedItems = { bills: [] } })).bills).toEqual([])
  })

  it('reads a title the API leaves out as an empty one', () => {
    expect(read('119544').title).not.toBe('')
    expect(read('119544', edited('119544', x => { delete x.title })).title).toBe('')
    expect(read('119544', edited('119544', x => { x.title = '   ' })).title).toBe('')
  })
})

describe('what is wrong with a meeting\'s answer', () => {
  const bad: [string, (id: string) => string, RegExp][] = [
    ['it isn\'t JSON', () => '<html>Service unavailable</html>', /JSON/],
    ['it is an empty body', () => '', /JSON/],
    ['it is a list', () => '[]', /committeeMeeting/],
    ['it has no meeting', () => '{"request":{}}', /committeeMeeting/],
    ['its meeting is null', () => '{"committeeMeeting":null}', /committeeMeeting/],
    ['its meeting is for another event', id => edited(id, m => { m.eventId = '999' }), /event/],
    ['its meeting has no event id', id => edited(id, m => { delete m.eventId }), /event/],
    ['its event id isn\'t a number', id => edited(id, m => { m.eventId = 'abc' }), /event/],
    ['its meeting is from another Congress', id => edited(id, m => { m.congress = 118 }), /Congress 118, not 119/],
    ['its meeting is in another chamber than the list gave', id => edited(id, m => { m.chamber = 'Senate' }), /chamber/],
    ['its chamber isn\'t one', id => edited(id, m => { m.chamber = 'Both' }), /chamber/],
    ['it has no date', id => edited(id, m => { delete m.date }), /date/],
    ['its date is empty', id => edited(id, m => { m.date = '' }), /date/],
    ['its date isn\'t a time', id => edited(id, m => { m.date = 'next Tuesday' }), /date/],
    ['its date is not a real day', id => edited(id, m => { m.date = '2026-02-31T14:00:00Z' }), /date/],
    ['its date has no zone', id => edited(id, m => { m.date = '2026-09-15T14:15:00' }), /date/],
    ['its date is a number', id => edited(id, m => { m.date = 1789000000 }), /date/],
    ['it has no status', id => edited(id, m => { delete m.meetingStatus }), /meetingStatus/],
    ['its status is empty', id => edited(id, m => { m.meetingStatus = '' }), /meetingStatus/],
    ['its status isn\'t text', id => edited(id, m => { m.meetingStatus = 3 }), /meetingStatus/],
    ['it has no type', id => edited(id, m => { delete m.type }), /type/],
    ['its type is empty', id => edited(id, m => { m.type = '' }), /type/],
    ['its title isn\'t text', id => edited(id, m => { m.title = ['a'] }), /title/],
    ['it has no update date', id => edited(id, m => { delete m.updateDate }), /updateDate/],
    ['its committees aren\'t a list', id => edited(id, m => { m.committees = 'hsed02' }), /committees/],
    ['a committee isn\'t an object', id => edited(id, m => { m.committees = ['hsed02'] }), /committee/],
    ['a committee has no system code', id => edited(id, m => { delete m.committees[0].systemCode }), /system code/],
    ['a committee\'s system code isn\'t one', id => edited(id, m => { m.committees[0].systemCode = 'House Armed Services' }), /system code/],
    ['a committee\'s name isn\'t text', id => edited(id, m => { m.committees[0].name = 5 }), /name/],
    ['its location isn\'t an object', id => edited(id, m => { m.location = '2175 Rayburn' }), /location/],
    ['its building isn\'t text', id => edited(id, m => { m.location = { building: 7, room: '1' } }), /location/],
    ['its address isn\'t text', id => edited(id, m => { m.location = { address: { street: 'x' } } }), /location/],
    ['its related items aren\'t an object', id => edited(id, m => { m.relatedItems = 'HR 1' }), /relatedItems/],
    ['its bills aren\'t a list', id => edited(id, m => { m.relatedItems = { bills: 'HR 1' } }), /bills/],
    ['a bill isn\'t an object', id => edited(id, m => { m.relatedItems = { bills: ['HR 1'] } }), /bill/],
    ['a bill has no number', id => edited(id, m => { m.relatedItems = { bills: [{ congress: 119, type: 'HR' }] } }), /bill/],
    ['a bill\'s number isn\'t a number', id => edited(id, m => { m.relatedItems = { bills: [{ congress: 119, type: 'HR', number: 'one' }] } }), /bill/],
    ['a bill is of a type that isn\'t one of Congress\'s eight', id => edited(id, m => { m.relatedItems = { bills: [{ congress: 119, type: 'HAMDT', number: '1' }] } }), /HAMDT/],
    ['a bill is from another Congress', id => edited(id, m => { m.relatedItems = { bills: [{ congress: 118, type: 'HR', number: '1' }] } }), /Congress 118, not 119/],
  ]
  it.each(bad)('is a failure when %s', (_what, make, message) => {
    // 118298 has bills, committees, and a location, so each change has something to break.
    expect(() => read('118298', make('118298'))).toThrow(message)
  })

  it('names the event in its error, so an operator can find it', () => {
    expect(() => read('118298', edited('118298', m => { delete m.date }))).toThrow(/118298/)
  })
})

describe('the Eastern time of a UTC time', () => {
  it.each([
    // [UTC, date, time]
    ['2026-09-15T14:15:00Z', '2026-09-15', '10:15'], // EDT, 4 hours behind
    ['2026-11-04T15:00:00Z', '2026-11-04', '10:00'], // EST, 5 hours behind
    ['2026-03-08T06:59:00Z', '2026-03-08', '01:59'], // the minute before clocks spring forward
    ['2026-03-08T07:00:00Z', '2026-03-08', '03:00'], // the minute they did
    ['2026-11-01T05:59:00Z', '2026-11-01', '01:59'], // the first 1:59, still EDT
    ['2026-11-01T06:30:00Z', '2026-11-01', '01:30'], // the second 1:30, EST
    ['2026-11-01T07:00:00Z', '2026-11-01', '02:00'], // two o'clock, EST
    ['2026-09-16T01:30:00Z', '2026-09-15', '21:30'], // the evening before in UTC's next day
    ['2026-12-31T23:30:00Z', '2026-12-31', '18:30'],
    ['2027-01-01T04:30:00Z', '2026-12-31', '23:30'], // a new year in UTC only
  ])('%s is %s %s', (utc, date, time) => {
    expect(easternTime(utc)).toEqual({ date, time })
  })

  it('has no time at midnight Eastern, which is how a feed with no time of day says so', () => {
    expect(easternTime('2026-09-15T04:00:00Z')).toEqual({ date: '2026-09-15', time: null }) // EDT
    expect(easternTime('2026-12-15T05:00:00Z')).toEqual({ date: '2026-12-15', time: null }) // EST
  })
})

describe('whether a status cancels a meeting', () => {
  it.each([
    ['Canceled', true], ['Cancelled', true], ['canceled', true], ['CANCELED', true], ['Postponed', true], ['postponed', true], [' Canceled ', true],
    ['Scheduled', false], ['Rescheduled', false], ['Held', false], ['Completed', false], ['', false], ['Not canceled', false],
  ])('%j: %s', (status, cancelled) => {
    // The check is a real one: it cancels on the word, so a no is an answer and not a stub.
    expect(isCancelled('Canceled')).toBe(true)
    expect(isCancelled(status)).toBe(cancelled)
  })
})

describe('the kind of a meeting, from its type, through the vocabulary', () => {
  it.each([
    // The types the API has for the 119th Congress's meetings, as recorded.
    ['Hearing', 'hearing'], ['Open Hearing', 'hearing'], ['Closed Hearing', 'hearing'],
    ['Markup', 'markup'], ['Closed Markup Session', 'markup'],
    ['Meeting', 'meeting'], ['Open Business Meeting', 'meeting'],
  ] as const)('%s is a %s', (type, kind) => {
    const { typeId, kind: k } = meetingType(type)
    expect(k).toBe(kind)
    expect(vocabulary.eventTypes[typeId]?.kind).toBe(kind)
  })

  it('names each kind\'s event type in the vocabulary for what it is', () => {
    expect(vocabulary.eventTypes[meetingType('Hearing').typeId]?.label).toBe('Hearing')
    expect(vocabulary.eventTypes[meetingType('Markup').typeId]?.label).toBe('Markup')
    expect(vocabulary.eventTypes[meetingType('Meeting').typeId]?.label).toBe('Meeting')
  })

  it('reads a type the API words differently by case and spacing', () => {
    expect(meetingType('hearing').kind).toBe('hearing')
    expect(meetingType(' MARKUP ').kind).toBe('markup')
    expect(meetingType('Mark-up').kind).toBe('markup')
    expect(meetingType('field   hearing').kind).toBe('hearing')
  })

  it('takes a markup session for a markup before a meeting, and a hearing for a hearing before a meeting', () => {
    expect(meetingType('Hearing and Business Meeting').kind).toBe('hearing')
    expect(meetingType('Business Meeting and Markup').kind).toBe('markup')
  })

  it('takes a type it doesn\'t know for a meeting', () => {
    for (const type of ['Roundtable', 'Briefing', 'Organizational', '']) {
      const { typeId, kind } = meetingType(type)
      expect(kind).toBe('meeting')
      expect(vocabulary.eventTypes[typeId]).toMatchObject({ kind: 'meeting', label: 'Meeting' })
    }
  })

  it('gives each of the three kinds an id of its own, and the vocabulary has no other event type', () => {
    const ids = ['Hearing', 'Markup', 'Meeting'].map(t => meetingType(t).typeId)
    expect(new Set(ids).size).toBe(3)
    expect(Object.keys(vocabulary.eventTypes).map(Number).sort()).toEqual([...ids].sort())
  })
})

describe('the recorded meetings that are not simply scheduled', () => {
  it('reads a postponed one, which cancels', () => {
    const m = read('118490')
    expect(m).toMatchObject({ status: 'Postponed', type: 'Hearing', date: '2025-07-15' })
    expect(isCancelled(m.status)).toBe(true)
  })

  it('reads a rescheduled one, which a meeting that moved is, and so does not cancel', () => {
    const m = read('118019')
    expect(m.status).toBe('Rescheduled')
    expect(isCancelled(m.status)).toBe(false)
  })

  it('reads a meeting the API gives no location for', () => {
    expect(recordedDetails.get('118812').committeeMeeting.location).toBeUndefined()
    expect(read('118812')).toMatchObject({ location: null, type: 'Markup', date: '2026-01-08', time: '10:15' })
  })

  it('reads a Senate business meeting that takes up sixty bills of both chambers', () => {
    const m = read('338795')
    expect(m).toMatchObject({ type: 'Open Business Meeting', chamber: 'senate', date: '2026-09-30', time: '10:00' })
    expect(m.bills).toHaveLength(60)
    expect(new Set(m.bills.map(b => b.type))).toEqual(new Set(['HR', 'S']))
  })

  it('collapses the no-break space a Senate title carries', () => {
    expect(recordedDetails.get('338746').committeeMeeting.title).toContain('\u00a0')
    expect(read('338746').title).toMatch(/^Hearings to examine housing needs in native communities, including S\./)
    expect(read('338746').title).not.toContain('\u00a0')
  })

  it('reads a closed hearing and a closed markup session', () => {
    expect(meetingType(read('338325').type).kind).toBe('hearing')
    expect(meetingType(read('338519').type).kind).toBe('markup')
  })
})

describe('the list of meetings', () => {
  const page = JSON.stringify(recordedListPage)

  it('is read into each meeting\'s event id, chamber, and update time, and the count of them all', () => {
    const { entries, count } = parseMeetingList(page, 119)
    expect(count).toBe(recordedListPage.pagination.count)
    expect(entries).toHaveLength(recordedListPage.committeeMeetings.length)
    expect(entries[0]).toEqual({ eventId: '118139', chamber: 'house', updateDate: '2026-10-16T19:47:29Z' })
    expect(entries.every(e => /^\d+$/.test(e.eventId) && e.chamber === 'house')).toBe(true)
  })

  it('reads a Senate and a joint meeting\'s chamber from the words the API uses', () => {
    const mixed = JSON.stringify({
      committeeMeetings: [
        { chamber: 'Senate', congress: 119, eventId: '338795', updateDate: '2026-09-30T12:00:00Z', url: 'https://api.congress.gov/v3/committee-meeting/119/senate/338795?format=json' },
        { chamber: 'NoChamber', congress: 119, eventId: '338796', updateDate: '2026-09-26T12:00:00Z', url: 'https://api.congress.gov/v3/committee-meeting/119/nochamber/338796?format=json' },
      ],
      pagination: { count: 2 },
    })
    expect(parseMeetingList(mixed, 119).entries.map(e => e.chamber)).toEqual(['senate', 'nochamber'])
  })

  it('may be an empty page, at the end', () => {
    expect(parseMeetingList(page, 119).entries).not.toEqual([])
    expect(parseMeetingList(JSON.stringify({ committeeMeetings: [], pagination: { count: 0 } }), 119)).toEqual({ entries: [], count: 0 })
  })

  const entry = (over: object = {}) => ({ chamber: 'House', congress: 119, eventId: '118139', updateDate: '2026-10-16T19:47:29Z', url: 'https://api.congress.gov/v3/committee-meeting/119/house/118139?format=json', ...over })
  const wrap = (entries: unknown, pagination: unknown = { count: 1 }) => JSON.stringify({ committeeMeetings: entries, pagination })
  const badLists: [string, string, RegExp][] = [
    ['isn\'t JSON', 'Service unavailable', /JSON/],
    ['is empty', '', /JSON/],
    ['is a list', '[]', /committeeMeetings/],
    ['has no meetings', JSON.stringify({ pagination: { count: 0 } }), /committeeMeetings/],
    ['has meetings that aren\'t a list', wrap({ a: 1 }), /committeeMeetings/],
    ['has no count', JSON.stringify({ committeeMeetings: [entry()] }), /count/],
    ['has a count that isn\'t a number', wrap([entry()], { count: 'many' }), /count/],
    ['has a negative count', wrap([entry()], { count: -1 }), /count/],
    ['has a count with a fraction', wrap([entry()], { count: 1.5 }), /count/],
    ['has an entry that isn\'t an object', wrap(['118139']), /isn\'t an object/],
    ['has an entry with no event id', wrap([entry({ eventId: undefined })]), /event/],
    ['has an event id that isn\'t a number', wrap([entry({ eventId: 'x1' })]), /event/],
    ['has an event id that is a number, not text', wrap([entry({ eventId: 118139 })]), /event/],
    ['has an entry with an unknown chamber', wrap([entry({ chamber: 'Both' })]), /chamber/],
    ['has an entry with no chamber', wrap([entry({ chamber: undefined })]), /chamber/],
    ['has an entry from another Congress', wrap([entry({ congress: 118 })]), /Congress 118, not 119/],
    ['has an entry with no update time', wrap([entry({ updateDate: undefined })]), /updateDate/],
    ['has an update time that isn\'t one', wrap([entry({ updateDate: 'yesterday' })]), /updateDate/],
    ['names an event twice', wrap([entry(), entry()], { count: 2 }), /twice|repeat|duplicate/i],
  ]
  it.each(badLists)('is a failure when it %s', (_what, text, message) => {
    expect(() => parseMeetingList(text, 119)).toThrow(message)
  })
})

describe('what a calendar shows of a meeting', () => {
  const ids = (code: string) => ({ hsed02: 3_000_000_001, hsju00: 3_000_000_002, hsas00: 3_000_000_003 } as Record<string, number>)[code]
  const meeting = (over: Partial<Meeting> = {}): Meeting => ({ ...read('119544'), ...over })

  it('names a meeting for its committee and type, in the words the API uses for the type', async () => {
    expect((await meetingBodyEvent(meeting({ type: 'Open Business Meeting', committees: [{ systemCode: 'hsas00', name: 'House Armed Services' }] }), ids)).title)
      .toBe('House Armed Services open business meeting')
    expect((await meetingBodyEvent(meeting({ committees: [] }), ids)).title).toBe('House hearing')
    expect((await meetingBodyEvent(meeting({ committees: [], chamber: 'senate' }), ids)).title).toBe('Senate hearing')
    expect((await meetingBodyEvent(meeting({ committees: [], chamber: 'nochamber' }), ids)).title).toBe('Joint hearing')
  })

  it('holds a meeting under its first committee that has a name, and names the others', async () => {
    const e = await meetingBodyEvent(meeting({ committees: [
      { systemCode: 'hsju00', name: null }, { systemCode: 'hsed02', name: 'Education' }, { systemCode: 'hsas00', name: 'Armed Services' },
    ] }), ids)
    expect(e.committee).toEqual({ committee_id: 3_000_000_001, name: 'Education', chamber: 'H' })
    expect(e.joint_with).toBe('Armed Services')
    expect(holdingCommittees([meeting({ committees: [{ systemCode: 'hsju00', name: null }, { systemCode: 'hsed02', name: 'Education' }] })])).toEqual(['hsed02'])
  })

  it('names no committee when central has no id for the one holding the meeting', async () => {
    expect((await meetingBodyEvent(meeting(), () => undefined)).committee).toBeNull()
  })

  it('puts the title first on the agenda, cut at 500 characters, and then each bill by its LegiScan number', async () => {
    const e = await meetingBodyEvent(meeting({ title: 'x'.repeat(600), bills: [{ type: 'HR', number: '12' }, { type: 'SJRES', number: '7' }, { type: 'HCONRES', number: '3' }] }), ids)
    expect(e.agenda[0].topic).toHaveLength(500)
    expect(e.agenda[0].topic.endsWith('…')).toBe(true)
    expect(e.agenda.slice(1)).toEqual([
      { topic: 'H.R. 12', bill_number: 'HB12' }, { topic: 'S.J.Res. 7', bill_number: 'SJR7' }, { topic: 'H.Con.Res. 3', bill_number: 'HCR3' },
    ])
    expect((await meetingBodyEvent(meeting({ title: '' }), ids)).agenda).toEqual([])
  })

  it('describes a bill\'s entry by the meeting\'s name and subject, cut at 280 characters', async () => {
    const m = meeting({ committees: [{ systemCode: 'hsed02', name: 'Education' }], title: 'A subject' })
    expect((await meetingEntry(m)).description).toBe('Education hearing: A subject')
    expect((await meetingEntry(meeting({ committees: [{ systemCode: 'hsed02', name: 'Education' }], title: '' }))).description).toBe('Education hearing')
    const long = (await meetingEntry(meeting({ title: 'y'.repeat(400) }))).description
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThanOrEqual('House Education and Workforce Subcommittee on Health, Employment, Labor, and Pensions hearing: '.length + 280)
  })

  it('makes an entry of the meeting\'s event id, kind, date, time, and place, and flags it only when it is cancelled', async () => {
    const e = await meetingEntry(meeting())
    expect(e).toEqual({
      type_id: 1, type: 'Hearing', date: '2026-09-15', time: '10:15', location: '2175 Rayburn House Office Building',
      description: expect.any(String), event_hash: expect.stringMatching(/^[0-9a-f]{32}$/), event_id: '119544',
    })
    expect(e).not.toHaveProperty('cancelled')
    expect(await meetingEntry(meeting({ status: 'Postponed' }))).toMatchObject({ cancelled: true })
    expect((await meetingEntry(meeting({ time: null, location: null }))).time).toBe('')
    expect((await meetingEntry(meeting({ time: null, location: null }))).location).toBe('')
  })

  it('changes the hash with anything shown, and with nothing else', async () => {
    const base = (await meetingBodyEvent(meeting(), ids)).event_hash
    const hash = async (over: Partial<Meeting>) => (await meetingBodyEvent(meeting(over), ids)).event_hash
    for (const over of [
      { date: '2026-09-16' }, { time: '11:00' }, { time: null }, { type: 'Markup' }, { title: 'Another' }, { location: '100 Main Street' },
      { committees: [{ systemCode: 'hsed02', name: 'Renamed' }] }, { bills: [{ type: 'HR' as const, number: '1' }] }, { status: 'Canceled' },
    ]) expect(await hash(over), JSON.stringify(over)).not.toBe(base)
    // Not an update time, a status that doesn't cancel, or a chamber nothing shows.
    expect(await hash({ updateDate: '2030-01-01T00:00:00Z' })).toBe(base)
    expect(await hash({ status: 'Rescheduled' })).toBe(base)
    expect((await meetingEntry(meeting({ status: 'Rescheduled' }))).event_hash).toBe((await meetingEntry(meeting())).event_hash)
    // The body event and the entry of one meeting change together.
    expect((await meetingEntry(meeting({ time: '11:00' }))).event_hash).toBe(await hash({ time: '11:00' }))
  })

  it('gives each bill its meetings\' entries by date, cancelled and past ones too, and leaves out a bill with none', async () => {
    const a = meeting({ eventId: '2', date: '2026-10-02', bills: [{ type: 'HR', number: '1' }, { type: 'S', number: '2' }] })
    const b = meeting({ eventId: '1', date: '2026-10-01', status: 'Canceled', bills: [{ type: 'HR', number: '1' }] })
    const c = meeting({ eventId: '3', date: '2026-10-03', bills: [] })
    const byBill = await entriesByBill([a, b, c])
    expect([...byBill.keys()].sort()).toEqual(['119/HR1', '119/S2'])
    expect(byBill.get('119/HR1')!.map(e => [e.event_id, e.date, e.cancelled ?? false])).toEqual([['1', '2026-10-01', true], ['2', '2026-10-02', false]])
    expect(byBill.get('119/S2')!.map(e => e.event_id)).toEqual(['2'])
  })

  it('takes a meeting\'s entries in an order that doesn\'t depend on the order the meetings came in', async () => {
    const ms = ['5', '3', '4'].map(eventId => meeting({ eventId, date: '2026-10-01', bills: [{ type: 'HR', number: '1' }] }))
    const forward = await entriesByBill(ms)
    const backward = await entriesByBill([...ms].reverse())
    expect(JSON.stringify([...forward])).toBe(JSON.stringify([...backward]))
    expect(forward.get('119/HR1')!.map(e => e.event_id)).toEqual(['3', '4', '5'])
  })
})

describe('the field inventories', () => {
  it('list every field of every recorded meeting and of the recorded list', () => {
    expect(inventoryProblems(meetingInventory, [...recordedDetails.values()])).toEqual([])
    expect(inventoryProblems(meetingListInventory, [recordedListPage])).toEqual([])
  })

  it('fail for a field the API starts sending, naming it', () => {
    const d = structuredClone(recordedDetails.get('118298'))
    d.committeeMeeting.newThing = 'x'
    d.committeeMeeting.relatedItems.bills[0].extraThing = 1
    expect(inventoryProblems(meetingInventory, [d])).toEqual([
      'not in the inventory: committeeMeeting.newThing',
      'not in the inventory: committeeMeeting.relatedItems.bills[].extraThing',
    ])
    const l = structuredClone(recordedListPage)
    l.committeeMeetings[0].extraThing = 1
    expect(inventoryProblems(meetingListInventory, [l])).toEqual(['not in the inventory: committeeMeetings[].extraThing'])
  })

  it('cover every field in the real meetings the field survey read', () => {
    const paths = JSON.parse(meetingPathsRaw) as string[]
    expect(paths.length).toBeGreaterThan(20)
    expect(paths.filter(p => inventoryProblems(meetingInventory, [pathObject(p)]).length > 0)).toEqual([])
  })

  it('has no entry for a field no meeting has, in the survey or in the recordings', () => {
    expect(Object.keys(meetingInventory).length).toBeGreaterThan(20)
    const seen = new Set((JSON.parse(meetingPathsRaw) as string[]))
    const unused = Object.keys(meetingInventory).filter(p => ![...seen].some(s => s === p || s.startsWith(`${p}.`) || s.startsWith(`${p}[]`)))
    expect(unused).toEqual([])
  })
})

/** An object with one field at this path, for checking a path against an inventory. */
function pathObject(path: string): unknown {
  const steps = path.split(/(\[\])|\./).filter(s => s !== undefined && s !== '')
  let value: unknown = 'x'
  for (const step of steps.reverse()) value = step === '[]' ? [value] : { [step]: value }
  return value
}
