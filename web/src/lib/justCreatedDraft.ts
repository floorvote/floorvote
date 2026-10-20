// Marks a draft bill as just created from the bills page's "Add draft bill"
// button, so the draft's page can offer a one-click Discard draft on arrival and
// at no other time.
//
// The marker is a sessionStorage entry keyed by the draft's id, not router state.
// Router state cannot do this job: the draft's page loader redirects
// /bills/<id> to the canonical /STATE/YEAR/NUMBER URL, and the router replaces
// location.state on a redirect, so the state never reaches the page; and when it
// does reach a page, the browser keeps it in history.state across a reload and
// back/forward. The page reads the marker once on arrival and then clears it
// (`peek` while rendering, `clear` in an effect), so a reload, back/forward, or
// a link finds nothing.
//
// One module owns the key, the writer, and the readers, so the button that marks
// and the page that reads cannot drift apart. Every storage access is guarded
// (private mode and blocked storage throw): a failure means "not just created",
// never an error.

const KEY_PREFIX = 'floorvote:justCreatedDraft:'

export function justCreatedDraftStorageKey(id: string): string {
  return KEY_PREFIX + id
}

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Call right after creating a draft, before navigating to its page. */
export function markJustCreatedDraft(id: string): void {
  try {
    storage()?.setItem(justCreatedDraftStorageKey(id), '1')
  } catch {
    // Without storage the draft just opens without the Discard draft button.
  }
}

/** True while the draft is marked. Reads only, so a render can call it. */
export function peekJustCreatedDraft(id: string): boolean {
  try {
    return storage()?.getItem(justCreatedDraftStorageKey(id)) === '1'
  } catch {
    return false
  }
}

/** Removes the marker. Safe to call when there is none, and more than once. */
export function clearJustCreatedDraft(id: string): void {
  try {
    storage()?.removeItem(justCreatedDraftStorageKey(id))
  } catch {
    // Nothing to clear without storage.
  }
}

/** True once for a marked draft, then false: reads and clears the marker. */
export function takeJustCreatedDraft(id: string): boolean {
  const marked = peekJustCreatedDraft(id)
  clearJustCreatedDraft(id)
  return marked
}
