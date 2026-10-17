import { describe, it, expect } from 'vitest'
import {
  parseHistoricalMembers, parseHouseRollCall, parseSenateMembers, parseSenateRollCall, readRecordedVotes, type RecordedVote,
} from '../../../src/providers/govinfo/rollcalls'
import { parseXml } from '../../../src/providers/govinfo/xml'
import { cvcFile, historicalFile, houseUrl, rollCallFiles, senateUrl } from '../../helpers/govinfoRollCalls'
import { fixtureFiles } from '../../helpers/govinfoZip'

// The readers of the House Clerk's and the Senate's roll call files, of
// senate.gov's member list, and of congress-legislators' historical file, and
// of the recorded votes a bill's actions link. Each reads one file shape and
// throws on anything else, so an ingest fails closed (the main-seam tests in
// test/cron/govinfo-rollcalls.test.ts cover that through a whole ingest).

const roll = (name: string) => rollCallFiles.get(name)!
const house = (year: number, n: number): RecordedVote => ({ chamber: 'H', congress: 119, session: year === 2025 ? 1 : 2, roll: n, url: houseUrl(year, n) })
const senate = (session: number, n: number): RecordedVote => ({ chamber: 'S', congress: 119, session, roll: n, url: senateUrl(119, session, n) })

describe('a House Clerk roll call file', () => {
  const read = (name: string, year: number, n: number) => parseHouseRollCall(name, roll(name), house(year, n))

  it('reads its tally, question, result, and day from the file\'s own fields', () => {
    const rc = read('house-2026-roll009.xml', 2026, 9)
    expect(rc).toMatchObject({
      chamber: 'H', congress: 119, session: 2, roll: 9, url: houseUrl(2026, 9),
      date: '2026-01-08', question: 'Passage, Objections of the President To The Contrary Notwithstanding', passed: false,
      yea: 248, nay: 177,
    })
  })

  it('counts "Present" with not voting, and has no absent', () => {
    const rc = read('house-2026-roll009.xml', 2026, 9)
    // 5 not voting and 1 who answered "Present".
    expect(rc.nv).toBe(6)
    expect(rc.absent).toBe(0)
  })

  it('names each voter by the Bioguide id the Clerk gives, with the name, party, and state it prints', () => {
    const rc = read('house-2025-roll028.xml', 2025, 28)
    expect(rc.voters).toContainEqual({ key: 'B001309', name: expect.any(String), firstName: '', lastName: expect.any(String), party: 'R', state: 'TN', vote: expect.any(String) })
    const adams = rc.voters.find(v => v.key === 'A000370')!
    expect(adams).toMatchObject({ name: 'Adams', lastName: 'Adams', party: 'D', state: 'NC' })
    expect(rc.voters.every(v => /^[A-Z]\d{6}$/.test(v.key))).toBe(true)
  })

  it('keeps the disambiguating state the Clerk puts in a name, such as "Clarke (NY)"', () => {
    const rc = read('house-2025-roll028.xml', 2025, 28)
    const clarke = rc.voters.find(v => v.name === 'Clarke (NY)')!
    expect(clarke).toMatchObject({ state: 'NY' })
  })

  it('reads the Speaker\'s vote as a vote like any other', () => {
    const rc = read('house-2025-roll052.xml', 2025, 52)
    const speaker = rc.voters.find(v => v.key === 'J000299')!
    expect(speaker).toBeDefined()
    expect(speaker.vote).toMatch(/^(Yea|Nay|Not Voting|Present)$/)
    expect(speaker.name).toBe('Johnson (LA)')
  })

  it('reads "Aye" and "No" as Yea and Nay, and keeps "Not Voting" and "Present"', () => {
    const rc = read('house-2025-roll195.xml', 2025, 195)
    expect([...new Set(rc.voters.map(v => v.vote))].sort()).toEqual(['Nay', 'Not Voting', 'Yea'])
    const present = read('house-2025-roll052.xml', 2025, 52)
    expect(present.voters.filter(v => v.vote === 'Present')).toHaveLength(1)
  })

  it.each([
    ['Passed', true], ['Agreed to', true], ['Failed', false],
  ])('reads the result "%s" as passed: %s', (result, passed) => {
    const xml = roll('house-2025-roll028.xml').replace('<vote-result>Passed</vote-result>', `<vote-result>${result}</vote-result>`)
    const rc = parseHouseRollCall('x.xml', xml, house(2025, 28))
    expect(rc.roll).toBe(28)
    expect(rc.passed).toBe(passed)
  })

  it('names the amendment on an amendment vote, so it reads differently from a vote on passage', () => {
    const xml = roll('house-2025-roll028.xml')
      .replace('<vote-question>On Motion to Suspend the Rules and Pass</vote-question>', '<vote-question>On Agreeing to the Amendment</vote-question>')
      .replace(/<amendment-num>[^<]*<\/amendment-num>|<amendment-num\/>/, '')
      .replace('</vote-question>', '</vote-question><amendment-num>3</amendment-num><amendment-author>Scott of Virginia Amendment No. 3</amendment-author>')
    const rc = parseHouseRollCall('x.xml', xml, house(2025, 28))
    expect(rc.question).toBe('On Agreeing to the Amendment (Scott of Virginia Amendment No. 3)')
  })

  it('reads a vote on a motion as that question alone', () => {
    expect(read('house-2025-roll194.xml', 2025, 194).question).toBe('On Ordering the Previous Question')
  })

  it.each([
    ['another roll number than the bill linked', (x: string) => x.replace('<rollcall-num>28</rollcall-num>', '<rollcall-num>29</rollcall-num>')],
    ['another Congress', (x: string) => x.replace('<congress>119</congress>', '<congress>118</congress>')],
    ['another session', (x: string) => x.replace('<session>1st</session>', '<session>2nd</session>')],
    ['a session that isn\'t "1st" or "2nd"', (x: string) => x.replace('<session>1st</session>', '<session>first</session>')],
    ['no vote-data', (x: string) => x.replace(/<vote-data>[\s\S]*<\/vote-data>/, '')],
    ['no voters', (x: string) => x.replace(/<vote-data>[\s\S]*<\/vote-data>/, '<vote-data/>')],
    ['a voter with no vote', (x: string) => x.replace('<vote>Yea</vote>', '<vote/>')],
    ['a vote that is a word it doesn\'t know', (x: string) => x.replace('<vote>Yea</vote>', '<vote>Abstain</vote>')],
    ['a voter named twice', (x: string) => x.replace('name-id="A000370"', 'name-id="B001309"')],
    ['a voter with no name-id', (x: string) => x.replace('name-id="A000370" ', '')],
    ['a voter whose name-id isn\'t a Bioguide id', (x: string) => x.replace('name-id="A000370"', 'name-id="1234"')],
    ['a voter with no state', (x: string) => x.replace('state="NC"', '')],
    ['a voter with a state that isn\'t one', (x: string) => x.replace('state="NC"', 'state="North Carolina"')],
    ['a root that isn\'t a roll call', (x: string) => x.replace(/rollcall-vote/g, 'html')],
    ['no totals', (x: string) => x.replace(/<totals-by-vote>[\s\S]*?<\/totals-by-vote>/, '')],
    ['a tally that isn\'t a number', (x: string) => x.replace(/(<totals-by-vote>[\s\S]*?<nay-total>)\d+/, '$1some')],
    ['a tally of 1.5', (x: string) => x.replace(/(<totals-by-vote>[\s\S]*?<nay-total>)\d+/, '$11.5')],
    ['a missing tally', (x: string) => x.replace(/(<totals-by-vote>[\s\S]*?)<yea-total>\d+<\/yea-total>/, '$1')],
    ['a result it doesn\'t know', (x: string) => x.replace('<vote-result>Passed</vote-result>', '<vote-result>Ignored</vote-result>')],
    ['a date it can\'t read', (x: string) => x.replace(/<action-date>[^<]*<\/action-date>/, '<action-date>2025-02-04</action-date>')],
    ['a month it doesn\'t know', (x: string) => x.replace(/<action-date>[^<]*<\/action-date>/, '<action-date>4-Foo-2025</action-date>')],
    ['a day that isn\'t a day', (x: string) => x.replace(/<action-date>[^<]*<\/action-date>/, '<action-date>31-Feb-2025</action-date>')],
    ['no question', (x: string) => x.replace(/<vote-question>[^<]*<\/vote-question>/, '')],
  ])('throws on a file with %s', (_what, change) => {
    const xml = change(roll('house-2025-roll028.xml'))
    expect(xml).not.toBe(roll('house-2025-roll028.xml'))
    expect(() => parseHouseRollCall('house-2025-roll028.xml', xml, house(2025, 28))).toThrow(/house-2025-roll028\.xml/)
  })

  it('throws on text that isn\'t XML, and on XML cut off in the middle', () => {
    expect(() => parseHouseRollCall('x.xml', 'not xml', house(2025, 28))).toThrow(/x\.xml/)
    expect(() => parseHouseRollCall('x.xml', roll('house-2025-roll028.xml').slice(0, 3000), house(2025, 28))).toThrow(/x\.xml/)
  })

  it('reads every House roll call the bills link', () => {
    for (const name of rollCallFiles.keys()) {
      const m = /^house-(\d{4})-roll(\d{3})\.xml$/.exec(name)
      if (!m) continue
      const rc = parseHouseRollCall(name, roll(name), house(Number(m[1]), Number(m[2])))
      expect(rc.voters.length, name).toBeGreaterThan(10)
      expect(rc.yea + rc.nay, name).toBeGreaterThan(100)
    }
  })
})

describe('a Senate roll call file', () => {
  const read = (name: string, session: number, n: number) => parseSenateRollCall(name, roll(name), senate(session, n))

  it('reads its tally, question, result, and day from the file\'s own fields', () => {
    const rc = read('senate-119-1-00097.xml', 1, 97)
    expect(rc).toMatchObject({ chamber: 'S', congress: 119, session: 1, roll: 97, url: senateUrl(119, 1, 97), passed: true, yea: 52, nay: 47, nv: 0, absent: 1 })
    expect(rc.question).toMatch(/^On the Joint Resolution H\.J\.Res\. 35/)
    expect(rc.date).toMatch(/^2025-\d{2}-\d{2}$/)
  })

  it('names each voter by the LIS id the Senate gives, with their name, party, and state', () => {
    const rc = read('senate-119-1-00097.xml', 1, 97)
    const alsobrooks = rc.voters.find(v => v.key === 'S428')!
    expect(alsobrooks).toEqual({ key: 'S428', name: 'Angela Alsobrooks', firstName: 'Angela', lastName: 'Alsobrooks', party: 'D', state: 'MD', vote: 'Nay' })
    expect(rc.voters.every(v => /^S\d+$/.test(v.key))).toBe(true)
  })

  it('serves the senators who didn\'t vote as "Not Voting", counted as absent', () => {
    const rc = read('senate-119-1-00097.xml', 1, 97)
    expect(rc.voters.filter(v => v.vote === 'Not Voting')).toHaveLength(1)
    expect(rc.absent).toBe(1)
  })

  it('counts "Present" with not voting, and keeps "Present" as the vote', () => {
    const xml = roll('senate-119-1-00097.xml').replace('<present/>', '<present>1</present>').replace('<vote_cast>Nay</vote_cast>', '<vote_cast>Present</vote_cast>')
    const rc = parseSenateRollCall('x.xml', xml, senate(1, 97))
    expect(rc.nv).toBe(1)
    expect(rc.voters.filter(v => v.vote === 'Present')).toHaveLength(1)
  })

  it.each([
    ['Joint Resolution Passed', true], ['Bill Passed', true], ['Resolution Agreed to', true], ['Concurrent Resolution Agreed to', true],
    ['Amendment Agreed to', true], ['Motion Agreed to', true], ['Motion to Proceed Agreed to', true], ['Motion to Table Agreed to', true],
    ['Motion to Discharge Agreed to', true], ['Cloture Motion Agreed to', true], ['Cloture on the Motion to Proceed Agreed to', true],
    ['Point of Order Sustained', true], ['Point of Order Well Taken', true], ['Decision of Chair Sustained', true],
    ['Amendment Rejected', false], ['Motion Rejected', false], ['Cloture on the Motion to Proceed Rejected', false], ['Cloture Motion Rejected', false],
    ['Motion to Discharge Rejected', false], ['Motion to Proceed Rejected', false], ['Motion to Recommit Rejected', false],
    ['Joint Resolution Defeated', false], ['Bill Defeated', false], ['Motion to Table Failed', false], ['Concurrent Resolution Rejected', false],
    ['Decision of Chair Not Sustained', false], ['Point of Order Not Well Taken', false],
    // A veto override vote: the Senate writes "Veto Sustained" when the override fails, which is no passage, and "Veto Overridden" when it succeeds.
    ['Veto Overridden', true], ['Veto Sustained', false],
    ['Amendment Germane', true], ['Amendment Not Germane', false],
    ['Cloture Invoked', true], ['Cloture Not Invoked', false],
    ['Conference Report Agreed to', true], ['Motion to Waive Agreed to', true], ['Motion to Waive Rejected', false], ['Not Agreed to', false],
  ])('reads the result "%s" as passed: %s', (result, passed) => {
    const xml = roll('senate-119-1-00097.xml').replace('<vote_result>Joint Resolution Passed</vote_result>', `<vote_result>${result}</vote_result>`)
    const rc = parseSenateRollCall('x.xml', xml, senate(1, 97))
    expect(rc.roll).toBe(97)
    expect(rc.passed).toBe(passed)
  })

  it('names a vote on an amendment by its own question, which says the amendment', () => {
    const xml = roll('senate-119-1-00097.xml').replace(/<vote_question_text>[^<]*<\/vote_question_text>/, '<vote_question_text>On the Amendment S.Amdt. 23 to S. 5 (No short title on file)</vote_question_text>')
    expect(parseSenateRollCall('x.xml', xml, senate(1, 97)).question).toBe('On the Amendment S.Amdt. 23 to S. 5 (No short title on file)')
  })

  it('falls back to the short question when the long one is missing', () => {
    const xml = roll('senate-119-1-00097.xml').replace(/<vote_question_text>[^<]*<\/vote_question_text>/, '')
    expect(parseSenateRollCall('x.xml', xml, senate(1, 97)).question).toBe('On the Joint Resolution')
  })

  it.each([
    ['another vote number than the bill linked', (x: string) => x.replace('<vote_number>97</vote_number>', '<vote_number>98</vote_number>')],
    ['another Congress', (x: string) => x.replace('<congress>119</congress>', '<congress>118</congress>')],
    ['another session', (x: string) => x.replace('<session>1</session>', '<session>2</session>')],
    ['no members', (x: string) => x.replace(/<members>[\s\S]*<\/members>/, '<members/>')],
    ['a member with no vote', (x: string) => x.replace('<vote_cast>Nay</vote_cast>', '<vote_cast/>')],
    ['a vote it doesn\'t know', (x: string) => x.replace('<vote_cast>Nay</vote_cast>', '<vote_cast>Guilty</vote_cast>')],
    ['a member with no LIS id', (x: string) => x.replace('<lis_member_id>S428</lis_member_id>', '<lis_member_id/>')],
    ['a member with a LIS id that isn\'t one', (x: string) => x.replace('<lis_member_id>S428</lis_member_id>', '<lis_member_id>428</lis_member_id>')],
    ['a member named twice', (x: string) => x.replace('<lis_member_id>S428</lis_member_id>', '<lis_member_id>S330</lis_member_id>')],
    ['a member with no last name', (x: string) => x.replace('<last_name>Alsobrooks</last_name>', '<last_name/>')],
    ['a member with no state', (x: string) => x.replace(/(<last_name>Alsobrooks<\/last_name>[\s\S]*?)<state>MD<\/state>/, '$1<state/>')],
    ['a root that isn\'t a roll call', (x: string) => x.replace(/roll_call_vote/g, 'html')],
    ['no count', (x: string) => x.replace(/<count>[\s\S]*?<\/count>/, '')],
    ['a count that isn\'t a number', (x: string) => x.replace('<nays>47</nays>', '<nays>many</nays>')],
    ['no yeas', (x: string) => x.replace('<yeas>52</yeas>', '')],
    ['no nays', (x: string) => x.replace('<nays>47</nays>', '')],
    ['a result it doesn\'t know', (x: string) => x.replace('<vote_result>Joint Resolution Passed</vote_result>', '<vote_result>Noted</vote_result>')],
    ['no result', (x: string) => x.replace(/<vote_result>[^<]*<\/vote_result>/, '')],
    ['a date it can\'t read', (x: string) => x.replace(/<vote_date>[^<]*<\/vote_date>/, '<vote_date>2025-01-02</vote_date>')],
    ['a month it doesn\'t know', (x: string) => x.replace(/<vote_date>[^<]*<\/vote_date>/, '<vote_date>Smarch 9, 2025,  02:54 PM</vote_date>')],
    ['a day that isn\'t a day', (x: string) => x.replace(/<vote_date>[^<]*<\/vote_date>/, '<vote_date>February 31, 2025,  02:54 PM</vote_date>')],
    ['no question at all', (x: string) => x.replace(/<vote_question_text>[^<]*<\/vote_question_text>/, '').replace(/<question>[^<]*<\/question>/, '')],
  ])('throws on a file with %s', (_what, change) => {
    const xml = change(roll('senate-119-1-00097.xml'))
    expect(xml).not.toBe(roll('senate-119-1-00097.xml'))
    expect(() => parseSenateRollCall('senate-119-1-00097.xml', xml, senate(1, 97))).toThrow(/senate-119-1-00097\.xml/)
  })

  it('throws on text that isn\'t XML, and on XML cut off in the middle', () => {
    expect(() => parseSenateRollCall('x.xml', 'not xml', senate(1, 97))).toThrow(/x\.xml/)
    expect(() => parseSenateRollCall('x.xml', roll('senate-119-1-00097.xml').slice(0, 3000), senate(1, 97))).toThrow(/x\.xml/)
  })

  it('reads every Senate roll call the bills link', () => {
    for (const name of rollCallFiles.keys()) {
      const m = /^senate-119-(\d)-(\d{5})\.xml$/.exec(name)
      if (!m) continue
      const rc = parseSenateRollCall(name, roll(name), senate(Number(m[1]), Number(m[2])))
      expect(rc.voters.length, name).toBeGreaterThan(10)
      expect(rc.yea + rc.nay + rc.nv + rc.absent, name).toBe(100)
    }
  })
})

describe('senate.gov\'s member list', () => {
  it('maps each sitting senator\'s LIS id to their Bioguide id', () => {
    const map = parseSenateMembers(cvcFile)
    expect(map.get('S428')).toBe('A000382')
    expect(map.get('S330')).toBe('B001267')
    expect(map.size).toBe(40)
    expect([...map.values()].every(b => /^[A-Z]\d{6}$/.test(b))).toBe(true)
  })

  it('has no entry for a senator who left, since the list is of the sitting', () => {
    const map = parseSenateMembers(cvcFile)
    expect(map.size).toBe(40)
    for (const gone of ['S293', 'S419', 'S350', 'S421']) expect(map.has(gone), gone).toBe(false)
  })

  it('leaves out a senator it gives no Bioguide id, so the historical file can answer for them', () => {
    const xml = '<senators><senator lis_member_id="S1"><name><last>A</last></name><bioguideId>A000001</bioguideId></senator><senator lis_member_id="S2"><name><last>B</last></name></senator></senators>'
    expect([...parseSenateMembers(xml)]).toEqual([['S1', 'A000001']])
  })

  it.each([
    ['text that isn\'t XML', 'not xml'],
    ['a web page', '<html><body>Down</body></html>'],
    ['a list with no senators', '<senators></senators>'],
    ['a senator with a Bioguide id that isn\'t one', '<senators><senator lis_member_id="S1"><bioguideId>nope</bioguideId></senator></senators>'],
    ['a senator with a LIS id that isn\'t one', '<senators><senator lis_member_id="1"><bioguideId>A000001</bioguideId></senator></senators>'],
    ['a senator with no LIS id', '<senators><senator><bioguideId>A000001</bioguideId></senator></senators>'],
    ['a senator named twice', '<senators><senator lis_member_id="S1"><bioguideId>A000001</bioguideId></senator><senator lis_member_id="S1"><bioguideId>A000002</bioguideId></senator></senators>'],
    ['a list cut off in the middle', cvcFile.slice(0, 2000)],
  ])('throws on %s', (_what, xml) => {
    expect(() => parseSenateMembers(xml)).toThrow()
  })
})

describe('congress-legislators\' historical file', () => {
  it('maps the LIS id of each senator in it to their Bioguide id', () => {
    const map = parseHistoricalMembers(historicalFile)
    expect(map.get('S421')).toBe('V000137')
    expect(map.get('S350')).toBe('R000595')
    expect(map.get('S419')).toBe('M001190')
    expect(map.get('S293')).toBe('G000359')
  })

  it('has no entry for a legislator with no LIS id, such as the House members', () => {
    const map = parseHistoricalMembers(historicalFile)
    expect(map.size).toBeGreaterThanOrEqual(4)
    expect([...map.keys()].every(k => /^S\d+$/.test(k))).toBe(true)
  })

  const header = 'last_name,first_name,bioguide_id,lis_id'
  it('reads a quoted field with a comma, a doubled quote, and a line break in it', () => {
    const csv = `${header}\n"Smith, Jr.","Ann ""Bo""",A000001,S1\n"multi\nline",Cy,B000002,S2\n`
    expect([...parseHistoricalMembers(csv)]).toEqual([['S1', 'A000001'], ['S2', 'B000002']])
  })

  it('reads CRLF line endings, a leading byte order mark, and a file with no final newline', () => {
    expect([...parseHistoricalMembers(`﻿${header}\r\nA,B,A000001,S1\r\nC,D,C000003,S3`)]).toEqual([['S1', 'A000001'], ['S3', 'C000003']])
  })

  it('finds the columns by name, wherever the file puts them', () => {
    expect([...parseHistoricalMembers('lis_id,x,bioguide_id\nS9,y,Z000009\n')]).toEqual([['S9', 'Z000009']])
  })

  it.each([
    ['text that isn\'t CSV', 'not a csv at all'],
    ['a web page', '<html><body>nope</body></html>'],
    ['a file with no lis_id column', 'last_name,bioguide_id\nA,A000001\n'],
    ['a file with no bioguide_id column', 'last_name,lis_id\nA,S1\n'],
    ['a file with no senators', `${header}\nA,B,A000001,\n`],
    ['a header and nothing else', header],
    ['a quoted field that never ends', `${header}\n"A,B,A000001,S1\n`],
    ['a legislator with a LIS id and no Bioguide id', `${header}\nA,B,,S1\n`],
    ['a legislator with a Bioguide id that isn\'t one', `${header}\nA,B,nope,S1\n`],
    ['a LIS id that isn\'t one', `${header}\nA,B,A000001,1\n`],
    ['the same LIS id for two Bioguide ids', `${header}\nA,B,A000001,S1\nC,D,C000003,S1\n`],
    ['a row with fewer fields than the header', `${header}\nA,B\n`],
  ])('throws on %s', (_what, csv) => {
    expect(() => parseHistoricalMembers(csv)).toThrow()
  })

  it('reads the same LIS id on two rows for one legislator once', () => {
    const csv = `${header}\nA,B,A000001,S1\nA,B,A000001,S1\n`
    expect([...parseHistoricalMembers(csv)]).toEqual([['S1', 'A000001']])
  })
})

describe('the votes a bill\'s actions link', () => {
  const record = (name: string) => {
    const bill = parseXml(fixtureFiles.get(`BILLSTATUS-119${name}.xml`)!).root.children.find(c => c.name === 'bill')!
    const text = (n: string) => bill.children.find(c => c.name === n)!.text
    return { bill, record: { congress: Number(text('congress')), type: text('type'), number: text('number') } as any }
  }

  it('lists a roll call once, though the House floor and the Library of Congress each record it', () => {
    const { bill, record: r } = record('hr43')
    expect(readRecordedVotes('f.xml', bill, r)).toEqual([house(2025, 28)])
  })

  it('gives a bill that has no recorded votes none, and one that has them its own', () => {
    const none = record('hr3132')
    expect(readRecordedVotes('f.xml', none.bill, none.record)).toEqual([])
    const some = record('hr131')
    expect(readRecordedVotes('f.xml', some.bill, some.record)).toEqual([house(2026, 9)])
  })

  it('lists each different roll call a bill links, oldest action first', () => {
    const { bill, record: r } = record('hr9238')
    const votes = readRecordedVotes('f.xml', bill, r)
    expect(votes.map(v => v.roll)).toEqual([221])
    expect(votes[0]).toEqual(house(2026, 221))
  })

  it('leaves out the votes on a bill\'s amendments, which the provider doesn\'t read', () => {
    const bill = parseXml(`<billStatus><bill><congress>119</congress><type>HR</type><number>5</number>
      <actions><item><actionDate>2025-01-02</actionDate><text>Introduced in House</text>
        <recordedVotes><recordedVote><rollNumber>29</rollNumber><url>${houseUrl(2025, 29)}</url><chamber>House</chamber><congress>119</congress><sessionNumber>1</sessionNumber></recordedVote></recordedVotes>
      </item></actions>
      <amendments><amendment><actions><actions><item><actionDate>2025-02-02</actionDate><text>Agreed to</text>
        <recordedVotes><recordedVote><rollNumber>28</rollNumber><url>${houseUrl(2025, 28)}</url><chamber>House</chamber><congress>119</congress><sessionNumber>1</sessionNumber></recordedVote></recordedVotes>
      </item></actions></actions></amendment></amendments></bill></billStatus>`).root.children[0]
    expect(readRecordedVotes('f.xml', bill, { congress: 119, type: 'HR', number: '5' } as any).map(v => v.roll)).toEqual([29])
  })

  it('lists the votes of a bill\'s actions in the order its actions are, oldest first', () => {
    const vote = (n: number, y: number) => `<recordedVotes><recordedVote><rollNumber>${n}</rollNumber><url>${houseUrl(y, n)}</url><chamber>House</chamber><congress>119</congress><sessionNumber>${y === 2025 ? 1 : 2}</sessionNumber></recordedVote></recordedVotes>`
    // The feed lists the newest action first.
    const bill = parseXml(`<billStatus><bill><congress>119</congress><type>HR</type><number>5</number><actions>
      <item><actionDate>2026-02-02</actionDate><text>b</text>${vote(40, 2026)}</item>
      <item><actionDate>2025-02-02</actionDate><text>a</text>${vote(30, 2025)}</item>
    </actions></bill></billStatus>`).root.children[0]
    expect(readRecordedVotes('f.xml', bill, { congress: 119, type: 'HR', number: '5' } as any).map(v => v.roll)).toEqual([30, 40])
  })

  it.each([
    ['a Senate vote with the address of a House vote', senateUrl(119, 1, 97), 'House'],
    ['a House vote with the address of a Senate vote', houseUrl(2025, 28), 'Senate'],
  ])('throws on %s', (_what, url, chamber) => {
    const bill = parseXml(`<billStatus><bill><congress>119</congress><type>HR</type><number>5</number><actions><item><actionDate>2025-02-02</actionDate><text>a</text>
      <recordedVotes><recordedVote><rollNumber>28</rollNumber><url>${url}</url><chamber>${chamber}</chamber><congress>119</congress><sessionNumber>1</sessionNumber></recordedVote></recordedVotes>
    </item></actions></bill></billStatus>`).root.children[0]
    expect(() => readRecordedVotes('f.xml', bill, { congress: 119, type: 'HR', number: '5' } as any)).toThrow(/f\.xml/)
  })
})
