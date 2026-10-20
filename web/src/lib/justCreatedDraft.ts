// Router state that marks a draft bill's page as reached straight from creating
// it (the bills page's "Add draft bill" button). It lives in `location.state`, so
// it is gone after a reload, a bookmark, or any ordinary visit to the page: the
// page that reads it (the bill page's Discard draft button) shows only on
// arrival.
//
// One module owns the key, the shape, the writer, and the reader, so the button
// that navigates and the page that reads cannot drift apart.

export const JUST_CREATED_DRAFT_KEY = 'justCreatedDraft'

export type JustCreatedDraftState = { [JUST_CREATED_DRAFT_KEY]: true }

/** The state to pass to `navigate('/bills/<id>', { state })` right after creating a draft. */
export function justCreatedDraftState(): JustCreatedDraftState {
  return { [JUST_CREATED_DRAFT_KEY]: true }
}

/** True only for the state `justCreatedDraftState()` produces; pass `useLocation().state`. */
export function isJustCreatedDraft(state: unknown): state is JustCreatedDraftState {
  return typeof state === 'object' && state !== null
    && (state as Record<string, unknown>)[JUST_CREATED_DRAFT_KEY] === true
}
