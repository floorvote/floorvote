import { describe, it, expect } from 'vitest'
import { billInventory } from '../../../src/providers/govinfo/inventory'
import { vocabulary } from '../../../src/providers/govinfo/vocabulary'
import { parseXml } from '../../../src/providers/govinfo/xml'
import { inventoryProblems, unfedExtras } from '../../helpers/fieldInventory'
import { xmlObject } from '../../helpers/xmlObject'
import { parseBillFile } from '../../../src/providers/govinfo/map'
import { fixtureFiles } from '../../helpers/govinfoZip'
import fieldPathsRaw from '../../fixtures/govinfo/field-paths.json?raw'

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
