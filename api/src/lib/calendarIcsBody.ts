const trackerLink = (assoc: string, href: string) =>
  `View in ${assoc} Tracker: ${href}`

export function hearingBody(p: {
  billNumber: string; billTitle: string | null; priority: string | null
  billHref: string; assoc: string
}): string {
  const first = p.billTitle?.trim() ? `${p.billNumber}: ${p.billTitle.trim()}` : p.billNumber
  const lines: string[] = [first]
  if (p.priority) lines.push(`Priority: ${p.priority}`)
  lines.push('', trackerLink(p.assoc, p.billHref))
  return lines.join('\n')
}

// Precedence A: user url → first linked bill (canonical) → calendar page.
export function customUrl(p: { url: string | null; billHref: string | null; calendarHref: string }): string {
  if (p.url) return p.url
  if (p.billHref) return p.billHref
  return p.calendarHref
}

export function customBody(p: {
  details: string | null; url: string | null; billNumbers: string[]
  billHref: string | null; calendarHref: string; assoc: string
}): string {
  const lines: string[] = []
  if (p.details?.trim()) lines.push(p.details.trim())
  if (p.billNumbers.length) lines.push(`Related bills: ${p.billNumbers.join(', ')}`)
  if (p.url) lines.push(`More info: ${p.url}`)
  lines.push('', trackerLink(p.assoc, p.billHref ?? p.calendarHref))
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}
