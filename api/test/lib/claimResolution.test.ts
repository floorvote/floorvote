import { describe, it, expect, vi } from 'vitest'
import { resolveClaimSources, pruneClaimSources } from '../../src/lib/claimResolution'
import { billHtmlToText } from '../../src/lib/billText'
import type { ClaimSource, ResolvedClaimSource, Span } from '../../src/lib/claimSources'

// Resolving each claim source: the claim in the summary, the quote in the
// document the model read (#569, design in #560). Every document here is
// invented prose, never real bill text.

// The library is wrapped, not replaced: every call goes through, and the spy
// lets the last describe prove the matcher only ever hands `match` a pattern of
// 32 characters or fewer, and uses nothing but `match` and `makeDiff`.
const spies = vi.hoisted(() => ({ match: vi.fn<(...a: unknown[]) => void>(), makeDiff: vi.fn<(...a: unknown[]) => void>(), other: vi.fn<(...a: unknown[]) => void>() }))
vi.mock('@sanity/diff-match-patch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sanity/diff-match-patch')>()
  const wrap = (name: string, fn: (...a: never[]) => unknown, spy: (...a: unknown[]) => void) =>
    (...args: unknown[]) => { spy(name, ...args); return (fn as (...a: unknown[]) => unknown)(...args) }
  return new Proxy(actual, {
    get(target, prop: string) {
      const value = (target as Record<string, unknown>)[prop]
      if (prop === 'match') return wrap('match', value as never, spies.match)
      if (prop === 'makeDiff') return wrap('makeDiff', value as never, spies.makeDiff)
      return typeof value === 'function' ? wrap(prop, value as never, spies.other) : value
    },
  })
})

const SENTENCES = [
  'Section 1. This act may be cited as the Ballot Drop Box Access Act.',
  'Section 2. Each county election office shall provide at least one secure drop box for the return of voted ballots.',
  'Section 3. The secretary of the commonwealth shall adopt rules governing the location, lighting, and surveillance of each drop box.',
  'Section 4. A drop box shall be emptied by two employees of the county election office at least once each business day.',
  'Section 5. The county shall report the number of ballots collected from each drop box to the secretary within ten days after an election.',
  'Section 6. A person who tampers with a drop box commits a misdemeanor and may be fined not more than five hundred dollars.',
  'Section 7. Nothing in this act limits the authority of a municipal clerk to accept ballots delivered in person.',
  'Section 8. This act takes effect on the first day of the third month after it becomes law.',
]
const DOC = SENTENCES.join('\n')

/** The invented passage a quote is copied from. */
const Q_LONG = 'The county shall report the number of ballots collected from each drop box to the secretary within ten days after an election.'

const slice = (doc: string, at: Span | undefined) => (at ? doc.slice(at.start, at.end) : undefined)
function one(quote: string, doc: string | null = DOC, claim = 'Counties report drop box totals.', summary = 'Counties report drop box totals.'): ResolvedClaimSource {
  const { items } = resolveClaimSources([{ claim, quote }], summary, doc)
  expect(items).toHaveLength(1)
  return items[0]
}

/** Wrap prose the way a legislature's printed text does: a line number starts each line. */
function withLineNumbers(prose: string, width = 46): string {
  const words = prose.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur); cur = w } else cur = (cur + ' ' + w).trim()
  }
  if (cur) lines.push(cur)
  return lines.map((l, i) => `${i + 12} ${l}`).join('\n')
}

describe('exact', () => {
  it('finds a quote copied character for character, and says where', () => {
    const r = one('Each county election office shall provide at least one secure drop box')
    expect(r.status).toBe('exact')
    expect(slice(DOC, r.quoteAt)).toBe('Each county election office shall provide at least one secure drop box')
    expect(r.matched).toBe('Each county election office shall provide at least one secure drop box')
  })

  it('keeps the model\'s claim and quote as they were, and the page', () => {
    const r = resolveClaimSources([{ claim: 'Counties report drop box totals.', quote: 'ten days after an election', page: 3 }], 'Counties report drop box totals.', DOC).items[0]
    expect(r).toMatchObject({ claim: 'Counties report drop box totals.', quote: 'ten days after an election', page: 3, status: 'exact' })
  })

  it('finds a quote of exactly 32 characters, and of 33', () => {
    const q32 = 'at least one secure drop box for'
    const q33 = 'at least one secure drop box for '
    expect(q32).toHaveLength(32)
    expect(q33).toHaveLength(33)
    expect(one(q32).status).toBe('exact')
    expect(one(q33).status).toBe('exact')
  })

  it('finds a short quote (under 32 characters)', () => {
    const r = one('two employees')
    expect(r.status).toBe('exact')
    expect(slice(DOC, r.quoteAt)).toBe('two employees')
  })

  it('finds a quote at the very start and at the very end of the document', () => {
    expect(slice(DOC, one('Section 1. This act may').quoteAt)).toBe('Section 1. This act may')
    expect(slice(DOC, one('after it becomes law.').quoteAt)).toBe('after it becomes law.')
    expect(one('after it becomes law.').quoteAt!.end).toBe(DOC.length)
  })

  it('takes the first of two identical passages, every time', () => {
    const doc = `${DOC}\n\n${DOC}`
    const results = [one('shall adopt rules governing the location', doc), one('shall adopt rules governing the location', doc)]
    expect(results[0].status).toBe('exact')
    expect(results[0].quoteAt!.start).toBe(DOC.indexOf('shall adopt rules governing the location'))
    expect(results[1]).toEqual(results[0])
  })
})

describe('normalized', () => {
  it('finds a quote whose whitespace differs from the document\'s', () => {
    const doc = 'Section 2. Each county election\n    office   shall provide\tat least one secure\n\ndrop box.'
    const r = one('Each county election office shall provide at least one secure drop box.', doc)
    expect(r.status).toBe('normalized')
    expect(slice(doc, r.quoteAt)).toBe('Each county election\n    office   shall provide\tat least one secure\n\ndrop box.')
    expect(r.matched).toBe('Each county election office shall provide at least one secure drop box.')
  })

  it('finds a quote with stray whitespace of its own', () => {
    const r = one('  each\n county  '.replace('each', 'Each') + 'election office shall provide ')
    expect(r.status).toBe('normalized')
    expect(slice(DOC, r.quoteAt)).toBe('Each county election office shall provide')
  })

  it('treats a non-breaking space like a space', () => {
    const doc = 'Each county election office shall provide at least one secure drop box.'
    expect(one('Each county election office shall provide at least one', doc).status).toBe('normalized')
  })

  it('folds curly quotes and dashes in the document to the straight ones in the quote', () => {
    const doc = 'The secretary’s rules for “drop box” lighting—and surveillance–take effect at once.'
    const r = one('The secretary\'s rules for "drop box" lighting-and surveillance-take effect at once.', doc)
    expect(r.status).toBe('normalized')
    expect(slice(doc, r.quoteAt)).toBe(doc)
  })

  it('folds curly quotes and dashes in the quote to the straight ones in the document', () => {
    const doc = 'The secretary\'s rules for "drop box" lighting-and surveillance-take effect at once.'
    const r = one('The secretary’s rules for “drop box” lighting—and surveillance–take effect at once.', doc)
    expect(r.status).toBe('normalized')
  })

  it('ignores retained <u> and <strike> markup inside the span', () => {
    const doc = billHtmlToText('<p>Each county election office shall <strike>may</strike> <u>provide</u> at least one <u>secure</u> drop box.</p>')
    expect(doc).toContain('<strike>')
    const r = one('Each county election office shall may provide at least one secure drop box.', doc)
    expect(r.status).toBe('normalized')
    expect(r.matched).toBe('Each county election office shall may provide at least one secure drop box.')
    expect(slice(doc, r.quoteAt)!.startsWith('Each county')).toBe(true)
    expect(slice(doc, r.quoteAt)!.endsWith('drop box.')).toBe(true)
  })

  it('ignores <font> and bold redline markup too', () => {
    const doc = billHtmlToText('<p>A drop box <font color="#B30000"><b>shall</b></font> be emptied by two employees each day.</p>')
    expect(one('A drop box shall be emptied by two employees each day.', doc).status).toBe('normalized')
  })

  it('is exact when the quote carries the markup itself', () => {
    const doc = billHtmlToText('<p>A drop box <u>shall</u> be emptied daily.</p>')
    expect(one('A drop box <u>shall</u> be emptied daily.', doc).status).toBe('exact')
  })

  it('does not start or end the location on a markup tag', () => {
    const doc = billHtmlToText('<p><u>Each county shall provide a drop box</u> and more.</p>')
    const r = one('Each county shall provide a drop box', doc)
    expect(slice(doc, r.quoteAt)).toBe('Each county shall provide a drop box')
    expect(r.status).toBe('exact')
  })
})

describe('fuzzy', () => {
  it('finds a faithful copy broken by line numbers inside the span', () => {
    const doc = `${SENTENCES[0]}\n${withLineNumbers(SENTENCES[4])}\n${SENTENCES[5]}`
    expect(doc).toMatch(/\n1\d /)
    const r = one(Q_LONG, doc)
    expect(r.status).toBe('fuzzy')
    const found = slice(doc, r.quoteAt)!
    expect(found.startsWith('The county shall report')).toBe(true)
    expect(found.endsWith('after an election.')).toBe(true)
    expect(r.matched).toMatch(/ballots collected 1\d from each|1\d /)
  })

  it('finds a long quote that runs across many numbered lines', () => {
    const prose = `${SENTENCES[2].replace('Section 3. ', '')} ${SENTENCES[3].replace('Section 4. ', '')} ${SENTENCES[4].replace('Section 5. ', '')}`
    const doc = [SENTENCES[0], 'Section 3.', withLineNumbers(prose, 40), SENTENCES[7]].join('\n')
    expect(doc.match(/\n\d\d /g)!.length).toBeGreaterThan(6)
    const r = one(prose, doc)
    expect(r.status).toBe('fuzzy')
    expect(slice(doc, r.quoteAt)!.startsWith('The secretary of the commonwealth')).toBe(true)
    expect(slice(doc, r.quoteAt)!.endsWith('election.')).toBe(true)
  })

  it('finds a short quote (32 characters or fewer) that has one stray character', () => {
    const doc = 'A drop box shall be emptied by two emploiyees at least once each day.'
    const r = one('shall be emptied by two employees', doc)
    expect(r.status).toBe('fuzzy')
    expect(slice(doc, r.quoteAt)!.startsWith('shall be emptied by two emplo')).toBe(true)
  })

  it('finds a quote with a line number in a short passage', () => {
    const doc = 'A drop box shall be emptied by\n14 two employees at least once each day.'
    const r = one('shall be emptied by two employees', doc)
    expect(r.status).toBe('fuzzy')
  })

  it('finds a quote later in the document, not only near the start', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `Filler sentence number ${i} about nothing in particular here.`).join(' ')
    const doc = `${filler}\n${withLineNumbers(SENTENCES[4])}\n${filler}`
    const r = one(Q_LONG, doc)
    expect(r.status).toBe('fuzzy')
    expect(r.quoteAt!.start).toBeGreaterThan(filler.length)
  })

  it('takes the first of two identical numbered passages, every time', () => {
    const numbered = withLineNumbers(SENTENCES[4])
    const doc = `${numbered}\n${SENTENCES[6]}\n${numbered}`
    const a = one(Q_LONG, doc)
    const b = one(Q_LONG, doc)
    expect(a.status).toBe('fuzzy')
    expect(a.quoteAt!.start).toBeLessThan(numbered.length)
    expect(b).toEqual(a)
  })

  it('does not call a quote fuzzy when it is only about 70 percent alike', () => {
    const base = 'Each county election office shall provide at least one secure drop box for the return of voted ballots'
    const doc = `${DOC}\n${base}`
    const garbled = base.split('').map((c, i) => (i % 3 === 0 && c !== ' ' ? 'Q' : c)).join('')
    expect(one(garbled, doc).status).not.toBe('fuzzy')
  })

  it('calls a quote fuzzy when about 90 percent alike', () => {
    const base = 'Each county election office shall provide at least one secure drop box for the return of voted ballots'
    const doc = `${DOC}\n${base}`
    const garbled = base.split('').map((c, i) => (i % 11 === 0 && c !== ' ' ? 'Q' : c)).join('')
    expect(one(garbled, doc).status).toBe('fuzzy')
  })
})

describe('anchored', () => {
  const header = '\nHB 77 -- 2026 Regular Session -- Page 14 of 52 -- Printed by the legislative service\n'

  it('anchors a quote with a running header inside the span', () => {
    const doc = SENTENCES.slice(0, 4).join('\n') + '\n' + Q_LONG.slice(0, 60) + header + Q_LONG.slice(60) + '\n' + SENTENCES[6]
    const r = one(Q_LONG, doc)
    expect(r.status).toBe('anchored')
    const found = slice(doc, r.quoteAt)!
    expect(found).toBe(Q_LONG.slice(0, 32))
    expect(r.matched).toBe(found)
  })

  it('anchors on the head, not the tail, when both ends are there but the whole is not', () => {
    const doc = `${Q_LONG.slice(0, 40)} -- an aside that is long enough to push the whole below the bar, about a hundred characters in all -- ${Q_LONG.slice(40)}`
    const r = one(Q_LONG, doc)
    expect(r.status).toBe('anchored')
    expect(r.quoteAt!.start).toBe(0)
  })

  it('does not take a tail that comes before the head as the end of the passage', () => {
    const doc = `${Q_LONG.slice(-60)}\n${SENTENCES[6]}\n${Q_LONG.slice(0, 60)}`
    const r = one(Q_LONG, doc)
    expect(r.status).toBe('anchored')
    expect(slice(doc, r.quoteAt)).toBe(Q_LONG.slice(0, 32))
  })

  it('anchors on the head when the head is the part that matched', () => {
    const doc = `${SENTENCES[0]}\n${Q_LONG.slice(0, 70)} and then something else entirely follows here, unrelated to the quote.`
    const r = one(Q_LONG, doc)
    expect(r.status).toBe('anchored')
    expect(slice(doc, r.quoteAt)).toBe(Q_LONG.slice(0, 32))
  })

  it('anchors on the tail when only the tail matched', () => {
    const doc = `${SENTENCES[0]}\nSomething entirely different begins this passage and wanders off ${Q_LONG.slice(-60)}`
    const r = one(Q_LONG, doc)
    expect(r.status).toBe('anchored')
    expect(slice(doc, r.quoteAt)).toBe(Q_LONG.slice(-32))
  })

  it('does not anchor a quote of 32 characters or fewer, which has no separate head and tail', () => {
    const r = one('zebras shall adopt rules about moats')
    expect(r.status).toBe('ungrounded')
    const s = one('a quote with nothing alike in it')
    expect(s.status).toBe('ungrounded')
  })

  it('takes the first of two identical anchors, every time', () => {
    const passage = Q_LONG.slice(0, 60) + header + Q_LONG.slice(60)
    const doc = `${passage}\n${SENTENCES[6]}\n${passage}`
    const a = one(Q_LONG, doc)
    expect(a.status).toBe('anchored')
    expect(a.quoteAt!.start).toBeLessThan(passage.length)
    expect(one(Q_LONG, doc)).toEqual(a)
  })
})

describe('ungrounded', () => {
  it('marks a quote that is not in the document', () => {
    const r = one('Every county shall install a statue of a heron beside each polling place door.')
    expect(r.status).toBe('ungrounded')
    expect(r.quoteAt).toBeUndefined()
    expect(r.matched).toBeUndefined()
  })

  it('marks a quote that shares only vocabulary with the document', () => {
    const r = one('A secretary of the county shall report each business day to the municipal clerk about ballots tampered with.')
    expect(r.status).toBe('ungrounded')
  })

  it('marks a short quote that is not in the document', () => {
    expect(one('heron statue').status).toBe('ungrounded')
  })

  it('marks an empty quote, and a quote of only whitespace', () => {
    expect(one('').status).toBe('ungrounded')
    expect(one('  \n\t ').status).toBe('ungrounded')
    expect(one('').quoteAt).toBeUndefined()
  })

  it('marks a quote against an empty document', () => {
    expect(one('Each county shall', '').status).toBe('ungrounded')
  })

  it('still records where the claim is', () => {
    const r = resolveClaimSources([{ claim: 'Counties report totals.', quote: 'a made up passage about herons' }], 'Intro. Counties report totals. End.', DOC).items[0]
    expect(r.status).toBe('ungrounded')
    expect(r.claimAt).toEqual({ start: 7, end: 30 })
  })
})

describe('the claim in the summary', () => {
  it('records where an exact claim is', () => {
    const summary = 'Drop boxes.\n- Requires a drop box in each county.\n- Sets penalties.'
    const r = resolveClaimSources([{ claim: 'Requires a drop box in each county.', quote: 'two employees' }], summary, DOC).items[0]
    expect(slice(summary, r.claimAt)).toBe('Requires a drop box in each county.')
  })

  it('finds a claim whose whitespace differs from the summary\'s', () => {
    const summary = 'Requires a drop box\n  in each   county.'
    const r = resolveClaimSources([{ claim: 'Requires a drop box in each county.', quote: 'two employees' }], summary, DOC).items[0]
    expect(r.claim).toBe('Requires a drop box in each county.')
    expect(slice(summary, r.claimAt)).toBe('Requires a drop box\n  in each   county.')
  })

  it('drops a claim that is not in the summary, and counts it', () => {
    const out = resolveClaimSources(
      [{ claim: 'Requires a heron statue.', quote: 'two employees' }, { claim: 'Sets penalties.', quote: 'a misdemeanor' }],
      'Sets penalties. For tampering.', DOC)
    expect(out.items.map(i => i.claim)).toEqual(['Sets penalties.'])
    expect(out.dropped).toBe(1)
  })

  it('drops a claim that is only blank', () => {
    const out = resolveClaimSources([{ claim: '   ', quote: 'two employees' }], 'Anything.', DOC)
    expect(out.items).toEqual([])
    expect(out.dropped).toBe(1)
  })

  it('does not match a claim on case or punctuation, which the model copied character for character', () => {
    const out = resolveClaimSources([{ claim: 'requires a drop box', quote: 'two employees' }], 'Requires a drop box.', DOC)
    expect(out.items).toEqual([])
  })

  it('takes the first of two identical claims', () => {
    const summary = 'Sets penalties. Other. Sets penalties.'
    const r = resolveClaimSources([{ claim: 'Sets penalties.', quote: 'a misdemeanor' }], summary, DOC).items[0]
    expect(r.claimAt).toEqual({ start: 0, end: 15 })
  })

  it('resolves several items, in order, each on its own', () => {
    const summary = 'Counties report drop box totals. Tampering is a misdemeanor. Rules on lighting.'
    const out = resolveClaimSources([
      { claim: 'Counties report drop box totals.', quote: 'report the number of ballots collected' },
      { claim: 'Tampering is a misdemeanor.', quote: 'tampers with a drop box commits a misdemeanor' },
      { claim: 'Rules on lighting.', quote: 'heron statues everywhere' },
    ], summary, DOC)
    expect(out.items.map(i => i.status)).toEqual(['exact', 'exact', 'ungrounded'])
    expect(out.dropped).toBe(0)
  })

  it('returns nothing for no items', () => {
    expect(resolveClaimSources([], 'Summary.', DOC)).toEqual({ items: [], dropped: 0, capped: 0, unsearched: 0 })
  })

  it('drops every item against an empty summary', () => {
    expect(resolveClaimSources([{ claim: 'Sets penalties.', quote: 'x' }], '', DOC).items).toEqual([])
  })
})

describe('a PDF', () => {
  it('leaves the quote unverified when the claim is in the summary, and keeps the page', () => {
    const r = resolveClaimSources([{ claim: 'Sets penalties.', quote: 'a misdemeanor', page: 4 }], 'Sets penalties.', null).items[0]
    expect(r).toMatchObject({ claim: 'Sets penalties.', quote: 'a misdemeanor', page: 4, status: 'unverified' })
    expect(r.quoteAt).toBeUndefined()
    expect(r.claimAt).toEqual({ start: 0, end: 15 })
  })

  it('keeps a missing page as null', () => {
    const r = resolveClaimSources([{ claim: 'Sets penalties.', quote: 'a misdemeanor', page: null }], 'Sets penalties.', null).items[0]
    expect(r.page).toBeNull()
    expect(r.status).toBe('unverified')
  })

  it('marks an empty quote ungrounded', () => {
    expect(resolveClaimSources([{ claim: 'Sets penalties.', quote: '', page: 4 }], 'Sets penalties.', null).items[0].status).toBe('ungrounded')
  })

  it('drops a claim that is not in the summary', () => {
    const out = resolveClaimSources([{ claim: 'Other.', quote: 'a misdemeanor', page: 4 }], 'Sets penalties.', null)
    expect(out).toEqual({ items: [], dropped: 1, capped: 0, unsearched: 0 })
  })
})

describe('the document is the text the model read', () => {
  it('resolves against billHtmlToText output, markup and all, from real HTML', () => {
    const html = '<html><body><p>Section 2. Each county election office shall<br>14 provide at least one<br>15 <u>secure</u> drop box for the return of voted ballots.</p></body></html>'
    const doc = billHtmlToText(html)
    const r = one('Each county election office shall provide at least one secure drop box for the return of voted ballots.', doc)
    expect(r.status).toBe('fuzzy')
    expect(slice(doc, r.quoteAt)!.startsWith('Each county election office shall')).toBe(true)
  })

  describe('bill text central decoded from windows-1252 bytes (#574)', () => {
    // Invented HTML as a state's server sends it, in windows-1252: 0x93 and
    // 0x94 are curly double quotes, 0x92 a curly apostrophe, 0xA7 the section
    // sign, and 0x96 an en dash. Central decodes it (as `decodeStoredHtml` does
    // for bytes that are not UTF-8), and the instance reads that string.
    const ascii = (s: string) => [...s].map(c => c.charCodeAt(0))
    const bytes = new Uint8Array([
      ...ascii('<html><body><p>Section 4. The term '), 0x93, ...ascii('drop box'), 0x94,
      ...ascii(' has the meaning given in '), 0xa7, ...ascii(' 12'), 0x96, ...ascii('3 of the clerk'), 0x92,
      ...ascii('s rules, and applies from 2027'), 0x96, ...ascii('2029.</p></body></html>'),
    ])
    const doc = billHtmlToText(new TextDecoder('windows-1252').decode(bytes))
    const passage = 'The term “drop box” has the meaning given in § 12–3 of the clerk’s rules, and applies from 2027–2029.'

    it('decodes to the curly quotes, section sign, and en dashes, not U+FFFD', () => {
      expect(doc).toContain(passage)
      expect(doc).not.toContain('�')
    })

    it('resolves a quote copied with the same characters as exact', () => {
      const r = one(passage, doc)
      expect(r.status).toBe('exact')
      expect(slice(doc, r.quoteAt)).toBe(passage)
    })

    it('resolves a quote written with straight quotes and hyphens as normalized', () => {
      const r = one('The term "drop box" has the meaning given in § 12-3 of the clerk\'s rules, and applies from 2027-2029.', doc)
      expect(r.status).toBe('normalized')
      expect(slice(doc, r.quoteAt)).toBe(passage)
    })
  })
})

describe('pruning after a summary edit', () => {
  const claim = (text: string, at: Span, status: ResolvedClaimSource['status'] = 'exact'): ResolvedClaimSource =>
    ({ claim: text, quote: 'q', status, claimAt: at, quoteAt: { start: 1, end: 2 }, matched: 'm' })

  it('keeps an item whose claim is still in the edited summary, at its new place', () => {
    const items = [claim('Sets penalties.', { start: 0, end: 15 })]
    const out = pruneClaimSources(items, 'New opening sentence. Sets penalties.')
    expect(out).toHaveLength(1)
    expect(out[0].claimAt).toEqual({ start: 22, end: 37 })
    expect(out[0].quoteAt).toEqual({ start: 1, end: 2 })
    expect(out[0].status).toBe('exact')
  })

  it('drops an item whose claim is gone', () => {
    const items = [claim('Sets penalties.', { start: 0, end: 15 }), claim('Requires drop boxes.', { start: 16, end: 36 })]
    const out = pruneClaimSources(items, 'Requires drop boxes.')
    expect(out.map(i => i.claim)).toEqual(['Requires drop boxes.'])
    expect(out[0].claimAt).toEqual({ start: 0, end: 20 })
  })

  it('drops an item whose claim was reworded', () => {
    expect(pruneClaimSources([claim('Sets penalties.', { start: 0, end: 15 })], 'Sets a penalty.')).toEqual([])
  })

  it('keeps an item whose claim only changed whitespace', () => {
    const out = pruneClaimSources([claim('Sets penalties for tampering.', { start: 0, end: 29 })], 'Sets  penalties\nfor tampering.')
    expect(out).toHaveLength(1)
    expect(out[0].claimAt).toEqual({ start: 0, end: 30 })
  })

  it('drops everything when the summary is cleared', () => {
    const items = [claim('Sets penalties.', { start: 0, end: 15 })]
    expect(pruneClaimSources(items, '')).toEqual([])
    expect(pruneClaimSources(items, null)).toEqual([])
  })

  it('keeps an item with no location in the document, such as a PDF item', () => {
    const pdf: ResolvedClaimSource = { claim: 'Sets penalties.', quote: 'q', page: 2, status: 'unverified', claimAt: { start: 0, end: 15 } }
    expect(pruneClaimSources([pdf], 'Sets penalties.')).toEqual([pdf])
  })

  it('leaves an unchanged summary\'s items exactly as they were', () => {
    const items = [claim('Sets penalties.', { start: 0, end: 15 }), claim('Other.', { start: 16, end: 22 }, 'fuzzy')]
    expect(pruneClaimSources(items, 'Sets penalties. Other.')).toEqual(items)
  })
})

describe('what it asks of the library', () => {
  const inputs: ClaimSource[] = [
    { claim: 'Counties report drop box totals.', quote: Q_LONG },
    { claim: 'Counties report drop box totals.', quote: Q_LONG.slice(0, 20) },
    { claim: 'Counties report drop box totals.', quote: `${Q_LONG.slice(0, 50)} 14 ${Q_LONG.slice(50)}` },
    { claim: 'Counties report drop box totals.', quote: 'Every county shall install a statue of a heron beside each polling place door.' },
    { claim: 'Counties report drop box totals.', quote: 'heron' },
  ]
  const noisy = `${SENTENCES[0]}\n${withLineNumbers(SENTENCES[4])}\n${SENTENCES[5]}`

  it('never hands match a pattern of more than 32 characters', () => {
    spies.match.mockClear()
    for (const doc of [DOC, noisy]) resolveClaimSources(inputs, 'Counties report drop box totals.', doc)
    expect(spies.match.mock.calls.length).toBeGreaterThan(0)
    for (const [, , pattern] of spies.match.mock.calls as unknown[][]) expect((pattern as string).length).toBeLessThanOrEqual(32)
  })

  it('scores with makeDiff', () => {
    spies.makeDiff.mockClear()
    resolveClaimSources(inputs, 'Counties report drop box totals.', noisy)
    expect(spies.makeDiff.mock.calls.length).toBeGreaterThan(0)
  })

  it('uses nothing else from the library', () => {
    spies.other.mockClear()
    for (const doc of [DOC, noisy]) resolveClaimSources(inputs, 'Counties report drop box totals.', doc)
    expect(spies.other).not.toHaveBeenCalled()
  })

  it('does not throw on awkward quotes', () => {
    const odd = ['\u0000', '<u></u>', '<', '​​', 'x'.repeat(5000), '😀'.repeat(40), '((((((((((((((((((((((((((((((((((((']
    for (const quote of odd) expect(() => resolveClaimSources([{ claim: 'Counties report drop box totals.', quote }], 'Counties report drop box totals.', DOC)).not.toThrow()
  })
})

describe('a large document', () => {
  it('resolves a typical set of claims, found and not, in a long bill', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `Section ${i}. ${SENTENCES[i % SENTENCES.length].replace(/^Section \d+\. /, '')} Subsection ${i * 7} applies.`).join('\n')
    expect(body.length).toBeGreaterThan(300_000)
    const target = withLineNumbers('The commissioner shall publish a quarterly report listing every drop box by county and the date it was installed.')
    const doc = `${body}\n${target}\n${body.slice(0, 1000)}`
    const items: ClaimSource[] = []
    for (let i = 0; i < 12; i++) {
      items.push({ claim: 'C.', quote: 'The commissioner shall publish a quarterly report listing every drop box by county and the date it was installed.' })
      items.push({ claim: 'C.', quote: `Nobody shall ever install an obelisk number ${i} in any rotunda, by order of the herons of the commonwealth.` })
    }
    const out = resolveClaimSources(items, 'C.', doc)
    expect(out.items.filter(i => i.status === 'fuzzy')).toHaveLength(12)
    expect(out.items.filter(i => i.status === 'ungrounded')).toHaveLength(12)
    expect(out.unsearched).toBe(0)
  }, 60_000)
})

describe('a head that repeats in the document', () => {
  const boiler = 'Section 5. The secretary of state shall adopt rules, '
  const first = `${boiler}governing the location of each drop box and the lighting of its surroundings.`
  const secondProse = `${boiler}for the return of voted ballots to the county election office within a stated period.`
  const filler = Array.from({ length: 6 }, (_, i) => `Filler sentence ${i} about nothing in particular.`).join(' ')

  it('lands on the passage whose tail is where it should be, not the first head', () => {
    const doc = `${first} ${filler} ${withLineNumbers(secondProse, 50)} Trailing sentence.`
    const quote = secondProse
    expect(boiler).toHaveLength(53)
    const r = one(quote, doc)
    expect(r.status).toBe('fuzzy')
    expect(r.quoteAt!.start).toBeGreaterThan(doc.indexOf(filler))
    expect(slice(doc, r.quoteAt)!.endsWith('stated period.')).toBe(true)
  })

  it('finds the later passage whole when a header inside it is too long for a window the quote\'s length', () => {
    const header = '\nHB 77 -- Page 14 of 52 -- Printed\n'
    const cut = secondProse.indexOf('county election office')
    const later = `${secondProse.slice(0, cut)}${header}${secondProse.slice(cut)}`
    const doc = `${first} ${filler} ${later} Trailing sentence.`
    expect(header.length + secondProse.length).toBeGreaterThan(secondProse.length + 16)
    const r = one(secondProse, doc)
    expect(r.status).toBe('fuzzy')
    expect(r.quoteAt!.start).toBe(doc.indexOf(later))
    expect(slice(doc, r.quoteAt)!.endsWith('stated period.')).toBe(true)
  })

  it('still takes the first when its tail is there', () => {
    const doc = `${withLineNumbers(secondProse, 50)} ${filler} ${withLineNumbers(secondProse, 50)}`
    const r = one(secondProse, doc)
    expect(r.status).toBe('fuzzy')
    expect(r.quoteAt!.start).toBeLessThan(doc.indexOf(filler))
  })

  it('falls back to the first head when no occurrence has its tail', () => {
    const doc = `${first} ${filler} ${boiler}and something else entirely unrelated to the quote at all.`
    const r = one(secondProse, doc)
    expect(r.status).toBe('anchored')
    expect(r.quoteAt!.start).toBe(0)
  })
})

describe('a whole that is alike though one end differs', () => {
  it('is fuzzy, not anchored, when only the tail window falls below the bar', () => {
    const lead = 'Each county election office shall report the ballots collected from each drop box to the secretary after every election and '
    const doc = `Intro text. ${lead}then publish the roster of each drop box on the web page of the office. More text follows.`
    const quote = `${lead}then publish the list of every drop box on the office website.`
    const r = one(quote, doc)
    expect(r.status).toBe('fuzzy')
    expect(slice(doc, r.quoteAt)!.startsWith('Each county election office')).toBe(true)
    expect(slice(doc, r.quoteAt)).toContain('roster of each drop box on the')
  })
})

describe('numbers must agree', () => {
  const doc = 'The clerk shall post the results to the public website within 10 days after an election, and the board shall certify within ten days of that. A fine of $500 may apply.'

  it.each([
    ['digits, a long quote', 'The clerk shall post the results to the public website within 15 days after an election'],
    ['digits, a short quote', 'website within 15 days after'],
    ['a number word, a long quote', 'the board shall certify within thirty days of that. A fine of $500 may apply.'],
    ['a number word, a short quote', 'certify within thirty days'],
    ['a digit sequence that only gains a digit', 'A fine of $5000 may apply, said the clerk'],
  ])('is ungrounded when %s differs', (_label, quote) => {
    expect(one(quote, doc).status).toBe('ungrounded')
  })

  it('is ungrounded for an anchor whose number differs', () => {
    const header = '\nHB 77 -- 2026 Regular Session -- Page 14 of 52 -- Printed by the legislative service\n'
    const text = `The board shall certify within ten days of that and then the secretary shall publish the totals${header}for every drop box in every county across the state.`
    const quote = 'The board shall certify within thirty days of that and then the secretary shall publish the totals for every drop box in every county across the state.'
    expect(one(quote, text).status).toBe('ungrounded')
  })

  it('looks past an earlier passage that differs in its numbers to the later one the quote copies', () => {
    // The earlier head is one character off at the start of the document, and
    // the later one is exact but far in, so `match` proposes the earlier one.
    const earlier = 'Section 3. The clerk of each district shall post the notice at every polling place within ten days of the election.'
    const later = 'Section 39. The clerk of each district shall post the notice at every polling place within ten days of the primary.'
    const doc = `${earlier}\n${SENTENCES.join('\n').repeat(4)}\n${withLineNumbers(later, 50)}\nThe end.`
    const r = one(later, doc)
    expect(r.status).toBe('fuzzy')
    expect(r.quoteAt!.start).toBeGreaterThan(earlier.length)
    expect(slice(doc, r.quoteAt)!.endsWith('of the primary.')).toBe(true)
  })

  it('still grounds a copy broken by line numbers, which add digits the quote does not have', () => {
    const numbered = withLineNumbers('The board shall certify within ten days of that and then the secretary shall publish the totals for every drop box.', 40)
    const r = one('The board shall certify within ten days of that and then the secretary shall publish the totals for every drop box.', numbered)
    expect(r.status).toBe('fuzzy')
  })

  it('does not count digits in a hyphenated word or a thousands separator as different', () => {
    const d = 'The fee is $1,000 for a twenty-one day permit issued under Rule 4.2 of the board, with a stray ltter.'
    const r = one('The fee is $1,000 for a twenty-one day permit issued under Rule 4.2 of the board, with a stray letter.', d)
    expect(r.status).toBe('fuzzy')
  })
})

describe('numbers: ordinals, fractions, and numbers split by line breaking', () => {
  // A stray typo keeps the quote from matching exactly or after normalizing, so
  // it is the fuzzy tier whose number check is under test.
  const status = (docPart: string, quotePart: string) => {
    const doc = `Intro text here. The board shall certify ${docPart} after polls close, with a stray ltter in it. More text.`
    return one(`The board shall certify ${quotePart} after polls close, with a stray letter in it.`, doc).status
  }

  it.each([
    ['first for third', 'in the first year', 'in the third year'],
    ['1st for 3rd', 'in the 1st year', 'in the 3rd year'],
    ['one half for one quarter', 'one half of the members', 'one quarter of the members'],
    ['two thirds for two fourths', 'two-thirds of the members', 'two-fourths of the members'],
    ['twentieth for nineteenth', 'on the twentieth day', 'on the nineteenth day'],
    ['an ordinal word for a different digit ordinal', 'in the second year', 'in the 5th year'],
    ['a number word that is only inside another word', 'on often days', 'on ten days'],
    ['thirtieth for thirteenth', 'on the thirteenth day', 'on the thirtieth day'],
    ['ninetieth for nineteenth', 'on the nineteenth day', 'on the ninetieth day'],
    ['hundredth for thousandth', 'on the thousandth day', 'on the hundredth day'],
    ['twenty-first for twenty-third', 'on the twenty-third day', 'on the twenty-first day'],
    ['a word split by a plain space', 'within thir ty days', 'within thirty days'],
    ['a number with a hyphen inside it and no line break', 'a fee of $1-0 is due', 'a fee of $10 is due'],
    ['a digit ordinal with a hyphen inside it', 'on the 2-1st day', 'on the 21st day'],
  ])('is ungrounded for %s', (_label, d, q) => {
    expect(status(d, q)).toBe('ungrounded')
  })

  it.each([
    ['first and 1st', 'in the first year', 'in the 1st year'],
    ['1st and first', 'in the 1st year', 'in the first year'],
    ['third and 3rd', 'in the 3rd year', 'in the third year'],
    ['the same ordinal', 'in the first year', 'in the first year'],
    ['someone', 'if someone objects', 'if someone objects'],
    ['anyone', 'if anyone objects', 'if anyone objects'],
    ['first-time', 'for a first-time filer', 'for a first-time filer'],
    ['one half', 'one half of the members', 'one half of the members'],
    ['a word split by a hyphen and a line number', 'within thir-\n14 ty days', 'within thirty days'],
    ['a word split by a hyphen', 'within thir-\nty days', 'within thirty days'],
    ['thirtieth and 30th', 'on the 30th day', 'on the thirtieth day'],
    ['twenty-first and twenty-1st', 'on the twenty-first day', 'on the twenty-1st day'],
    ['a long ordinal split by a hyphen and a line number', 'on the thirti-\n14 eth day', 'on the thirtieth day'],
    ['a digit group split by a comma and a line number', 'a fee of $1,\n15 000 is due', 'a fee of $1,000 is due'],
    ['a number split by a line number', 'a fee of $1\n14 0 is due', 'a fee of $10 is due'],
  ])('is not rejected for %s', (_label, d, q) => {
    expect(status(d, q)).toBe('fuzzy')
  })

  it('is still ungrounded when a split number is not the quote\'s', () => {
    expect(status('a fee of $1\n14 0 is due', 'a fee of $20 is due')).toBe('ungrounded')
  })
})

describe('ceilings', () => {
  it('resolves at most 100 items, marks the rest ungrounded, and counts them', () => {
    const claims = Array.from({ length: 105 }, (_, i) => `Claim ${i} is made.`)
    const items: ClaimSource[] = claims.map(c => ({ claim: c, quote: 'two employees' }))
    const out = resolveClaimSources(items, claims.join(' '), DOC)
    expect(out.items).toHaveLength(105)
    expect(out.items.slice(0, 100).every(i => i.status === 'exact')).toBe(true)
    expect(out.items.slice(100).map(i => i.status)).toEqual(Array(5).fill('ungrounded'))
    expect(out.items[104].quoteAt).toBeUndefined()
    expect(out.capped).toBe(5)
  })

  it('does not count an item dropped for its claim against the 100', () => {
    const claims = Array.from({ length: 100 }, (_, i) => `Claim ${i} is made.`)
    const items: ClaimSource[] = [{ claim: 'Not in the summary at all.', quote: 'two employees' }, ...claims.map(c => ({ claim: c, quote: 'two employees' }))]
    const out = resolveClaimSources(items, claims.join(' '), DOC)
    expect(out.dropped).toBe(1)
    expect(out.capped).toBe(0)
    expect(out.items.every(i => i.status === 'exact')).toBe(true)
  })

  it('searches a long quote exactly and normalized, but not fuzzily, above 2,000 characters', () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => `Word${i % 97} filler${i % 31}`).join(' ')
    const big = long(130)
    expect(big.length).toBeGreaterThan(2000)
    const doc = `${DOC}\n${big}\n${DOC}`
    expect(one(big, doc).status).toBe('exact')
    expect(one(big.replace(/ /g, '  '), doc).status).toBe('normalized')
    const numbered = withLineNumbers(big, 60)
    expect(one(big, `${DOC}\n${numbered}\n${DOC}`).status).toBe('ungrounded')
    const under = long(90)
    expect(under.length).toBeLessThan(2000)
    expect(one(under, `${DOC}\n${withLineNumbers(under, 60)}\n${DOC}`).status).toBe('fuzzy')
  })

  describe('a bill whose quotes are mostly findable', () => {
    // Each passage has words of its own, as a real section does, so that a head
    // or a tail is not a near copy of another passage's.
    const SYLLABLES = ['ba', 'ro', 'ki', 'tu', 'me', 'la', 'sho', 'vin', 'dre', 'pol', 'gar', 'nex', 'fil', 'zon', 'cra', 'hep', 'wul', 'jod', 'qua', 'bri']
    const word = (i: number, k: number) => SYLLABLES[(i * (k + 3) + k) % 20] + SYLLABLES[(i * 7 + k * 5) % 20] + SYLLABLES[(Math.floor(i / 3) + k * 11) % 20]
    const passage = (i: number) => `The ${word(i, 0)} ${word(i, 1)} of district ${i} shall publish the ${word(i, 2)} report about ${word(i, 3)} box ${i * 7} to every ${word(i, 4)} ${word(i, 5)} each quarter.`
    const filler = (i: number, sentences = 140) => Array.from({ length: sentences }, (_, k) => `Background sentence ${i}-${k} that says nothing in particular.`).join(' ')

    function build(count: number, sentences = 140) {
      const parts: string[] = []
      for (let i = 0; i < count; i++) parts.push(filler(i, sentences), withLineNumbers(passage(i), 46))
      const doc = parts.join('\n')
      const claims = Array.from({ length: count }, (_, i) => `Claim ${i} is made.`)
      return { doc, claims, summary: claims.join(' ') }
    }

    it('resolves every valid numbered quote in a document of about 0.8 million characters', () => {
      const { doc, claims, summary } = build(60, 220)
      expect(doc.length).toBeGreaterThan(780_000)
      const out = resolveClaimSources(claims.map((claim, i) => ({ claim, quote: passage(i) })), summary, doc)
      expect(out.items.map(i => i.status)).toEqual(Array(60).fill('fuzzy'))
      expect(out.unsearched).toBe(0)
    })

    it('does not let absent quotes ahead of them take their links', () => {
      const { doc, claims, summary } = build(60)
      const items: ClaimSource[] = claims.map((claim, i) => ({
        claim, quote: i < 5 ? `Nobody shall ever install an obelisk number ${i} in any rotunda, by order of the herons of the commonwealth.` : passage(i),
      }))
      const out = resolveClaimSources(items, summary, doc)
      expect(out.items.slice(0, 5).map(i => i.status)).toEqual(Array(5).fill('ungrounded'))
      expect(out.items.slice(5).map(i => i.status)).toEqual(Array(55).fill('fuzzy'))
      expect(out.unsearched).toBe(0)
    })

    it('resolves every valid quote after eleven absent ones, in a document of about 1.7 million characters', () => {
      const { doc, claims, summary } = build(41, 680)
      expect(doc.length).toBeGreaterThan(1_650_000)
      const items: ClaimSource[] = claims.map((claim, i) => ({
        claim, quote: i < 11 ? `Nobody shall ever install an obelisk number ${i} in any rotunda, by order of the herons of the commonwealth.` : passage(i),
      }))
      const started = Date.now()
      const out = resolveClaimSources(items, summary, doc)
      expect(out.items.slice(0, 11).map(i => i.status)).toEqual(Array(11).fill('ungrounded'))
      expect(out.items.slice(11).map(i => i.status)).toEqual(Array(30).fill('fuzzy'))
      expect(Date.now() - started).toBeLessThan(30_000)
    }, 120_000)

    it('bounds a hundred anchored quotes in a document of about 1.7 million characters', () => {
      const { doc, claims, summary } = build(100, 285)
      expect(doc.length).toBeGreaterThan(1_650_000)
      // Each starts as the passage does and then wanders off, so it can only anchor.
      const items: ClaimSource[] = claims.map((claim, i) => ({
        claim, quote: `${passage(i).slice(0, 60)} and then, by order of the herons, ${word(i, 6)} ${word(i, 7)} ${word(i, 8)} quarrels about ${word(i, 9)} in the ${word(i, 10)} rotunda`,
      }))
      const started = Date.now()
      const out = resolveClaimSources(items, summary, doc)
      expect(out.items.every(i => i.status === 'anchored' || i.status === 'ungrounded')).toBe(true)
      expect(out.unsearched).toBeGreaterThan(0)
      expect(Date.now() - started).toBeLessThan(15_000)
    }, 120_000)

    it('spends nothing on exact matches, so the quotes that need a search get the budget', () => {
      // 90 exact items and 10 that need a search, on a document longer than
      // the largest a bill is meant to have.
      const { doc } = build(10, 4700)
      expect(doc.length).toBeGreaterThan(2_800_000)
      const claims = Array.from({ length: 100 }, (_, i) => `Claim ${i} is made.`)
      const items: ClaimSource[] = claims.map((claim, i) => ({
        claim, quote: i < 90 ? `Background sentence 0-${i} that says nothing in particular.` : passage(i - 90),
      }))
      const out = resolveClaimSources(items, claims.join(' '), doc)
      expect(out.items.slice(0, 90).every(i => i.status === 'exact')).toBe(true)
      expect(out.items.slice(90).map(i => i.status)).toEqual(Array(10).fill('fuzzy'))
      expect(out.unsearched).toBe(0)
    }, 120_000)

    it('gives the same statuses on a second run', () => {
      const { doc, claims, summary } = build(30)
      const items = claims.map((claim, i) => ({ claim, quote: i % 4 === 0 ? `Nobody shall install obelisk ${i} anywhere at all, by order of herons.` : passage(i) }))
      expect(resolveClaimSources(items, summary, doc)).toEqual(resolveClaimSources(items, summary, doc))
    })
  })

  it('finishes a hundred absent quotes against a document of about 1.7 million characters within the work budget', () => {
    const body = Array.from({ length: 14500 }, (_, i) => `Section ${i}. ${SENTENCES[i % SENTENCES.length].replace(/^Section \d+\. /, '')} Subsection ${i * 7} applies.`).join('\n')
    expect(body.length).toBeGreaterThan(1_700_000)
    const claims = Array.from({ length: 100 }, (_, i) => `Claim ${i} is made.`)
    const items: ClaimSource[] = claims.map((c, i) => ({ claim: c, quote: `Nobody shall ever install an obelisk number ${i} in any rotunda, by order of the herons of the commonwealth, at dawn.` }))
    const { out, ms, work } = timed(() => resolveClaimSources(items, claims.join(' '), body))
    expect(out.items.every(i => i.status === 'ungrounded')).toBe(true)
    // The budget is what bounds it: past it, a quote is left unsearched.
    expect(out.unsearched).toBeGreaterThan(0)
    expect(work).toBeLessThanOrEqual(WORK_BUDGET)
    expect(ms).toBeLessThan(TIME_GUARD)
  }, 120_000)
})

// The work budget (#569). Every `match` call is charged the characters it is
// handed and every `makeDiff` call its two lengths multiplied, a sixteenth of a
// unit a cell, before it runs. A call that would go past the budget is not made.
// The spy sees what the library was handed, so it checks the bound from outside.
// Where no head or tail is an exact copy (as in every case below that asserts
// it), the sum is what is charged. The time guard is a backstop only: the units
// are what bound the work, and they were measured at about 0.2 µs each at worst.
const WORK_BUDGET = 20_000_000
const TIME_GUARD = 15_000

function timed<T>(fn: () => T): { out: T; ms: number; work: number } {
  spies.match.mockClear()
  spies.makeDiff.mockClear()
  const started = Date.now()
  const out = fn()
  const ms = Date.now() - started
  let work = 0
  for (const c of spies.match.mock.calls as unknown[][]) work += (c[1] as string).length
  for (const c of spies.makeDiff.mock.calls as unknown[][]) work += Math.ceil(((c[1] as string).length * (c[2] as string).length) / 16)
  return { out, ms, work }
}

describe('the work budget', () => {
  const SYLLABLES = ['ba', 'ro', 'ki', 'tu', 'me', 'la', 'sho', 'vin', 'dre', 'pol', 'gar', 'nex', 'fil', 'zon', 'cra', 'hep', 'wul', 'jod', 'qua', 'bri']
  // Hashed, so that no two passages of a hundred share their words: passages
  // alike but for their numbers are a different case (the first one wins).
  const word = (i: number, k: number) => {
    const h = (Math.imul(i + 1, 2654435761) ^ Math.imul(k + 1, 40503)) >>> 0
    return SYLLABLES[h % 20] + SYLLABLES[Math.floor(h / 20) % 20] + SYLLABLES[Math.floor(h / 400) % 20]
  }
  /** Invented words of about `n` characters, different for each `i` and `salt`. */
  const words = (i: number, salt: number, n: number) => {
    const out: string[] = []
    let len = 0
    for (let k = 0; len < n; k++) { const w = word(i * 31 + salt, k * 7 + salt); out.push(w); len += w.length + 1 }
    return out.join(' ')
  }
  const passage = (i: number) => `The ${word(i, 0)} ${word(i, 1)} of district ${i} shall publish the ${word(i, 2)} report about ${word(i, 3)} box ${i * 7} to every ${word(i, 4)} ${word(i, 5)} each quarter.`
  const background = (i: number, k: number) => `Background sentence ${i}-${k} that says nothing in particular.`
  const filler = (i: number, sentences: number) => Array.from({ length: sentences }, (_, k) => background(i, k)).join(' ')
  /** `n` characters from `from` with every third one changed: about n/3 errors. */
  const garble = (s: string, from: number, n: number) => [...s].map((c, k) => (k >= from && k < from + n && (k - from) % 3 === 1 && c !== ' ' ? (c === 'q' ? 'z' : 'q') : c)).join('')
  const claims = Array.from({ length: 100 }, (_, i) => `Claim ${i} is made.`)
  const summary = claims.join(' ')
  const ABSENT = (i: number) => `Nobody shall ever install an obelisk number ${i} in any rotunda, by order of the herons of the commonwealth.`

  it('hands a search near a place only the text it can reach, not the whole document', () => {
    const doc = `${filler(0, 18000)}\n${withLineNumbers(passage(3), 46)}\n${filler(1, 20)}`
    expect(doc.length).toBeGreaterThan(1_000_000)
    const { out } = timed(() => resolveClaimSources([{ claim: claims[0], quote: passage(3) }], summary, doc))
    expect(out.items[0].status).toBe('fuzzy')
    const handed = (spies.match.mock.calls as unknown[][]).map(c => (c[1] as string).length)
    // The head is searched for in the whole document, and the tail only near
    // where it would be after the head.
    expect(handed.filter(n => n > 10_000)).toHaveLength(1)
    expect(handed.length).toBeGreaterThan(1)
    for (const n of handed.filter(n => n <= 10_000)) expect(n).toBeLessThan(4000)
  })

  it('bounds a hundred quotes whose heads and tails each differ in about nine places, in about a million characters', () => {
    const parts: string[] = []
    const items: ClaimSource[] = []
    for (let i = 0; i < 100; i++) {
      const p = passage(i)
      parts.push(filler(i, 172), p)
      const quote = `${p.slice(0, 40)} ${words(i, 1, 100)} ${p.slice(-40)}`
      items.push({ claim: claims[i], quote: garble(garble(quote, 0, 27), quote.length - 27, 27) })
    }
    const doc = parts.join('\n')
    expect(doc.length).toBeGreaterThan(990_000)
    const { out, ms, work } = timed(() => resolveClaimSources(items, summary, doc))
    expect(out.items.every(i => i.status === 'anchored' || i.status === 'ungrounded')).toBe(true)
    expect(work).toBeLessThanOrEqual(WORK_BUDGET)
    expect(ms).toBeLessThan(TIME_GUARD)
  }, 120_000)

  it('bounds a hundred long quotes whose ends are found and whose middles are not, by what makeDiff is handed too', () => {
    const parts: string[] = []
    const items: ClaimSource[] = []
    for (let i = 0; i < 100; i++) {
      const head = `Passage ${i} begins ${words(i, 2, 50)}`
      const tail = `${words(i, 3, 50)} and passage ${i} ends.`
      parts.push(words(i, 4, 200), head, words(i, 5, 1800), tail)
      // One changed character at each end, so neither is an exact copy.
      items.push({ claim: claims[i], quote: `${garble(head, 20, 3)} ${words(i, 6, 1800)} ${tail.replace(/ends\.$/, 'endz.')}` })
    }
    const doc = parts.join(' ')
    expect(doc.length).toBeGreaterThan(200_000)
    expect(items.every(i => i.quote.length < 2000 && i.quote.length > 1850)).toBe(true)
    const { out, ms, work } = timed(() => resolveClaimSources(items, summary, doc))
    expect(out.items.every(i => i.status === 'anchored' || i.status === 'ungrounded')).toBe(true)
    expect(work).toBeLessThanOrEqual(WORK_BUDGET)
    expect(ms).toBeLessThan(TIME_GUARD)
  }, 120_000)

  it('searches the cheapest quotes first, so twenty absent ones ahead of eighty valid ones in 1.7 million characters take none of their links', () => {
    const parts: string[] = []
    for (let i = 0; i < 80; i++) parts.push(filler(i, 370), withLineNumbers(passage(i), 46))
    const doc = parts.join('\n')
    expect(doc.length).toBeGreaterThan(1_700_000)
    // After the absent ones, by fours: exact, normalized (doubled spaces), and
    // two faithful copies broken by line numbers in the document (fuzzy).
    const kind = (i: number) => (['exact', 'normalized', 'fuzzy', 'fuzzy'] as const)[i % 4]
    const items: ClaimSource[] = claims.map((claim, n) => {
      if (n < 20) return { claim, quote: ABSENT(n) }
      const i = n - 20
      const quote = kind(i) === 'exact' ? background(i, 5) : kind(i) === 'normalized' ? background(i, 6).replace(/ /g, '  ') : passage(i)
      return { claim, quote }
    })
    const { out, ms } = timed(() => resolveClaimSources(items, summary, doc))
    expect(out.items.slice(0, 20).map(i => i.status)).toEqual(Array(20).fill('ungrounded'))
    expect(out.items.slice(20).map(i => i.status)).toEqual(Array.from({ length: 80 }, (_, i) => kind(i)))
    expect(out.unsearched).toBeGreaterThan(0)
    expect(ms).toBeLessThan(TIME_GUARD)
  }, 120_000)

  it('resolves every one of a hundred findable quotes, exact, normalized, and fuzzy, in a typical document of about 90,000 characters', () => {
    const parts: string[] = []
    for (let i = 0; i < 100; i++) parts.push(filler(i, 13), withLineNumbers(passage(i), 46))
    const doc = parts.join('\n')
    expect(doc.length).toBeGreaterThan(85_000)
    expect(doc.length).toBeLessThan(100_000)
    // By fives: exact; normalized; fuzzy (line numbers); fuzzy with a typo too;
    // and a longer fuzzy quote that runs from the background into the passage.
    const kinds = ['exact', 'normalized', 'fuzzy', 'fuzzy', 'fuzzy'] as const
    const items: ClaimSource[] = claims.map((claim, i) => {
      const quote = [
        background(i, 3),
        background(i, 4).replace(/ /g, '  '),
        passage(i),
        passage(i).replace('publish', 'publsh'),
        `${Array.from({ length: 7 }, (_, k) => background(i, 6 + k)).join(' ')} ${passage(i)}`,
      ][i % 5]
      return { claim, quote }
    })
    expect(items[4].quote.length).toBeGreaterThan(500)
    const { out, ms } = timed(() => resolveClaimSources(items, summary, doc))
    expect(out.items.map(i => i.status)).toEqual(Array.from({ length: 100 }, (_, i) => kinds[i % 5]))
    expect(out.unsearched).toBe(0)
    expect(ms).toBeLessThan(TIME_GUARD)
  }, 120_000)

  it('bounds a document in a script above U+00FF as it bounds Latin text, though each character costs about three times as much', () => {
    // Invented words in two scripts, the same shape: 100 absent quotes against
    // about 2 million characters. `match` costs about 2.8 times as much a
    // character on Cyrillic text as on Latin (measured), so it must be handed
    // at most the budget over that, and finish in about the Latin time.
    const LATIN = ['ba', 'ro', 'ki', 'tu', 'me', 'la', 'sho', 'vin', 'dre', 'pol', 'gar', 'nex', 'fil', 'zon', 'cra', 'hep', 'wul', 'jod', 'qua', 'bri']
    const CYRILLIC = ['ба', 'ро', 'ки', 'ту', 'ме', 'ла', 'шо', 'вин', 'дре', 'пол', 'гар', 'нех', 'фил', 'зон', 'кра', 'хеп', 'вул', 'жод', 'ква', 'бри']
    const doc = (syl: string[]) => {
      const out: string[] = []
      let len = 0
      for (let k = 0; len < 2_000_000; k++) {
        const h = Math.imul(k + 1, 2654435761) >>> 0
        const w = syl[h % 20] + syl[Math.floor(h / 20) % 20] + syl[Math.floor(h / 400) % 20]
        out.push(w)
        len += w.length + 1
      }
      return out.join(' ')
    }
    // Each word of an absent quote ends in letters no word of the document has.
    const absent = (syl: string[], marker: string, i: number) => Array.from({ length: 14 }, (_, k) => syl[(i * 7 + k * 3) % 20] + syl[(i + k * 11) % 20] + marker).join(' ')
    const run = (syl: string[], marker: string) => {
      const text = doc(syl)
      return { text, ...timed(() => resolveClaimSources(claims.map((claim, i) => ({ claim, quote: absent(syl, marker, i) })), summary, text)) }
    }
    const latin = run(LATIN, 'xq')
    const cyrillic = run(CYRILLIC, 'щы')
    for (const r of [latin, cyrillic]) {
      expect(r.text.length).toBeGreaterThanOrEqual(1_999_999)
      expect(r.out.items.every(i => i.status === 'ungrounded')).toBe(true)
      expect(r.out.unsearched).toBeGreaterThan(0)
      expect(r.ms).toBeLessThan(TIME_GUARD)
    }
    expect(cyrillic.work).toBeLessThanOrEqual(WORK_BUDGET / 2.8)
    expect(cyrillic.ms).toBeLessThan(latin.ms * 1.6 + 1000)
  }, 180_000)
})
