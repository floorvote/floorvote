import { useCallback, useState } from 'react'
import type { useSearchParams } from 'react-router-dom'
import type { SortColumn, SortDir } from '../pages/BillList/types'

type SearchParams = ReturnType<typeof useSearchParams>[0]

export function useBillSort(searchParams: SearchParams) {
  const [sortCol, setSortCol] = useState<SortColumn>(() => {
    const s = searchParams.get('sort')
    return (s && ['priority', 'status', 'relevance', 'position', 'year', 'session', 'lastAction', 'bill'].includes(s)) ? s as SortColumn : 'default'
  })
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    const d = searchParams.get('dir')
    return d === 'asc' || d === 'desc' ? d : 'asc'
  })

  const handleSort = useCallback((col: SortColumn) => {
    if (col === sortCol) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      // Bill sort defaults to ascending (HB 1 before HB 999); other columns default to desc.
      setSortDir(col === 'bill' ? 'asc' : 'desc')
    }
  }, [sortCol])

  const handleReset = useCallback(() => {
    setSortCol('default')
    setSortDir('asc')
  }, [])

  return { sortCol, sortDir, setSortCol, setSortDir, handleSort, handleReset }
}
