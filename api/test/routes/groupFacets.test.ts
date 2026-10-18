import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { seedBill } from '../helpers'
import { associationConfig, bills, billCustomFieldValues, billSubjects, customFieldDefinitions, memberVotes, notes, officialPositions } from '../../src/db/schema'
import { SUPPRESSED_SUBJECT_STATES_KEY } from '../../src/lib/billSubjects'
import { ada, db, facets, group, reset, total } from './groupFacetsHarness'

// Filter counts count companion groups (#380). A facet count is what the list
// will total if you pick the value, so every count is checked against the
// list itself, which already shows one row per group (#379). The team's own
// fields are the group's current value: a bill keeps the value it was given
// after a newer one on a companion replaced it, and a count must not see it.
// The random fixtures that check every count are in groupFacetsRandom*.test.ts.

describe('facet counts count a companion group once', () => {
  beforeEach(reset)

  describe('provider facts', () => {
    it('counts a group once under each status its bills have, however many of its bills share it', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', status: 'Passed', statusStage: 'passed', state: 'NJ' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', status: 'Passed', statusStage: 'passed', state: 'NJ' })
      await seedBill({ id: 'c9', billNumber: 'A9', status: 'Introduced', statusStage: 'introduced', state: 'NJ' })
      await seedBill({ id: 'solo', billNumber: 'HB 1', status: 'Passed', statusStage: 'passed', state: 'TX' })
      await group('a190', 'b1713', 'c9')
      const f = await facets()
      expect(f.status).toEqual({ Passed: 2, Introduced: 1 })
      expect(f.stage).toEqual({ passed: 2, introduced: 1 })
      expect(f.state).toEqual({ NJ: 1, TX: 1 })
    })

    it('counts a group once for each subject, when two of its bills carry it', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ' })
      await group('a190', 'b1713')
      await db().insert(billSubjects).values([
        { billId: 'a190', subjectName: 'Elections', state: 'NJ' },
        { billId: 'b1713', subjectName: 'Elections', state: 'NJ' },
        { billId: 'b1713', subjectName: 'Taxes', state: 'NJ' },
      ])
      expect((await facets()).subject).toEqual({ 'NJ:Elections': 1, 'NJ:Taxes': 1 })
    })

    it('counts a group through the one bill that meets every filter', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', status: 'Introduced', statusStage: 'introduced', state: 'NJ' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', status: 'Passed', statusStage: 'passed', state: 'TX' })
      await group('a190', 'b1713')
      // No single bill is both Passed and in NJ, so picking NJ under Passed finds nothing.
      expect((await facets('status=Passed')).state).toEqual({ TX: 1 })
      expect(await total('status=Passed&state=NJ')).toBe(0)
    })
  })

  describe("the group's current value of a team field", () => {
    it('counts a priority a newer one on a companion replaced under the new one only', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190' })
      await seedBill({ id: 'b1713', billNumber: 'S1713' })
      await group('a190', 'b1713')
      await db().update(bills).set({ priority: 'high', prioritySetAt: '2026-01-01 00:00:00' }).where(eq(bills.id, 'a190'))
      await db().update(bills).set({ priority: 'low', prioritySetAt: '2026-02-01 00:00:00' }).where(eq(bills.id, 'b1713'))
      const f = await facets()
      expect(f.priority.low).toBe(1)
      expect(f.priority.high ?? 0).toBe(0)
      expect(f.priority.__any__).toBe(1)
      expect(f.priority.none).toBe(0)
    })

    it('counts a group with no priority once, though both its bills have none', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190' })
      await seedBill({ id: 'b1713', billNumber: 'S1713' })
      await seedBill({ id: 'solo', billNumber: 'HB 1' })
      await group('a190', 'b1713')
      expect((await facets()).priority.none).toBe(2)
    })

    it('counts a position on the group, from the bill that holds it, and the group without one as none', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190' })
      await seedBill({ id: 'b1713', billNumber: 'S1713' })
      await seedBill({ id: 'c1', billNumber: 'HB 1' })
      await seedBill({ id: 'c2', billNumber: 'HB 2' })
      await group('a190', 'b1713')
      await db().insert(officialPositions).values([
        { id: 'p1', billId: 'a190', position: 'Support', setBy: ada, updatedAt: '2026-01-01 00:00:00' },
        { id: 'p2', billId: 'b1713', position: 'Oppose', setBy: ada, updatedAt: '2026-02-01 00:00:00' },
        { id: 'p3', billId: 'c1', position: 'Oppose', setBy: ada, updatedAt: '2026-01-01 00:00:00' },
      ])
      const f = await facets()
      expect(f.position.Oppose).toBe(2)
      expect(f.position.Support ?? 0).toBe(0)
      expect(f.position.__any__).toBe(2)
      expect(f.position.none).toBe(1)
    })

    it("counts a tag through the group's current analysis only", async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', tags: ['Energy'], aiProcessedAt: '2026-01-01 00:00:00' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', tags: ['Labor'], aiProcessedAt: '2026-02-01 00:00:00' })
      await group('a190', 'b1713')
      const f = await facets()
      expect(f.tag.Labor).toBe(1)
      expect(f.tag.Energy ?? 0).toBe(0)
      expect(f.tag.__any__).toBe(1)
    })

    it('counts a custom field option the group currently holds, once, though both bills set it', async () => {
      await db().insert(customFieldDefinitions).values({ id: 'cf1', name: 'Committee', slug: 'committee', type: 'dropdown', options: JSON.stringify(['Energy', 'Labor']) })
      await seedBill({ id: 'a190', billNumber: 'A190' })
      await seedBill({ id: 'b1713', billNumber: 'S1713' })
      await seedBill({ id: 'c1', billNumber: 'HB 1' })
      await group('a190', 'b1713')
      await db().insert(billCustomFieldValues).values([
        { billId: 'a190', fieldId: 'cf1', value: 'Energy', setBy: ada, updatedAt: '2026-01-01 00:00:00' },
        { billId: 'b1713', fieldId: 'cf1', value: 'Labor', setBy: ada, updatedAt: '2026-02-01 00:00:00' },
        { billId: 'c1', fieldId: 'cf1', value: 'Labor', setBy: ada, updatedAt: '2026-02-01 00:00:00' },
      ])
      const f = await facets()
      expect(f.field.cf1.Labor).toBe(2)
      expect(f.field.cf1.Energy ?? 0).toBe(0)
      expect(f.field.cf1.__any__).toBe(2)
    })
  })

  describe('the counts beside the facets', () => {
    it('counts a group once in the new matches, drafts, my bills, and unvoted counts', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', newMatchAt: '2026-03-01 00:00:00', isDraft: true })
      await seedBill({ id: 'b1713', billNumber: 'S1713', newMatchAt: '2026-03-02 00:00:00', isDraft: true })
      await seedBill({ id: 'solo', billNumber: 'HB 1', newMatchAt: '2026-03-03 00:00:00' })
      await group('a190', 'b1713')
      await db().insert(memberVotes).values([
        { id: 'v1', userId: ada, billId: 'a190', position: 'support' },
        { id: 'v2', userId: ada, billId: 'b1713', position: 'oppose' },
      ])
      await db().insert(notes).values({ id: 'n1', billId: 'a190', userId: ada, content: 'hi' })
      const f = await facets()
      expect(f.newMatchesCount).toBe(2)
      expect(f.draftCount).toBe(1)
      expect(f.myBillsCount).toBe(1)
      // The member voted on both bills of the group, so only the solo bill is unvoted.
      expect(f.unvotedCount).toBe(1)
    })

    it('counts the unvoted group of a member who voted on one bill of it as voted', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190' })
      await seedBill({ id: 'b1713', billNumber: 'S1713' })
      await group('a190', 'b1713')
      await db().insert(memberVotes).values({ id: 'v1', userId: ada, billId: 'a190', position: 'support' })
      expect((await facets()).unvotedCount).toBe(0)
      expect((await facets('unvoted=1')).status).toEqual({})
    })

    describe('my bills is group-wide (#552)', () => {
      // A190 (Introduced) and S1713 (Passed) are a group; HB 1 and HB 2 are in none.
      async function seed() {
        await seedBill({ id: 'a190', billNumber: 'A190', status: 'Introduced', statusStage: 'introduced', state: 'NJ' })
        await seedBill({ id: 'b1713', billNumber: 'S1713', status: 'Passed', statusStage: 'passed', state: 'NJ' })
        await seedBill({ id: 'solo', billNumber: 'HB 1', status: 'Introduced', statusStage: 'introduced', state: 'TX' })
        await seedBill({ id: 'other', billNumber: 'HB 2', status: 'Passed', statusStage: 'passed', state: 'TX' })
        await group('a190', 'b1713')
      }
      const vote = (billId: string) => db().insert(memberVotes).values({ id: crypto.randomUUID(), billId, userId: ada, position: 'support' })

      it('counts the group when only one of its bills is mine and the filter meets only the other', async () => {
        await seed()
        await vote('a190')
        const f = await facets('status=Passed')
        expect(f.myBillsCount).toBe(1)
        expect(await total('myBills=1&status=Passed')).toBe(1)
      })

      it('agrees with the list under every filter, including with the group out of it', async () => {
        await seed()
        await vote('a190')
        for (const [qs, groups] of [
          ['', 1], ['status=Passed', 1], ['status=Introduced', 1], ['state=NJ', 1], ['state=TX', 0],
          ['status=Passed&state=NJ', 1], ['status=Passed&state=TX', 0], ['unvoted=1', 0], ['status=Passed&unvoted=1', 0],
        ] as const) {
          expect([qs, 'count', (await facets(qs)).myBillsCount]).toEqual([qs, 'count', groups])
          expect([qs, 'list', await total(`myBills=1&${qs}`)]).toEqual([qs, 'list', groups])
        }
      })

      it('counts the other facets of the my bills list by its groups', async () => {
        await seed()
        await vote('a190')
        const f = await facets('myBills=1')
        expect(f.status).toEqual({ Introduced: 1, Passed: 1 })
        expect(f.state).toEqual({ NJ: 1 })
        expect(f.myBillsCount).toBe(1)
      })

      it('counts a group none of whose bills is mine in no facet of my bills', async () => {
        await seed()
        await vote('solo')
        expect((await facets('status=Passed')).myBillsCount).toBe(0)
        expect((await facets('')).myBillsCount).toBe(1)
        expect((await facets('myBills=1')).status).toEqual({ Introduced: 1 })
      })

      it('counts a bill in no group as before', async () => {
        await seed()
        await vote('solo')
        expect((await facets('state=TX')).myBillsCount).toBe(1)
        expect((await facets('status=Passed&state=TX')).myBillsCount).toBe(0)
      })

      it('counts the group once, once with unvoted as well, and not at all once I have voted on it', async () => {
        await seed()
        await db().insert(notes).values({ id: 'n1', billId: 'a190', userId: ada, content: '<p>mine</p>' })
        const f = await facets('status=Passed')
        expect(f.myBillsCount).toBe(1)
        expect(f.unvotedCount).toBe(2)
        expect(await total('myBills=1&unvoted=1&status=Passed')).toBe(1)
        expect((await facets('myBills=1&unvoted=1')).myBillsCount).toBe(1)
        await vote('b1713')
        expect(await total('myBills=1&unvoted=1&status=Passed')).toBe(0)
        expect((await facets('myBills=1&unvoted=1')).myBillsCount).toBe(0)
      })

      it('returns each bill to its own count when the group splits', async () => {
        await seed()
        await vote('a190')
        await db().update(bills).set({ groupKey: null }).where(eq(bills.id, 'a190'))
        await db().update(bills).set({ groupKey: null }).where(eq(bills.id, 'b1713'))
        expect((await facets('status=Passed')).myBillsCount).toBe(0)
        expect((await facets('status=Introduced')).myBillsCount).toBe(1)
        expect((await facets('')).myBillsCount).toBe(1)
      })

      it("reads the member's bills once per facets request, with or without the scope on", async () => {
        await seed()
        await vote('a190')
        await db().insert(notes).values({ id: 'n1', billId: 'b1713', userId: ada, content: '<p>mine</p>' })
        // loadMyBillIds reads the member's notes once, so the statements that read them count its runs.
        const noteReads: string[] = []
        const realPrepare = env.DB.prepare.bind(env.DB)
        const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
          if (/from "notes"/i.test(sql)) noteReads.push(sql)
          return realPrepare(sql)
        })
        try {
          for (const qs of ['', 'myBills=1', 'myBills=1&status=Passed&unvoted=1']) {
            noteReads.length = 0
            await facets(qs)
            expect([qs, noteReads.length]).toEqual([qs, 1])
          }
        } finally {
          spy.mockRestore()
        }
      })

      it('counts the my bills of an OR selection by the groups it reaches', async () => {
        await seed()
        await vote('a190')
        const qs = 'status=Passed&state=TX&match=any'
        expect((await facets(qs)).myBillsCount).toBe(await total(`myBills=1&${qs}`))
        expect(await total(`myBills=1&${qs}`)).toBe(1)
      })
    })

    it('counts the matching groups of the active filter, not the bills', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', status: 'Passed', newMatchAt: '2026-03-01 00:00:00' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', status: 'Passed', newMatchAt: '2026-03-02 00:00:00' })
      await group('a190', 'b1713')
      expect((await facets('status=Passed')).newMatchesCount).toBe(1)
    })
  })

  describe('D1 limits', () => {
    it('counts a broad OR selection of states and statuses, which is more than a hundred bound values', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', status: 'S0', statusStage: 'passed', state: 'NJ' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', status: 'S1', statusStage: 'introduced', state: 'S1' })
      await group('a190', 'b1713')
      const picks = Array.from({ length: 45 }, (_, i) => [`status=S${i}`, `state=S${i}`]).flat()
      expect((await facets(`match=any&${picks.join('&')}`)).status.S0).toBe(1)
    })
  })

  describe('the OR resulting total', () => {
    it('adds a group only when none of its bills is in the current result', async () => {
      // The group is in the current result through A190 (Passed). S1713 (Introduced) has the value
      // picked, but its group is already showing, so picking it changes nothing.
      await seedBill({ id: 'a190', billNumber: 'A190', status: 'Passed', statusStage: 'passed', state: 'NJ' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', status: 'Introduced', statusStage: 'introduced', state: 'NJ' })
      await seedBill({ id: 'solo', billNumber: 'HB 1', status: 'Failed', statusStage: 'failed', state: 'NJ' })
      await group('a190', 'b1713')
      const f = await facets('status=Passed&match=any')
      expect(f.status.Introduced).toBe(1)
      expect(f.status.Failed).toBe(2)
      expect(await total('status=Passed&status=Introduced&match=any')).toBe(1)
    })
  })
})

// #528's subject coverage beside the facets, on a grouped instance. subjectStates
// and billStates say which states assign subjects and which have bills at all,
// so they count bills, not groups: a state is in them when any bill there
// qualifies, whichever bill stands for its group's row, and whatever filter is
// active. Suppression still hides a state's subjects under grouping.
describe('subject coverage beside the facets, under grouping', () => {
  beforeEach(reset)

  async function suppress(...states: string[]) {
    await db().insert(associationConfig).values({ key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(states) })
  }
  async function coverAllStates() {
    await db().insert(associationConfig).values({ key: 'state_coverage', value: JSON.stringify(['*']) })
  }

  it("lists a state's subjects through a grouped bill that doesn't stand for the group", async () => {
    // The group's key is a1, the bill with no subjects; its companion b2 carries them.
    await seedBill({ id: 'a1', billNumber: 'A1', state: 'TX' })
    await seedBill({ id: 'b2', billNumber: 'B2', state: 'NJ' })
    await seedBill({ id: 'c3', billNumber: 'C3', state: 'OH' })
    await group('a1', 'b2')
    await db().insert(billSubjects).values({ billId: 'b2', subjectName: 'Elections', state: 'NJ' })
    expect((await facets()).subjectStates).toEqual(['NJ'])
    // A filter that leaves the NJ bill out of the result doesn't drop NJ.
    expect((await facets('state=OH')).subjectStates).toEqual(['NJ'])
  })

  it('lists every state with bills on * coverage, counting each bill of a group', async () => {
    await coverAllStates()
    await seedBill({ id: 'a1', billNumber: 'A1', state: 'TX' })
    await seedBill({ id: 'b2', billNumber: 'B2', state: 'NJ' })
    await seedBill({ id: 'c3', billNumber: 'C3', state: 'OH' })
    await group('a1', 'b2')
    expect((await facets()).billStates).toEqual(['NJ', 'OH', 'TX'])
  })

  it('leaves billStates out on an explicit list of states, grouped or not', async () => {
    await db().insert(associationConfig).values({ key: 'state_coverage', value: JSON.stringify(['NJ', 'TX']) })
    await seedBill({ id: 'a1', billNumber: 'A1', state: 'TX' })
    await seedBill({ id: 'b2', billNumber: 'B2', state: 'NJ' })
    await group('a1', 'b2')
    expect('billStates' in await facets()).toBe(false)
  })

  it('still returns both when My Bills matches no group', async () => {
    await coverAllStates()
    await seedBill({ id: 'a1', billNumber: 'A1', state: 'TX' })
    await seedBill({ id: 'b2', billNumber: 'B2', state: 'NJ' })
    await group('a1', 'b2')
    await db().insert(billSubjects).values({ billId: 'b2', subjectName: 'Elections', state: 'NJ' })
    const f = await facets('myBills=1')
    expect(f.status).toEqual({})
    expect(f.subjectStates).toEqual(['NJ'])
    expect(f.billStates).toEqual(['NJ', 'TX'])
  })

  it("hides a suppressed state's subjects from a group whose other bill keeps its own", async () => {
    await coverAllStates()
    await seedBill({ id: 'a1', billNumber: 'A1', state: 'NJ' })
    await seedBill({ id: 'b2', billNumber: 'B2', state: 'UT' })
    await group('a1', 'b2')
    await db().insert(billSubjects).values([
      { billId: 'a1', subjectName: 'Local Government', state: 'NJ' },
      { billId: 'b2', subjectName: 'Elections', state: 'UT' },
    ])
    await suppress('NJ')
    const f = await facets()
    expect(f.subject).toEqual({ 'UT:Elections': 1 })
    expect(f.subjectStates).toEqual(['UT'])
    // Suppression hides subjects, not bills: NJ still has one.
    expect(f.billStates).toEqual(['NJ', 'UT'])
  })

  it('ignores a subject filter naming a suppressed state under grouping, rather than matching nothing', async () => {
    await seedBill({ id: 'a1', billNumber: 'A1', state: 'NJ' })
    await seedBill({ id: 'b2', billNumber: 'B2', state: 'UT' })
    await seedBill({ id: 'c3', billNumber: 'C3', state: 'OH' })
    await group('a1', 'b2')
    await db().insert(billSubjects).values({ billId: 'a1', subjectName: 'Local Government', state: 'NJ' })
    await suppress('NJ')
    const f = await facets('subject=NJ:Local%20Government')
    expect(f.state).toEqual((await facets()).state)
    expect(f.subjectStates).toEqual([])
    expect(await total('subject=NJ:Local%20Government')).toBe(2)
  })
})

// The session facet leaves out the session filter, not the year filter (#689): a facet counts what the list
// would total if you picked a value, so the filter the facet is for can't narrow it, and the others must.
describe('the session facet leaves out its own filter', () => {
  beforeEach(async () => {
    await reset()
    // Sessions 2025 and 2026, and a bill of session 2025 that began in 2026, so a year filter and a session
    // filter disagree about it.
    await seedBill({ id: 'a1', billNumber: 'A1', session: '2025', yearStart: 2025, status: 'Passed', statusStage: 'passed' })
    await seedBill({ id: 'b2', billNumber: 'B2', session: '2026', yearStart: 2026, status: 'Introduced', statusStage: 'introduced' })
    await seedBill({ id: 'c3', billNumber: 'C3', session: '2025', yearStart: 2026, status: 'Passed', statusStage: 'passed' })
    await seedBill({ id: 'd4', billNumber: 'D4', session: '2026', yearStart: 2026, status: 'Passed', statusStage: 'passed' })
  })

  it('counts every session when one is picked', async () => {
    const f = await facets('sessionName=2025')
    expect(f.sessionName).toEqual({ '2025': 2, '2026': 2 })
    expect(await total('sessionName=2025&sessionName=2026')).toBe(4)
  })

  it('counts the sessions of the bills a year filter keeps', async () => {
    const f = await facets('year=2026')
    expect(f.sessionName).toEqual({ '2025': 1, '2026': 2 })
    expect(await total('year=2026&sessionName=2025')).toBe(1)
    expect(await total('year=2026&sessionName=2026')).toBe(2)
  })

  it('counts the sessions of the bills every other filter keeps, with its own picked', async () => {
    const f = await facets('sessionName=2025&status=Passed')
    expect(f.sessionName).toEqual({ '2025': 2, '2026': 1 })
    const g = await facets('sessionName=2025&year=2026')
    expect(g.sessionName).toEqual({ '2025': 1, '2026': 2 })
  })

  it('leaves the year facet as it was, with a session or a year picked', async () => {
    expect((await facets('sessionName=2025')).year).toEqual({ '2025': 1, '2026': 1 })
    expect((await facets('sessionName=2025&year=2026')).year).toEqual({ '2025': 1, '2026': 1 })
    expect((await facets('year=2026')).year).toEqual({ '2025': 1, '2026': 3 })
  })

  it('leaves the session facet as it was under match=any, which counts the resulting total', async () => {
    // Under OR a facet counts each value's resulting total, with no bill fact left in the filter, so which filter
    // the facet leaves out cannot change it.
    const f = await facets('sessionName=2025&status=Passed&match=any')
    for (const [session, n] of Object.entries(f.sessionName)) {
      expect([session, n]).toEqual([session, await total(`sessionName=2025&sessionName=${session}&status=Passed&match=any`)])
    }
    expect(f.sessionName).toEqual({ '2025': 3, '2026': 4 })
  })
})

// The empty "my bills" response has every key the real one has (#693), with every count at zero: the response is
// built from the same table of filters either way, so a filter added to the table can't be missing from one.
describe('the facets of a my bills list with no bills', () => {
  beforeEach(async () => {
    await reset()
    await seedBill({ id: 'a1', billNumber: 'A1', priority: 'high', status: 'Passed', statusStage: 'passed', yearStart: 2026 })
    await seedBill({ id: 'b2', billNumber: 'B2', isDraft: true })
    await db().insert(officialPositions).values({ id: 'p1', billId: 'a1', position: 'Support', setBy: ada })
    await db().insert(billSubjects).values({ billId: 'a1', subjectName: 'Elections', state: 'RI' })
  })

  it('has the keys of the response for a member who has bills', async () => {
    await db().insert(notes).values({ id: 'n1', billId: 'a1', userId: ada, content: 'note' })
    const full = await facets('myBills=1')
    expect(full.myBillsCount).toBe(1)
    await db().delete(notes)
    const empty = await facets('myBills=1')
    expect(empty.myBillsCount).toBe(0)
    expect(Object.keys(empty).sort()).toEqual(Object.keys(full).sort())
    expect(Object.keys(empty.position).sort()).toEqual(['__any__', 'none'])
    expect(Object.keys(empty.tag)).toEqual(['__any__'])
  })

  it('has the keys of the response for the list of everyone', async () => {
    const everyone = await facets('')
    const empty = await facets('myBills=1')
    expect(Object.keys(empty).sort()).toEqual(Object.keys(everyone).sort())
  })

  it('counts nothing in priority, position, and tags, under the sentinels the full response always has', async () => {
    const f = await facets('myBills=1')
    expect(f.priority).toEqual({ none: 0, __any__: 0 })
    expect(f.position).toEqual({ none: 0, __any__: 0 })
    expect(f.tag).toEqual({ __any__: 0 })
  })

  it('counts nothing in the counts beside the facets, and no value in any other facet', async () => {
    const f = await facets('myBills=1')
    expect([f.myBillsCount, f.newMatchesCount, f.unvotedCount, f.draftCount]).toEqual([0, 0, 0, 0])
    expect(f.status).toEqual({})
    expect(f.stage).toEqual({})
    expect(f.year).toEqual({})
    expect(f.sessionName).toEqual({})
    expect(f.state).toEqual({})
    expect(f.subject).toEqual({})
    expect(f.field).toEqual({})
  })

  it('still carries the tenant-wide hasDrafts, subjectStates, and billStates', async () => {
    const empty = await facets('myBills=1')
    const everyone = await facets('')
    expect(empty.hasDrafts).toBe(true)
    expect(empty.subjectStates).toEqual(['RI'])
    expect(empty.subjectStates).toEqual(everyone.subjectStates)
    expect(empty.billStates).toEqual(everyone.billStates)
  })

  it('has the same shape whatever else the request filters by', async () => {
    const shape = (f: Record<string, unknown>) => JSON.stringify(Object.keys(f).sort())
    const base = shape(await facets('myBills=1'))
    for (const qs of ['myBills=1&status=Passed', 'myBills=1&match=any&priority=high', 'myBills=1&unvoted=1', 'myBills=1&search=nothing', 'myBills=1&tag=__any__']) {
      expect([qs, shape(await facets(qs))]).toEqual([qs, base])
    }
  })

  it('leaves the response of a member with bills unchanged', async () => {
    await db().insert(notes).values({ id: 'n1', billId: 'a1', userId: ada, content: 'note' })
    const f = await facets('myBills=1')
    expect(f.priority).toEqual({ high: 1, none: 0, __any__: 1 })
    expect(f.position).toEqual({ Support: 1, none: 0, __any__: 1 })
    expect(f.status).toEqual({ Passed: 1 })
  })
})
