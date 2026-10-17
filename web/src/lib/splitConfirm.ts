import { groupSharedThings } from './groupShares'

/**
 * The confirmation before "Split from group" (#382): what the split leaves,
 * from `GET /bills/:id/split-preview`'s parts (the groups the rest of the
 * group would fall into, by bill number), and what comes back to each bill.
 * It claims back only what does: a member's merged note and a value cleared
 * while the bills were grouped stay as they are.
 */
export function splitConfirmText(billNumber: string, parts: readonly (readonly string[])[], noun: string, hasCustomFields = false): string {
  const after = `Each bill's own ${groupSharedThings(noun, hasCustomFields)} show on its page again. Notes a member already merged, and values cleared while the bills were grouped, stay as they are.`
  return `Split ${billNumber} from its group? ${leftBehind(parts, noun, hasCustomFields)} ${after}`
}

function leftBehind(parts: readonly (readonly string[])[], noun: string, hasCustomFields: boolean): string {
  if (parts.length === 1) {
    return parts[0].length === 1
      ? `It will no longer share ${groupSharedThings(noun, hasCustomFields, 'or')} with ${parts[0][0]}.`
      : `${listBills(parts[0])} stay grouped with each other.`
  }
  if (parts.every(p => p.length === 1)) {
    return `${listBills(parts.map(p => p[0]))} will no longer be grouped with each other either, since nothing else links them.`
  }
  const each = parts.map(p => (p.length === 1 ? `${p[0]} will stand alone` : `${listBills(p)} stay grouped`))
  return `The rest will come apart, since nothing else links them: ${listClauses(each)}.`
}

// "A1", "A1 and A2", "A1, A2, and A3"
function listBills(numbers: readonly string[]): string {
  if (numbers.length <= 2) return numbers.join(' and ')
  return `${numbers.slice(0, -1).join(', ')}, and ${numbers[numbers.length - 1]}`
}

// Clauses joined the same way, each already a sentence part.
function listClauses(clauses: readonly string[]): string {
  if (clauses.length <= 2) return clauses.join(', and ')
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`
}

/**
 * The confirmation before "Group with…" when grouping would undo splits, from
 * `GET /bills/:id/group-preview`'s `undoneSplits` (each split pair by bill
 * number). Grouping a bill again with one it was split from undoes that split,
 * and takes back every other split between the two groups as well, so the
 * text names them all and says why there can be more than the one.
 */
export function undoSplitsConfirmText(billNumber: string, withNumber: string, splits: readonly (readonly { billNumber: string }[])[]): string {
  const named = splits.map(([a, b]) => `${a.billNumber} and ${b.billNumber}`)
  const ask = `Group ${billNumber} with ${withNumber}?`
  if (splits.length === 1) return `${ask} This undoes the split of ${named[0]}.`
  return `${ask} This undoes ${splits.length} splits: ${listClauses(named)}. Grouping takes back every split between the two bills' groups, not only the one between ${billNumber} and ${withNumber}.`
}
