import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { Bill, Selection } from '../pages/BillList/types'

export function useBulkActions(opts: {
  sortedRef: MutableRefObject<Bill[]>
  resetDeps: unknown[]
}) {
  const { sortedRef, resetDeps } = opts
  const [selection, setSelection] = useState<Selection>({ mode: 'none' })
  const isSelectionMode = selection.mode !== 'none'
  const lastCheckedIndexRef = useRef<number | null>(null)

  const handleToggleSelect = useCallback((billId: string, index: number, shiftKey: boolean) => {
    if (shiftKey && lastCheckedIndexRef.current !== null) {
      const lo = Math.min(lastCheckedIndexRef.current, index)
      const hi = Math.max(lastCheckedIndexRef.current, index)
      const rangeIds = sortedRef.current.slice(lo, hi + 1).map(b => b.id)
      setSelection(prev => {
        if (prev.mode === 'filter') {
          // Deselect range from filter mode: switch to ids with all loaded except the range
          const ids = new Set(sortedRef.current.map(b => b.id))
          for (const id of rangeIds) ids.delete(id)
          return ids.size > 0 ? { mode: 'ids', ids } : { mode: 'none' }
        }
        const ids = prev.mode === 'ids' ? new Set(prev.ids) : new Set<string>()
        for (const id of rangeIds) ids.add(id)
        return { mode: 'ids', ids }
      })
    } else {
      setSelection(prev => {
        if (prev.mode === 'filter') {
          // Deselect one from filter mode: switch to ids with all loaded except this bill
          const ids = new Set(sortedRef.current.map(b => b.id))
          ids.delete(billId)
          return ids.size > 0 ? { mode: 'ids', ids } : { mode: 'none' }
        }
        const ids = prev.mode === 'ids' ? new Set(prev.ids) : new Set<string>()
        if (ids.has(billId)) {
          ids.delete(billId)
          return ids.size > 0 ? { mode: 'ids', ids } : { mode: 'none' }
        }
        ids.add(billId)
        return { mode: 'ids', ids }
      })
    }
    lastCheckedIndexRef.current = index
  }, [sortedRef])

  const handleSelectAllFilters = useCallback(() => {
    setSelection({ mode: 'filter' })
  }, [])

  const handleClearSelection = useCallback(() => {
    setSelection({ mode: 'none' })
  }, [])

  useEffect(() => {
    setSelection({ mode: 'none' })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps)

  return { selection, isSelectionMode, handleToggleSelect, handleSelectAllFilters, handleClearSelection }
}
