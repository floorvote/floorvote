import { MAX_SUBJECT_FILTERS } from '../../../shared/limits'

// The API answers 400 past MAX_SUBJECT_FILTERS subjects, so the pickers stop
// offering more at the cap. The count is of selected subjects across every state.
export function isSubjectCapReached(selectedCount: number): boolean {
  return selectedCount >= MAX_SUBJECT_FILTERS
}

// Why the unchecked options are disabled. A saved view or link can already hold
// more than the cap, and then the member needs to know how many to take off.
export function subjectCapHint(selectedCount: number): string {
  const hint = `You can pick up to ${MAX_SUBJECT_FILTERS} subjects.`
  const over = selectedCount - MAX_SUBJECT_FILTERS
  return over > 0 ? `${hint} This filter has ${selectedCount}. Remove ${over} to continue.` : hint
}
