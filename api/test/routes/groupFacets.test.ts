import { describe, it, expect, beforeEach } from 'vitest'
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
      expect((await facets()).subjects).toEqual({ 'NJ:Elections': 1, 'NJ:Taxes': 1 })
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
      expect(f.tags.Labor).toBe(1)
      expect(f.tags.Energy ?? 0).toBe(0)
      expect(f.tags.__any__).toBe(1)
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
      expect(f.customFields.cf1.Labor).toBe(2)
      expect(f.customFields.cf1.Energy ?? 0).toBe(0)
      expect(f.customFields.cf1.__any__).toBe(2)
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
    expect(f.subjects).toEqual({ 'UT:Elections': 1 })
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
