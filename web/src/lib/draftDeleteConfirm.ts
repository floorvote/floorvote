import { apiFetch } from './api'

/** What deleting a selection of draft bills would take: POST /bills/bulk-delete with `preview: true`. */
export type DraftDeletePreview = {
  /** Drafts in the selection, which a delete removes. */
  drafts: number
  /** Filed bills in the selection, which a delete leaves alone. */
  filed: number
  /** Drafts with votes, positions, live comments, or non-empty notes. */
  engagedDrafts: number
  /** The engagement on the drafts, all members' together. */
  engagement: { votes: number; comments: number; notes: number; positions: number }
}

/** Asks the server what deleting these drafts, or the drafts this filter selects, would take. Writes nothing. */
export function fetchDraftDeletePreview(selection: { ids: string[] } | { filter: string }): Promise<DraftDeletePreview> {
  return apiFetch<DraftDeletePreview>('/bills/bulk-delete', { method: 'POST', body: JSON.stringify({ ...selection, preview: true }) })
}

/** Whether a delete of this selection takes work on the drafts with it, so its confirm warns and the request says so. */
export function hasEngagement(preview: DraftDeletePreview): boolean {
  return preview.engagedDrafts > 0
}

const n = (count: number) => count.toLocaleString()
const counted = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`

/** "a", "a and b", or "a, b, and c". */
function joinAnd(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** The engagement there is, in the order votes, comments, notes, positions: "3 votes, 2 comments, and 1 note". */
function workList(e: DraftDeletePreview['engagement']): string {
  const kinds: Array<[number, string, string]> = [
    [e.votes, 'vote', 'votes'], [e.comments, 'comment', 'comments'], [e.notes, 'note', 'notes'], [e.positions, 'position', 'positions'],
  ]
  return joinAnd(kinds.filter(([count]) => count > 0).map(([count, one, many]) => counted(count, one, many)))
}

const UNDONE = "This can't be undone."

/** The confirm for deleting one draft: the bill page's overflow menu, and Discard draft when it has engagement. */
export function singleDraftDeleteConfirm(preview: DraftDeletePreview): string {
  if (!hasEngagement(preview)) return `Delete this draft bill? ${UNDONE}`
  const e = preview.engagement
  const pieces = e.votes + e.comments + e.notes + e.positions
  return `Delete this draft bill? Your team's ${workList(e)} on it will be deleted too. `
    + `To keep ${pieces === 1 ? 'it' : 'them'}, link the draft to its filed bill instead. ${UNDONE}`
}

/** The confirm for the bulk bar's Delete drafts, which also names the filed bills a mixed selection leaves alone. */
export function bulkDraftDeleteConfirm(preview: DraftDeletePreview): string {
  const filedNote = preview.filed > 0
    ? ` The ${counted(preview.filed, 'filed bill', 'filed bills')} in your selection ${preview.filed === 1 ? 'is' : 'are'} not deleted.`
    : ''
  if (preview.drafts === 1) return singleDraftDeleteConfirm(preview) + filedNote
  const head = `Delete ${counted(preview.drafts, 'draft bill', 'draft bills')}?`
  if (!hasEngagement(preview)) return `${head} ${UNDONE}${filedNote}`
  const one = preview.engagedDrafts === 1
  return `${head} ${n(preview.engagedDrafts)} of them ${one ? 'has' : 'have'} your team's work on ${one ? 'it' : 'them'}: `
    + `${workList(preview.engagement)}, which will be deleted too. `
    + `To keep it, link ${one ? 'that draft to its filed bill' : 'those drafts to their filed bills'} instead. ${UNDONE}${filedNote}`
}
