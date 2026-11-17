import { useEffect, useState } from 'react'

/**
 * Deep links from the email footers (#setting-email-digest and the like) scroll
 * the matching setting into view and flash it for about a second and a half,
 * the same pattern the bill page uses for #section-… and #comment-… anchors.
 * Returns the id being flashed, or null.
 */
export function useSettingFlash(hash: string, ids: readonly string[]): string | null {
  const [flashed, setFlashed] = useState<string | null>(null)
  useEffect(() => {
    const id = hash.slice(1)
    if (!ids.includes(id)) return
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashed(id)
    const t = setTimeout(() => setFlashed(null), 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ids` is a constant list
  }, [hash])
  return flashed
}
