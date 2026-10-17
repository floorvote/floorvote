import { describe, it, expect } from 'vitest'
import { billInventory, houseRollCallInventory, senateRollCallInventory } from '../../../src/providers/govinfo/inventory'
import { vocabulary } from '../../../src/providers/govinfo/vocabulary'
import { parseXml } from '../../../src/providers/govinfo/xml'
import { inventoryProblems, unfedExtras } from '../../helpers/fieldInventory'
import { xmlObject } from '../../helpers/xmlObject'
import { parseBillFile } from '../../../src/providers/govinfo/map'
import { fixtureFiles } from '../../helpers/govinfoZip'
import fieldPathsRaw from '../../fixtures/govinfo/field-paths.json?raw'
import rollCallPathsRaw from '../../fixtures/govinfo/rollcalls/field-paths.json?raw'
import { rollCallFiles } from '../../helpers/govinfoRollCalls'

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

  it('covers every field in all 19,690 files of the 119th Congress, not just the recorded ones', () => {
    // The path of every field (an element with no children) in the eight zips on October 16, 2026,
    // in the form `fieldPaths` gives them. Checked by building an object with each one.
    const paths = JSON.parse(fieldPathsRaw) as string[]
    expect(paths.length).toBeGreaterThan(150)
    const missing = paths.filter(path => inventoryProblems(billInventory, [pathObject(path)]).length > 0)
    expect(missing).toEqual([])
  })
})

describe('the roll call field inventories', () => {
  const objects = (prefix: string) => [...rollCallFiles].filter(([name]) => name.startsWith(prefix)).map(([, xml]) => xmlObject(parseXml(xml).root))
  const paths = JSON.parse(rollCallPathsRaw) as { house: string[]; senate: string[] }

  it('lists every field of the recorded House Clerk and Senate files', () => {
    expect(objects('house-').length).toBeGreaterThanOrEqual(10)
    expect(objects('senate-').length).toBeGreaterThanOrEqual(4)
    expect(inventoryProblems(houseRollCallInventory, objects('house-'))).toEqual([])
    expect(inventoryProblems(senateRollCallInventory, objects('senate-'))).toEqual([])
  })

  it('fails when the House or the Senate sends a field nobody has decided about', () => {
    const house = structuredClone(objects('house-')[0]) as any
    house['vote-metadata'].newThing = 'x'
    house['vote-data']['recorded-vote'][0].extraThing = 'y'
    expect(inventoryProblems(houseRollCallInventory, [house])).toEqual([
      'not in the inventory: vote-data.recorded-vote[].extraThing',
      'not in the inventory: vote-metadata.newThing',
    ])
    const senate = structuredClone(objects('senate-')[0]) as any
    senate.members.member[0].extraThing = 'y'
    senate.newThing = 'x'
    expect(inventoryProblems(senateRollCallInventory, [senate])).toEqual([
      'not in the inventory: members.member[].extraThing',
      'not in the inventory: newThing',
    ])
  })

  it('covers every field in all 1,117 roll call files the 119th Congress\'s bill files link, not just the recorded ones', () => {
    // The path of every field in the 669 House Clerk and 448 Senate files (the ones the zips of October 16, 2026 link), read on October 17, 2026.
    expect(paths.house.length).toBeGreaterThan(25)
    expect(paths.senate.length).toBeGreaterThan(30)
    expect(paths.house.filter(p => inventoryProblems(houseRollCallInventory, [pathObject(p)]).length > 0)).toEqual([])
    expect(paths.senate.filter(p => inventoryProblems(senateRollCallInventory, [pathObject(p)]).length > 0)).toEqual([])
  })

  it('leaves no field of a recorded file unused: each entry is a field some file sends', () => {
    const all = new Set([...paths.house, ...paths.senate])
    const listed = [...Object.keys(houseRollCallInventory), ...Object.keys(senateRollCallInventory)]
    expect(listed.length).toBeGreaterThan(40)
    expect(listed.filter(k => ![...all].some(p => p === k || p.startsWith(`${k}.`)))).toEqual([])
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

describe('the congress.gov address of a bill', () => {
  // congress.gov writes the Congress with its ordinal: 111th, 121st, 122nd, 123rd.
  it.each([
    [111, '111th'], [112, '112th'], [113, '113th'], [119, '119th'], [120, '120th'],
    [121, '121st'], [122, '122nd'], [123, '123rd'], [124, '124th'], [131, '131st'],
  ])('is %i\'s %s-congress', async (congress, ordinal) => {
    const xml = fixtureFiles.get('BILLSTATUS-119hr3132.xml')!.replace('<congress>119</congress>', `<congress>${congress}</congress>`)
    const { record } = await parseBillFile('BILLSTATUS.xml', xml, { congress, type: 'HR' }, null)
    expect(record.url).toBe(`https://www.congress.gov/bill/${ordinal}-congress/house-bill/3132`)
  })
})
