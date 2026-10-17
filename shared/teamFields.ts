/**
 * Team fields: the values a team keeps per bill, which a companion group
 * shares (see **Team field** in CONTEXT.md). The shapes the instance API
 * stores for them in `team_events`, shared with the web app.
 */
import { parseStoredMulti } from './customFieldValues'
import { truncateWithEllipsis } from './feedUtils'

/** A team field whose changes are recorded. A custom field is named by its id as well. */
export type TeamField = 'position' | 'priority' | 'customField' | 'tags'

/** The `team_events.type` of a change to a team field. */
export const FIELD_CHANGED = 'field_changed'

/**
 * `team_events.metadata` for a change to a team field, on the bill where it
 * was set. `old` is the value the bill's group read before the change, and
 * `new` what it reads after, both as stored: a custom field's raw value (a
 * multi-select's JSON array string), tags as a list, null for none. `label`
 * names the field when it was set ("position", a custom field's name).
 */
export type FieldChangedMetadata = {
  field: TeamField
  fieldId?: string
  label: string
  old: string | string[] | null
  new: string | string[] | null
}

/**
 * A change to a team field as the bill page reads it, for the activity lines of
 * its comment thread. The bill page serves one for each `field_changed` team
 * event on a bill in the page's companion group, oldest first. `actorName` is
 * null when FloorVote made the change (an analysis's tags). `billId` and
 * `billNumber` name the bill where the value was set. `fieldType` is a custom
 * field's type, which a sentence needs to word a yes/no value.
 */
export type FieldChangeEvent = {
  id: string
  createdAt: string
  actorId: string | null
  actorName: string | null
  billId: string
  billNumber: string
  field: TeamField
  fieldId?: string
  label: string
  old: string | string[] | null
  new: string | string[] | null
  fieldType?: string
}

// A long text custom field is cut short in a sentence about it.
const MAX_VALUE_TEXT = 60

/**
 * A team field's stored value as a sentence shows it: "High" for a priority,
 * "Energy, Labor" for a multi-select, "Yes" for a checked yes/no field.
 */
export function teamValueText(field: Exclude<TeamField, 'tags'>, raw: string, customFieldType?: string): string {
  if (field === 'priority') return raw.charAt(0).toUpperCase() + raw.slice(1)
  if (field === 'customField') {
    if (customFieldType === 'binary') return raw === '1' ? 'Yes' : raw
    return truncateWithEllipsis(parseStoredMulti(raw).join(', '), MAX_VALUE_TEXT)
  }
  return raw
}
