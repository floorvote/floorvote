// What a companion group's bills share, named the way the bill page names them:
// the comments, member votes, and org position cards, plus custom fields once
// the instance defines any.
import { DEFAULT_ORG_NOUN } from './orgNoun'

/**
 * "comments, votes, and team position", or "…, team position, and custom fields". `withPriority`
 * adds priority, which the group shares too, for the one place that lists everything (Group with…).
 */
export function groupSharedThings(noun: string, hasCustomFields: boolean, conjunction: 'and' | 'or' = 'and', withPriority = false): string {
  const items = ['comments', 'votes', `${noun || DEFAULT_ORG_NOUN} position`, ...(withPriority ? ['priority'] : []), ...(hasCustomFields ? ['custom fields'] : [])]
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`
}
