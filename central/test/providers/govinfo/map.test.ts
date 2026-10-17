import { describe, it, expect } from 'vitest'
import { billInventory } from '../../../src/providers/govinfo/inventory'
import { vocabulary } from '../../../src/providers/govinfo/vocabulary'
import { parseXml } from '../../../src/providers/govinfo/xml'
import { inventoryProblems, unfedExtras } from '../../helpers/fieldInventory'
import { xmlObject } from '../../helpers/xmlObject'
import { fixtureFiles } from '../../helpers/govinfoZip'

// Real Bill Status files recorded from https://www.govinfo.gov/bulkdata/BILLSTATUS/119/
const fixtures = new Map([...fixtureFiles].map(([name, xml]) => [name, xmlObject(parseXml(xml).root)]))

describe('the GovInfo field inventory', () => {
  it('lists every field of the recorded Bill Status files', () => {
    // Each recorded file reads into a bill and a Dublin Core block, so this isn't checking nothing.
    for (const [name, file] of fixtures) expect(Object.keys(file as object), name).toEqual(expect.arrayContaining(['version', 'bill', 'dublinCore']))
    expect(inventoryProblems(billInventory, [...fixtures.values()], vocabulary)).toEqual([])
  })

  it('fails when GovInfo sends a field nobody has decided about', () => {
    const bill = structuredClone(fixtures.get('BILLSTATUS-119hr3132.xml')) as any
    bill.bill.newThing = 'x'
    bill.bill.actions.item[0].extraThing = 'y'
    expect(inventoryProblems(billInventory, [bill], vocabulary)).toEqual([
      'not in the inventory: bill.actions.item[].extraThing',
      'not in the inventory: bill.newThing',
    ])
  })

  it('feeds every extra the vocabulary declares', () => {
    expect(Object.keys(vocabulary.extras ?? {}).sort()).toEqual(['costEstimate', 'policyArea', 'publicLaw', 'summary'])
    expect(unfedExtras(vocabulary, billInventory)).toEqual([])
  })

  it('covers the fields the full set of 19,690 119th Congress files carries, not just the recorded ones', () => {
    // Paths seen in every file of the 119th Congress's eight zips on October 16, 2026 that the recorded files lack.
    const seenElsewhere = [
      'bill.onBehalfOfSponsor[].bioguideId',
      'bill.notes[].text',
      'bill.notes[].links.link[].name',
      'bill.laws[].number',
      'bill.laws[].type',
      'bill.cboCostEstimates[].url',
      'bill.committeeReports.committeeReport[].citation',
      'bill.amendments.amendment[].amendedBill.title',
      'bill.actions.item[].calendarNumber.calendar',
      'bill.actions.item[].recordedVotes.recordedVote[].rollNumber',
      'bill.cosponsors[].sponsorshipWithdrawnDate',
      'bill.relatedBills[].relationshipDetails[].identifiedBy',
      'bill.titles[].sourceSystem.name',
    ]
    const missing = seenElsewhere.filter(path => inventoryProblems(billInventory, [pathObject(path)]).length > 0)
    expect(missing).toEqual([])
  })
})

/** An object with one field at this path, for checking a path against an inventory. */
function pathObject(path: string): unknown {
  const parts = path.split('.')
  const build = (i: number): unknown => {
    if (i === parts.length) return 'x'
    const part = parts[i]
    if (part.endsWith('[]')) return { [part.slice(0, -2)]: [build(i + 1)] }
    return { [part]: build(i + 1) }
  }
  return build(0)
}
