import type { DemoSeed } from '../types'
import { LM_ORG } from './org'
import { LM_CUSTOM_FIELDS, LM_ROLES, LM_USER_ROLES, LM_USERS } from './roster'

export const LAKE_MICHIGAN_SEED: DemoSeed = {
  slug: 'lake-michigan',
  ...LM_ORG,
  users: LM_USERS, roles: LM_ROLES, userRoles: LM_USER_ROLES, customFields: LM_CUSTOM_FIELDS,
  // Filled in by Tasks 3-6.
  priorities: [], positions: [], votes: [], comments: [], reactions: [],
  mentions: [], feedEvents: [], customFieldValues: [], notes: [], calendarEvents: [],
}
