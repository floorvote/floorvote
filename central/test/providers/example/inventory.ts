import type { FieldInventory } from '../../../src/providers/sdk'

/** Every field of the example feed's session records (fixtures/example/). */
export const inventory: FieldInventory = {
  Number: 'mapped',
  Title: 'mapped',
  Status: 'mapped',
  Introduced: 'mapped',
  Page: 'mapped',
  LawNumber: { extra: 'lawNumber' },
  EffectiveDate: { extra: 'effectiveDate' },
  Packet: { extra: 'packet' },
  WithdrawnBy: { extra: 'withdrawnBy' },
  InternalId: { ignored: 'The feed\'s database key. Number already identifies the measure, and nothing links by this.' },
  Attachments: { ignored: 'Staff files with no type or date to show them by.' },
  'Meetings[].Id': 'mapped',
  'Meetings[].Date': 'mapped',
  'Meetings[].Title': 'mapped',
  'Meetings[].Removed': 'mapped',
}
