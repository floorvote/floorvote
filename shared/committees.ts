/**
 * Procedural committees (#471): the ones that route or schedule bills rather than weigh what they say, such as
 * Rules, Assignments, Calendars, Reference, and the Committee of the Whole. One can hold half a session's bills, so
 * the Committee filter lists them after the others and tags them. Read from the committee's name, since no provider
 * classifies committees. A committee that reviews agency rules (Administrative Rules Review) is substantive.
 */
const PROCEDURAL = /\b(rules|assignments?|calendars?|reference|committee on committees|committee of the whole)\b/i
const SUBSTANTIVE = /\badministrative rules\b/i

export function isProceduralCommittee(name: string): boolean {
  return PROCEDURAL.test(name) && !SUBSTANTIVE.test(name)
}
