import { teamValueText, type FieldChangeEvent } from '../../../shared/teamFields'

const asText = (v: string | null): string => v ?? ''

/**
 * The sentence an activity line in a bill's comment thread reads for a team
 * field change a person made: "David Park changed priority from Medium to High",
 * "Ann set the official position to Support". `positionLabel` is what the page
 * calls the position ("association position").
 */
export function fieldChangeText(event: FieldChangeEvent, { positionLabel = 'official position' }: { positionLabel?: string } = {}): string {
  const who = event.actorName
  const subject = event.field === 'priority' ? 'priority' : event.field === 'position' ? `the ${positionLabel}` : event.label
  const value = (raw: string | null): string => {
    const text = teamValueText(event.field, asText(raw), event.fieldType)
    return event.field === 'customField' ? `"${text}"` : text
  }
  const had = asText(event.old) !== ''
  const has = asText(event.new) !== ''
  if (!has && !had) return `${who} changed ${subject}`
  if (!had) return `${who} set ${subject} to ${value(event.new)}`
  if (!has) return `${who} cleared ${subject} (was ${value(event.old)})`
  return `${who} changed ${subject} from ${value(event.old)} to ${value(event.new)}`
}
