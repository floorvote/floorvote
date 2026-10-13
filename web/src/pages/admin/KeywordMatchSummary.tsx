import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { HELPER_TEXT } from '../../lib/textStyles'
import { color } from '../../styles/tokens'

type Summary = { total: number; matched: number; newlyMatched: number; unmatched: number }

// How long typing must pause before the count is refreshed. Counting reads
// every bill the instance tracks, so it should not run on each keystroke.
const DEBOUNCE_MS = 500

/** The keywords a textarea holds: one per line, trimmed, blank lines dropped. */
function keywordList(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

/** Matching ignores case, so two boxes that differ only by case match the same bills. */
function sameKeywords(a: string, b: string): boolean {
  return keywordList(a).join('\n').toLowerCase() === keywordList(b).join('\n').toLowerCase()
}

function isSummary(value: unknown): value is Summary {
  const s = value as Summary | null
  return !!s && [s.total, s.matched, s.newlyMatched, s.unmatched].every(n => typeof n === 'number')
}

/**
 * A whole-number percentage that never rounds into a claim it is not: a share
 * above zero reads "<1%" rather than "0%", and one below all reads ">99%".
 */
function percentOf(matched: number, total: number): string {
  if (total === 0 || matched === 0) return '0%'
  if (matched === total) return '100%'
  const rounded = Math.round((matched / total) * 100)
  if (rounded === 0) return '<1%'
  if (rounded === 100) return '>99%'
  return `${rounded}%`
}

const count = (n: number) => n.toLocaleString('en-US')
const bills = (n: number) => `${count(n)} ${n === 1 ? 'bill' : 'bills'}`

/**
 * A live count of how many of the instance's bills the keywords in the box
 * match, analyzed or not, and, once the box differs from what is saved, how
 * saving would change that. Reads only: nothing is saved and no sync starts.
 *
 * `keywords` is the textarea's text and `savedKeywords` the text as last
 * loaded or saved. The count lags typing by the debounce and keeps showing the
 * previous answer while the next loads. A failed count clears it and renders
 * nothing, rather than leave a number that no longer matches the box. The
 * summary is a convenience, and the save confirmation still reports what
 * saving will do.
 */
export function KeywordMatchSummary({ keywords, savedKeywords }: { keywords: string; savedKeywords: string }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const hasCounted = useRef(false)
  // Keyed on the cleaned list, so typing a trailing space or a blank line does not recount.
  const list = keywordList(keywords)
  const listKey = JSON.stringify(list)

  useEffect(() => {
    let cancelled = false
    // The first count has no typing to wait out.
    const timer = setTimeout(() => {
      hasCounted.current = true
      apiFetch<Summary>('/admin/keyword-match-summary', {
        method: 'POST',
        body: JSON.stringify({ keywords: JSON.parse(listKey) }),
      })
        .then(result => { if (!cancelled) setSummary(isSummary(result) ? result : null) })
        .catch(() => { if (!cancelled) setSummary(null) })
    }, hasCounted.current ? DEBOUNCE_MS : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [listKey])

  if (!summary) return null

  const { total, matched, newlyMatched, unmatched } = summary
  const changes = [
    newlyMatched > 0 ? <>newly match <strong>{bills(newlyMatched)}</strong></> : null,
    unmatched > 0 ? <>unmatch <strong>{bills(unmatched)}</strong></> : null,
  ].filter(Boolean)

  return (
    <div role="status" style={{ ...HELPER_TEXT, color: color.textSlate, marginTop: 8 }}>
      <p style={{ margin: 0 }}>
        This keyword set matches <strong>{count(matched)} of {bills(total)} ({percentOf(matched, total)})</strong>.
      </p>
      {!sameKeywords(keywords, savedKeywords) && (
        <p style={{ margin: '4px 0 0' }}>
          {changes.length === 0
            ? "Saving these keywords wouldn't change which bills match."
            : <>Saving these keywords would {changes[0]}{changes.length > 1 && <> and {changes[1]}</>}.</>}
        </p>
      )}
    </div>
  )
}
