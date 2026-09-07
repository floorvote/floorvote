import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import TagTaxonomyTable from './TagTaxonomyTable'
import type { TaxonomyRow } from './taxonomyRows'

/** Wrapper that owns the rows, the way Config.tsx will. */
function Harness({ initial, onRows }: { initial: TaxonomyRow[]; onRows?: (r: TaxonomyRow[]) => void }) {
  const [rows, setRows] = useState<TaxonomyRow[]>(initial)
  return (
    <TagTaxonomyTable
      rows={rows}
      idPrefix="t"
      onChange={next => { setRows(next); onRows?.(next) }}
    />
  )
}

const tagFields = () => screen.getAllByLabelText(/^Tag name, row/)

describe('TagTaxonomyTable', () => {
  it('renders a field per row plus one trailing blank', () => {
    render(<Harness initial={[{ name: 'Elections', description: '' }]} />)
    expect(tagFields()).toHaveLength(2)
    expect(tagFields()[0]).toHaveValue('Elections')
    expect(tagFields()[1]).toHaveValue('')
  })

  it('Return from the tag field opens a new row below', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Elections', description: '' }]} />)
    await user.click(tagFields()[0])
    await user.keyboard('{Enter}')
    expect(tagFields()).toHaveLength(3)
    expect(tagFields()[1]).toHaveFocus()
  })

  it('Backspace on a wholly empty row deletes it', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: '', description: '' },
    ]} />)
    await user.click(tagFields()[1])
    await user.keyboard('{Backspace}')
    expect(tagFields()).toHaveLength(2)
    expect(tagFields()[0]).toHaveFocus()
  })

  it('the + Add tag button lands the caret in an empty row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Elections', description: '' }]} />)
    await user.click(screen.getByRole('button', { name: /add tag/i }))
    // The trailing blank IS the empty row to type into, so the button focuses
    // it rather than manufacturing a second one beside it.
    expect(tagFields()).toHaveLength(2)
    expect(tagFields()[1]).toHaveFocus()
  })

  it('the + Add tag button appends a row when the last row is in use', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Elections', description: '' }]} />)
    // Fill the trailing blank so there is no empty row left to land in.
    await user.type(tagFields()[1], 'Housing')
    await user.click(screen.getByRole('button', { name: /add tag/i }))
    expect(tagFields()).toHaveLength(3)
    expect(tagFields()[2]).toHaveFocus()
  })

  it('repeated + Add tag clicks never stack up more than one blank row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Elections', description: '' }]} />)
    const add = screen.getByRole('button', { name: /add tag/i })
    await user.click(add)
    await user.click(add)
    // A surplus blank would not be the last index, so it would sprout a grip
    // and an ordinal and become reorderable — a "tag" that is not a tag.
    expect(tagFields().map(f => (f as HTMLInputElement).value)).toEqual(['Elections', ''])
  })

  it('two consecutive Returns in the trailing blank row never produce more than one blank row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Elections', description: '' }]} />)
    // displayed is [Elections, <blank>]; focus the trailing blank.
    await user.click(tagFields()[1])
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')
    // A surplus blank would not be the last index, so it would sprout a grip
    // and an ordinal and become reorderable — the same harm the "+ Add tag"
    // fix already addressed, reached here by keyboard instead.
    expect(tagFields().map(f => (f as HTMLInputElement).value)).toEqual(['Elections', ''])
  })

  it('the delete button removes its row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    await user.click(screen.getByRole('button', { name: 'Delete row 1' }))
    expect(tagFields()[0]).toHaveValue('Housing')
  })

  it('names a duplicate in the cell that has it, on every colliding row', () => {
    render(<Harness initial={[
      { name: 'Elections', description: 'voting' },
      { name: 'Housing', description: '' },
      { name: 'elections', description: 'local admin' },
    ]} />)
    expect(screen.getAllByText('Duplicate')).toHaveLength(2)
    expect(tagFields()[0]).toHaveAttribute('aria-invalid', 'true')
    expect(tagFields()[1]).not.toHaveAttribute('aria-invalid')
  })

  it('describes the flagged field with its own message', () => {
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Elections', description: '' },
    ]} />)
    const describedBy = tagFields()[0].getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent('Duplicate')
  })

  it('raises "Needs a name" when a description is typed into a nameless row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: '', description: '' }]} />)
    expect(screen.queryByText('Needs a name')).not.toBeInTheDocument()
    await user.type(screen.getAllByLabelText(/^Description, row/)[0], 'broadband')
    expect(screen.getByText('Needs a name')).toBeInTheDocument()
  })

  it('shows no warning on a wholly empty row', () => {
    render(<Harness initial={[{ name: '', description: '' }]} />)
    expect(screen.queryByText('Needs a name')).not.toBeInTheDocument()
    expect(screen.queryByText('Duplicate')).not.toBeInTheDocument()
  })

  it('Tab crosses Tag then Description then the next row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    await user.click(tagFields()[0])
    await user.tab()
    expect(screen.getAllByLabelText(/^Description, row/)[0]).toHaveFocus()
    await user.tab()
    // The delete button sits between the description and the next row's tag.
    await user.tab()
    expect(tagFields()[1]).toHaveFocus()
  })

  it('reports edits through onChange', async () => {
    const user = userEvent.setup()
    const onRows = vi.fn()
    render(<Harness initial={[{ name: '', description: '' }]} onRows={onRows} />)
    await user.type(tagFields()[0], 'Courts')
    expect(onRows).toHaveBeenCalled()
    expect(onRows.mock.calls[onRows.mock.calls.length - 1][0][0].name).toBe('Courts')
  })

  it('grows the description textarea to fit its value on first render, without any input event', () => {
    const longDescription =
      'This is a long, wrapping description that spans several lines of text so that a ' +
      'single default row of height would clip most of it from view unless the textarea ' +
      'grows to fit the content as soon as it is mounted, before the user ever types.'
    render(<Harness initial={[{ name: 'Elections', description: longDescription }]} />)
    const textarea = screen.getAllByLabelText(/^Description, row/)[0] as HTMLTextAreaElement
    // jsdom always reports scrollHeight as 0, so this can't check a real pixel
    // value — it checks that the mount-time effect actually assigned an inline
    // height at all, rather than leaving the browser default (an empty string).
    expect(textarea.style.height).not.toBe('')
    expect(textarea.style.height).toMatch(/^\d+(\.\d+)?px$/)
  })

  it('recomputes every textarea height when a row is split, even though the joined dependency string is unchanged', () => {
    // The invariant: the resize effect's dependency must preserve the SHAPE of
    // the description array, not just its concatenated characters. A one-row
    // description "P<SEP>Q" and a two-row split into "P" / "Q" flatten to the
    // same text, so any dependency built by joining descriptions on a single
    // character fails to distinguish them for whichever character it picks —
    // and then a split, insert, or delete across that boundary leaves stale
    // textarea heights with no re-render to fix them. SEP is an ordinary
    // space: nothing here depends on matching the component's internals,
    // because a shape-preserving dependency (JSON.stringify) collides for no
    // separator at all.
    const SEP = ' '
    const onChange = vi.fn()
    const { rerender } = render(
      <TagTaxonomyTable
        rows={[{ name: 'A', description: `P${SEP}Q` }]}
        onChange={onChange}
        idPrefix="t"
      />,
    )
    const textareas = () => screen.getAllByLabelText(/^Description, row/) as HTMLTextAreaElement[]

    // Clear the heights the mount-time effect set, so we can tell whether the
    // effect runs again (and reassigns them) after the rerender below.
    textareas().forEach(ta => { ta.style.height = '' })

    rerender(
      <TagTaxonomyTable
        rows={[{ name: 'A', description: 'P' }, { name: 'B', description: 'Q' }]}
        onChange={onChange}
        idPrefix="t"
      />,
    )

    // The single row was split into two — every description actually
    // changed — so the resize effect must have run again and reassigned
    // every textarea's height.
    textareas().forEach(ta => expect(ta.style.height).not.toBe(''))
  })
})

describe('TagTaxonomyTable — narrow layout', () => {
  // jsdom never evaluates @media queries or computes layout, so nothing here
  // can assert that rows actually stack at 375px. What this pins instead is
  // the contract between the markup and web/src/styles/mobile.css's narrow
  // rules for `.tag-table`: that the class hooks the stylesheet selects on
  // are present, on the elements the stylesheet's selectors expect, in the
  // structural positions those selectors rely on (".tag-table > div" for
  // each grid row, "> :nth-child(2)" landing on the Tag column in both the
  // header and body rows, and every row's leading cell — header, real row,
  // and trailing blank alike — carrying `.tag-table-reorder` so all three
  // are removed from grid placement the same way). If a future edit renames
  // a class, reorders the columns, wraps a row in an extra element, or
  // reintroduces an unhidden leading placeholder, this test breaks even
  // though jsdom can't see the resulting visual layout.
  it('exposes the class hooks mobile.css targets, on the elements and positions its selectors expect', () => {
    render(<Harness initial={[{ name: 'Elections', description: 'voting' }]} />)

    // `.tag-table` is the outer bordered div the stylesheet scopes off of.
    const table = document.querySelector('.tag-table')
    expect(table).toBeInTheDocument()

    // `.tag-table > div` must match one row per grid row (header + each
    // displayed row, including the trailing blank) — the selector the
    // narrow-width rule uses to collapse each row's grid-template-columns.
    const rows = table!.querySelectorAll(':scope > div')
    expect(rows.length).toBe(3) // header + Elections row + trailing blank

    // `.tag-table > div > :nth-child(2)` must land on the Tag column in
    // every row so the narrow rule can span it full-width. In the header
    // that's the "Tag" label; in a body row it's the div wrapping the name
    // input.
    const headerSecondChild = rows[0].children[1]
    expect(headerSecondChild).toHaveTextContent('Tag')

    const bodyRowSecondChild = rows[1].children[1]
    expect(bodyRowSecondChild.querySelector('input[aria-label^="Tag name"]')).toBeInTheDocument()

    // `.tag-table-reorder` must sit on the grip/ordinal cell the narrow rule
    // hides — and only on that cell, not on the whole row, or hiding it
    // would take the Tag/Description columns down with it. (The class is no
    // longer unique to this cell — see below — so scope the query to the
    // real row rather than using the first document-wide match.)
    const reorderCell = rows[1].children[0]
    expect(reorderCell).toHaveClass('tag-table-reorder')
    expect(reorderCell?.textContent).toContain('⠿')

    // The header's leading placeholder and the trailing blank row's leading
    // placeholder must carry the same class as the real grip: `display:
    // none` removes a grid item from placement entirely, so if either of
    // these is missing the class it keeps claiming column 1 of row 1 and
    // grid auto-placement pushes the rest of that row into a broken
    // three-row stack instead of matching the two-row shape every other row
    // gets. All three leading cells — header, real row, trailing row — must
    // stack identically.
    expect(rows[0].children[0]).toHaveClass('tag-table-reorder')
    expect(rows[2].children[0]).toHaveClass('tag-table-reorder')
    expect(document.querySelectorAll('.tag-table-reorder')).toHaveLength(3)
  })
})

describe('TagTaxonomyTable — reordering', () => {
  it('Alt+ArrowDown moves the focused row down', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    await user.click(tagFields()[0])
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(tagFields()[0]).toHaveValue('Housing')
    expect(tagFields()[1]).toHaveValue('Elections')
  })

  it('Alt+ArrowUp moves the focused row up', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    await user.click(tagFields()[1])
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(tagFields()[0]).toHaveValue('Housing')
  })

  it('does nothing at the ends of the list', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Elections', description: '' }]} />)
    await user.click(tagFields()[0])
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(tagFields()[0]).toHaveValue('Elections')
  })

  it('announces the new position in a live region', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    await user.click(tagFields()[0])
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    // Two tags, so "of 2" — the trailing blank is not a tag, carries no
    // ordinal, and cannot be moved onto, so counting it would announce a
    // position the visible ordinals never show.
    expect(screen.getByRole('status')).toHaveTextContent('Elections moved to position 2 of 2')
  })

  it('returns focus to the column the move was initiated from', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: 'voting' },
      { name: 'Housing', description: 'zoning' },
    ]} />)
    const descriptions = () => screen.getAllByLabelText(/^Description, row/)
    await user.click(descriptions()[0])
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    // Elections is now row 2; focus must still be in the description column,
    // not thrown back to the name field a Tab away.
    expect(descriptions()[1]).toHaveFocus()
    expect(descriptions()[1]).toHaveValue('voting')
  })

  it('accepts a drop anywhere on the destination row, not only on its 34px grip', () => {
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
      { name: 'Courts', description: '' },
    ]} />)
    // .tag-table > div is the header followed by one div per displayed row.
    const gridRows = document.querySelectorAll('.tag-table > div')
    const courtsGrip = gridRows[3].children[0]

    fireEvent.dragStart(courtsGrip)

    // The whole row must advertise itself as a drop target: without a
    // preventDefault on dragover the browser shows "no drop allowed" over the
    // ~90% of the row that is not the grip. fireEvent returns false when the
    // event was cancelled.
    expect(fireEvent.dragOver(tagFields()[0])).toBe(false)

    // Release over row 1's NAME FIELD — the visible bulk of the row — rather
    // than its grip.
    fireEvent.drop(tagFields()[0])

    expect(tagFields().map(f => (f as HTMLInputElement).value))
      .toEqual(['Courts', 'Elections', 'Housing', ''])
  })

  it('leaves an ordinary drag (no reorder in progress) entirely to the browser', () => {
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    // No dragStart fired on any grip first, so dragFrom is null — this drag
    // did not originate from the reorder grip (e.g. the user selected text
    // elsewhere on the page and is dragging it toward a description
    // textarea). The row must not call preventDefault in that case, or the
    // browser's native "insert at caret" drop behavior breaks. fireEvent
    // returns true when the event was NOT cancelled.
    expect(fireEvent.dragOver(tagFields()[0])).toBe(true)
  })

  it('numbers every row', () => {
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('the trailing blank row cannot be moved with Alt+ArrowUp', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    // displayed is [Elections, Housing, <blank>] — focus the blank at the end.
    const fields = tagFields()
    expect(fields).toHaveLength(3)
    await user.click(fields[2])
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    const after = tagFields()
    expect(after).toHaveLength(3)
    expect(after[0]).toHaveValue('Elections')
    expect(after[1]).toHaveValue('Housing')
    expect(after[2]).toHaveValue('')
  })

  it('moving the last real row down does not push it past the trailing blank', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ]} />)
    // displayed is [Elections, Housing, <blank>] — Housing is the last real row.
    const fields = tagFields()
    expect(fields).toHaveLength(3)
    await user.click(fields[1])
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    const after = tagFields()
    expect(after).toHaveLength(3)
    expect(after[0]).toHaveValue('Elections')
    expect(after[1]).toHaveValue('Housing')
    expect(after[2]).toHaveValue('')
  })
})

describe('TagTaxonomyTable — paste', () => {
  it('fills the table from a pasted two-column list, replacing the empty row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: '', description: '' }]} />)
    await user.click(tagFields()[0])
    await user.paste('Elections\tvoting\nHousing\tzoning')
    expect(tagFields()[0]).toHaveValue('Elections')
    expect(tagFields()[1]).toHaveValue('Housing')
    expect(screen.getAllByLabelText(/^Description, row/)[0]).toHaveValue('voting')
  })

  it('inserts after a row that already has content', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Courts', description: '' }]} />)
    await user.click(tagFields()[0])
    await user.paste('Elections\nHousing')
    expect(tagFields().map(f => (f as HTMLInputElement).value).slice(0, 3))
      .toEqual(['Courts', 'Elections', 'Housing'])
  })

  it('leaves a single-line paste to the browser, inserting at the caret rather than replacing the row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: '', description: '' }]} />)
    await user.click(tagFields()[0])
    await user.type(tagFields()[0], 'Elec')
    // Caret is at the end of "Elec" after typing. A single-line paste with no
    // tab or newline must be inserted there by the browser, not intercepted
    // and spliced in as a new row — which would silently drop the "Elec"
    // the user already typed and leave a stray extra row behind.
    await user.paste('tions')
    expect(tagFields()).toHaveLength(2)
    expect(tagFields()[0]).toHaveValue('Elections')
  })
})
