import type { DemoSeed } from '../types'
import { LM_ORG } from './org'
import { LM_CUSTOM_FIELDS, LM_ROLES, LM_USER_ROLES, LM_USERS } from './roster'
import {
  LM_BILL_UPDATED_EVENTS,
  LM_CALENDAR_EVENTS,
  LM_CUSTOM_FIELD_VALUES,
  LM_ENGAGEMENT_EVENTS,
  LM_POSITIONS,
  LM_PRIORITIES,
} from './bills'

export const LAKE_MICHIGAN_SEED: DemoSeed = {
  slug: 'lake-michigan',
  ...LM_ORG,
  users: LM_USERS, roles: LM_ROLES, userRoles: LM_USER_ROLES, customFields: LM_CUSTOM_FIELDS,
  priorities: LM_PRIORITIES,
  positions: LM_POSITIONS,
  customFieldValues: LM_CUSTOM_FIELD_VALUES,
  calendarEvents: LM_CALENDAR_EVENTS,
  feedEvents: [...LM_BILL_UPDATED_EVENTS, ...LM_ENGAGEMENT_EVENTS],
  // Filled in by Tasks 4-6.
  votes: [], comments: [], reactions: [], mentions: [], notes: [],
}
