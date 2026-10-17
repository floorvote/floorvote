import { teamValueText, type FieldChangeEvent } from '../../../shared/teamFields'

/** "A", "A and B", "A, B, and C" */
function listWithAnd(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

const asList = (v: string | string[] | null): string[] => Array.isArray(v) ? v : v ? [v] : []
const asText = (v: string | string[] | null): string => Array.isArray(v) ? v.join(', ') : (v ?? '')

/**
 * The sentence an activity line in a bill's comment thread reads for a team
 * field change: "David Park changed priority from Medium to High", "Ann set the
 * official position to Support", "FloorVote added the tags Energy and Labor".
 * `positionLabel` is what the page calls the position ("association position").
 */
export function fieldChangeText(event: FieldChangeEvent, { positionLabel = 'official position' }: { positionLabel?: string } = {}): string {
  const who = event.actorName ?? 'FloorVote'
  if (event.field === 'tags') {
    const before = asList(event.old)
    const after = asList(event.new)
    const tags = (verb: string, names: string[]) => names.length === 0 ? [] : [`${verb} the ${names.length === 1 ? 'tag' : 'tags'} ${listWithAnd(names)}`]
    const parts = [...tags('added', after.filter(t => !before.includes(t))), ...tags('removed', before.filter(t => !after.includes(t)))]
    return `${who} ${parts.join(' and ') || 'changed the tags'}`
  }
  const subject = event.field === 'priority' ? 'priority' : event.field === 'position' ? `the ${positionLabel}` : event.label
  const value = (raw: string | string[] | null): string => {
    const text = event.field === 'priority' || event.field === 'position' || event.field === 'customField'
      ? teamValueText(event.field, asText(raw), event.fieldType)
      : asText(raw)
    return event.field === 'customField' ? `"${text}"` : text
  }
  const had = asText(event.old) !== ''
  const has = asText(event.new) !== ''
  if (!has && !had) return `${who} changed ${subject}`
  if (!had) return `${who} set ${subject} to ${value(event.new)}`
  if (!has) return `${who} cleared ${subject} (was ${value(event.old)})`
  return `${who} changed ${subject} from ${value(event.old)} to ${value(event.new)}`
}

/** The closed line of a run of changes: "3 changes by David Park". */
export function foldText(actorName: string | null, count: number): string {
  return `${count} changes by ${actorName ?? 'FloorVote'}`
}
