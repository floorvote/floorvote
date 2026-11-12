import { useState } from 'react'

/**
 * Whether a control whose options load on demand shows its Loading row: while `loading` when it opens, until the
 * options land. Once they have landed while it is open, a later load (a pick in it changed the filter, so its counts
 * are asked for again) keeps the list on screen until the new counts replace it, so the list a person is working in
 * never collapses under them. Closing it forgets that, so it opens on Loading again if its counts are still out.
 * A load that `failed` landed nothing, so a load after it shows Loading, open or not: there is no list to keep.
 */
export function useLoadingOnOpen(open: boolean, loading: boolean, failed = false): boolean {
  const [landedWhileOpen, setLandedWhileOpen] = useState(false)
  // Adjusting state while rendering, React's pattern for state derived from a change in props.
  if (!open && landedWhileOpen) setLandedWhileOpen(false)
  if (open && !loading && !failed && !landedWhileOpen) setLandedWhileOpen(true)
  return loading && !(open && landedWhileOpen)
}
