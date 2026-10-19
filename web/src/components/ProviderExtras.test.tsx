import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { BillExtraField } from '../../../shared/providerExtras'
import { placeExtras, ExtraMetaItem, ExtraDetailList, ExtraFlagItem } from './ProviderExtras'

const f = (key: string, over: Partial<BillExtraField> = {}): BillExtraField =>
  ({ key, label: `Label ${key}`, explainer: null, display: 'text', value: `value ${key}`, ...over })
const keys = (fields: BillExtraField[]) => fields.map(x => x.key)

describe('placeExtras', () => {
  it('sorts each field by its placement, keeping the order it was sent in within each place', () => {
    const placed = placeExtras([
      f('a', { placement: 'meta' }), f('b', { placement: 'panel' }), f('c', { placement: 'detail' }),
      f('d', { placement: 'flag', value: 'Yes' }), f('e', { placement: 'meta' }), f('g', { placement: 'panel' }),
    ])
    expect(keys(placed.meta)).toEqual(['a', 'e'])
    expect(keys(placed.detail)).toEqual(['c'])
    expect(keys(placed.flags)).toEqual(['d'])
    expect(keys(placed.panel)).toEqual(['b', 'g'])
  })

  it('puts a field with no placement in the panel, as central did before placements', () => {
    const placed = placeExtras([f('a'), f('b')])
    expect(keys(placed.panel)).toEqual(['a', 'b'])
    expect([placed.meta, placed.detail, placed.flags].every(x => x.length === 0)).toBe(true)
  })

  it('puts a field with a placement it does not know in the panel, so a newer central never hides a value', () => {
    const placed = placeExtras([f('a', { placement: 'banner' as never }), f('b', { placement: null as never })])
    expect(keys(placed.panel)).toEqual(['a', 'b'])
  })

  it('makes a flag with any value but "Yes" a meta item, in its place among the meta items', () => {
    const placed = placeExtras([f('a', { placement: 'meta' }), f('b', { placement: 'flag', value: 'No' }), f('c', { placement: 'flag', value: 'Yes' }), f('d', { placement: 'flag', value: 'yes' })])
    expect(keys(placed.flags)).toEqual(['c'])
    expect(keys(placed.meta)).toEqual(['a', 'b', 'd'])
  })

  it('shows each field in exactly one place', () => {
    const all = [f('a', { placement: 'meta' }), f('b', { placement: 'detail' }), f('c', { placement: 'flag', value: 'Yes' }), f('d', { placement: 'flag', value: 'Maybe' }), f('e'), f('g', { placement: 'zzz' as never })]
    const placed = placeExtras(all)
    const shown = [...placed.meta, ...placed.detail, ...placed.flags, ...placed.panel].map(x => x.key).sort()
    expect(shown).toEqual(['a', 'b', 'c', 'd', 'e', 'g'])
  })

  it('drops a date that is the placeholder, wherever it would go', () => {
    const placed = placeExtras([
      f('a', { placement: 'meta', display: 'date', value: '0000-00-00' }), f('b', { placement: 'detail', display: 'date', value: '0000-00-00' }),
      f('c', { display: 'date', value: '0000-00-00' }), f('d', { placement: 'meta', display: 'date', value: '2026-06-01' }),
    ])
    expect(keys(placed.meta)).toEqual(['d'])
    expect(placed.detail).toEqual([])
    expect(placed.panel).toEqual([])
  })
})

describe('ExtraMetaItem', () => {
  it('reads "Label: value", with an identifier one click from selected', () => {
    render(<ExtraMetaItem field={f('n', { label: 'Act number', display: 'identifier', value: 'A26-0309' })} />)
    expect(screen.getByTestId('extra-meta-n')).toHaveTextContent('Act number: A26-0309')
    expect(screen.getByText('A26-0309')).toHaveStyle({ userSelect: 'all' })
  })

  it('shows a date as written, and a link as a link', () => {
    render(<>
      <ExtraMetaItem field={f('d', { display: 'date', value: '2026-06-01' })} />
      <ExtraMetaItem field={f('l', { display: 'link', value: 'https://legislature.example/x' })} />
    </>)
    expect(screen.getByTestId('extra-meta-d')).toHaveTextContent('Label d: 2026-06-01')
    expect(screen.getByRole('link', { name: /legislature\.example/ })).toHaveAttribute('href', 'https://legislature.example/x')
  })

  it('explains itself on hover and on click of its label', async () => {
    render(<ExtraMetaItem field={f('n', { label: 'Act number', explainer: 'What the act is called.' })} />)
    const label = screen.getByRole('button', { name: 'Act number' })
    expect(label).toHaveAccessibleDescription('What the act is called.')
    fireEvent.pointerEnter(label, { pointerType: 'mouse' })
    await waitFor(() => expect(screen.getAllByText('What the act is called.').some(el => el.style.position === 'fixed')).toBe(true))
  })

  it('wraps a long value rather than holding the row open, so a phone does not scroll sideways', () => {
    const long = 'Committee on Example Affairs, '.repeat(9).trim()
    render(<ExtraMetaItem field={f('c', { value: long })} />)
    const item = screen.getByTestId('extra-meta-c')
    expect(item.style.whiteSpace).not.toBe('nowrap')
    expect(item).toHaveStyle({ overflowWrap: 'anywhere', minWidth: '0', maxWidth: '100%' })
    expect(screen.getByText(long)).toHaveStyle({ overflowWrap: 'anywhere' })
  })
})

describe('ExtraDetailList', () => {
  it('lists each field full width, labeled, with line breaks kept and long values wrapping', () => {
    const value = 'Example Article §§ 1-101, 1-102\nOther Article § 2-201'
    render(<ExtraDetailList fields={[f('s', { label: 'Statutes affected', value, placement: 'detail' })]} />)
    const list = screen.getByTestId('extras-detail')
    expect(list).toHaveTextContent('Statutes affected')
    expect(list).toHaveStyle({ width: '100%' })
    const v = screen.getByText(/Example Article/)
    expect(v).toHaveStyle({ whiteSpace: 'pre-line', overflowWrap: 'anywhere' })
    expect(v.textContent).toBe(value)
  })

  it('renders nothing for no fields', () => {
    const { container } = render(<ExtraDetailList fields={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('explains a label on click', () => {
    render(<ExtraDetailList fields={[f('s', { label: 'Statutes affected', explainer: 'The articles it changes.' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Statutes affected' }))
    expect(screen.getAllByText('The articles it changes.').some(el => el.style.position === 'fixed')).toBe(true)
  })
})

describe('ExtraFlagItem', () => {
  it('shows the flag as its label alone, with no "Yes" and no "Label:" colon', () => {
    render(<ExtraFlagItem field={f('e', { label: 'Emergency bill', value: 'Yes', placement: 'flag' })} />)
    const item = screen.getByTestId('extra-flag-e')
    expect(item).toHaveTextContent(/^Emergency bill$/)
    expect(screen.queryByText(/Yes/)).toBeNull()
  })

  it('takes the same muted label style as a meta item, with no chip color, background, or padding', () => {
    render(<>
      <ExtraMetaItem field={f('m', { label: 'Chapter', value: 'Chapter 5' })} />
      <ExtraFlagItem field={f('e', { label: 'Emergency bill', value: 'Yes', placement: 'flag' })} />
    </>)
    const metaLabel = screen.getByTestId('extra-meta-m').firstElementChild as HTMLElement
    const flag = screen.getByTestId('extra-flag-e')
    expect(flag.style.color).toBe(metaLabel.style.color)
    expect(flag.style.background).toBe('')
    expect(flag.style.backgroundColor).toBe('')
    expect(flag.style.padding).toBe('')
    expect(flag.style.borderRadius).toBe('')
    expect(flag.style.fontWeight).toBe('')
  })

  it('wraps a long label rather than holding the row open', () => {
    render(<ExtraFlagItem field={f('e', { label: 'A'.repeat(200), value: 'Yes' })} />)
    expect(screen.getByTestId('extra-flag-e')).toHaveStyle({ minWidth: '0', maxWidth: '100%', overflowWrap: 'anywhere' })
  })

  it('explains the flag on hover of its label', () => {
    render(<ExtraFlagItem field={f('e', { label: 'Emergency bill', value: 'Yes', explainer: 'Takes effect at once.' })} />)
    const label = screen.getByRole('button', { name: 'Emergency bill' })
    expect(label).toHaveAccessibleDescription('Takes effect at once.')
  })

  it('shows a label with no explainer as plain text, not a button', () => {
    render(<ExtraFlagItem field={f('e', { label: 'Emergency bill', value: 'Yes', explainer: null })} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Emergency bill')).toBeInTheDocument()
  })
})
