import { useEffect } from 'react'
import { PRODUCT_NAME } from '../../../shared/brand'

export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    const prev = document.title
    if (title) document.title = `${title} | ${PRODUCT_NAME}`
    return () => { document.title = prev }
  }, [title])
}
