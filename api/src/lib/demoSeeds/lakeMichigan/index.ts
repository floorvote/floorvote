import type { DemoSeed } from '../types'
import { LM_ORG } from './org'

export const LAKE_MICHIGAN_SEED: DemoSeed = {
  slug: 'lake-michigan',
  ...LM_ORG,
  // Filled in by Tasks 2-6.
  users: [], roles: [], userRoles: [], customFields: [],
  priorities: [], positions: [], votes: [], comments: [], reactions: [],
  mentions: [], feedEvents: [], customFieldValues: [], notes: [], calendarEvents: [],
}
