import { describe, it, expect } from 'vitest'
import sessionRaw from '../../fixtures/example/session-2026.json?raw'
import { inventoryProblems, unfedExtras } from '../../helpers/fieldInventory'
import { example, type ExampleRecord } from '.'
import { inventory } from './inventory'
import { vocabulary } from './vocabulary'

// The mapping test every provider keeps, in miniature: the recorded fixtures
// against the field inventory, and the mapping against the vocabulary.
const records = JSON.parse(sessionRaw) as ExampleRecord[]

describe('the example feed', () => {
  it('lists every field of its recorded fixtures in its inventory', () => {
    expect(inventoryProblems(inventory, records, vocabulary)).toEqual([])
  })

  it('fails the check when the feed sends a field nobody has decided about', () => {
    const changed = structuredClone(records) as unknown as Record<string, unknown>[]
    changed[0].Ward = '3'
    changed[1].Sponsor = { Name: 'A. Member', Party: null }
    // Inside an ignored array, new fields are covered.
    ;(changed[0].Attachments as Record<string, unknown>[])[0].Checksum = 'abc'
    expect(inventoryProblems(inventory, changed, vocabulary)).toEqual([
      'not in the inventory: Sponsor.Name',
      'not in the inventory: Sponsor.Party',
      'not in the inventory: Ward',
    ])
  })

  it('feeds every extra its vocabulary declares from some field', () => {
    expect(unfedExtras(vocabulary, inventory)).toEqual([])
    const { Packet: _dropped, ...withoutPacket } = inventory
    expect(unfedExtras(vocabulary, withoutPacket)).toEqual(['packet'])
  })

  it('fails the check when the inventory names an extra the vocabulary lacks', () => {
    expect(inventoryProblems({ ...inventory, LawNumber: { extra: 'lawNo' } }, records, vocabulary))
      .toEqual(['LawNumber is the extra "lawNo", which the vocabulary doesn\'t declare'])
  })

  it('maps its extras under keys the vocabulary declares', async () => {
    const r = records[0]
    const measure = await example.fetchMeasure({
      billId: 1, sessionId: 2, record: { raw: r, hash: 'h' },
    }, {} as never)
    if ('measure' in measure) throw new Error('the example provider has no details response')
    expect(Object.keys(measure.extras ?? {}).every(k => k in vocabulary.extras!)).toBe(true)
    expect(measure.extras).toMatchObject({ lawNumber: 'L26-0042', effectiveDate: '2026-06-01' })
  })
})
