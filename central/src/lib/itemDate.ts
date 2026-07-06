/**
 * Recover an ISO date (YYYY-MM-DD) embedded in free text — a LegiScan document
 * (supplement) or amendment title/description — for items whose structured
 * `date` field is missing. Pure; never throws.
 *
 * - Full date `M/D/YY` or `M/D/YYYY` always resolves (2-digit year → 20YY).
 * - Year-less `M/D` resolves only when the bill's session is a single calendar
 *   year (yearStart === yearEnd); otherwise the year can't be placed and we
 *   return null.
 * - Returns null when no valid date is present (month 1–12, day 1–31).
 *
 * Kept generic over (text, { yearStart, yearEnd }) — not specialized to a
 * particular entity — so it can be wired into a new assembly point cheaply.
 */
export function recoverItemDate(
  text: string | null | undefined,
  opts: { yearStart?: number | null; yearEnd?: number | null },
): string | null {
  if (!text) return null

  // Full date first. \b keeps us from matching inside a longer digit run.
  const full = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/)
  if (full) {
    const month = Number(full[1])
    const day = Number(full[2])
    const year = full[3].length === 2 ? 2000 + Number(full[3]) : Number(full[3])
    const iso = toIso(year, month, day)
    if (iso) return iso
  }

  // Year-less M/D — only safe to date when the session is a single calendar year.
  const { yearStart, yearEnd } = opts
  if (yearStart != null && yearStart === yearEnd) {
    const md = text.match(/\b(\d{1,2})\/(\d{1,2})\b/)
    if (md) {
      const iso = toIso(yearStart, Number(md[1]), Number(md[2]))
      if (iso) return iso
    }
  }

  return null
}

/**
 * Resolve the date to show for an item: a present structured date wins (not
 * inferred); otherwise recover one from free text and flag it inferred so the
 * UI can mark its provenance.
 */
export function resolveItemDate(
  rawDate: string | null | undefined,
  text: string | null | undefined,
  opts: { yearStart?: number | null; yearEnd?: number | null },
): { dateResolved: string | null; dateInferred: boolean } {
  if (rawDate && rawDate !== '0000-00-00') return { dateResolved: rawDate, dateInferred: false }
  const recovered = recoverItemDate(text, opts)
  return { dateResolved: recovered, dateInferred: recovered != null }
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
