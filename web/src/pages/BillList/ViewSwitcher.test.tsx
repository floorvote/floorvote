import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { ViewSwitcher, type SavedView } from './ViewSwitcher'
import * as api from '../../lib/api'

// Mutable so a test can opt into a demo tenant. Defaults match a settled,
// non-demo tenant — the common case for every other test in this file.
const demoState = vi.hoisted(() => ({ demoMode: false, settled: true }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: demoState.demoMode, demoLocked: false, settled: demoState.settled }),
}))

const VIEWS: SavedView[] = [
  { id: 'v1', name: 'Clerk bills', query: 'subject=UT%3AElections' },
  { id: 'v2', name: 'Auditor bills', query: 'subject=UT%3AAudits' },
]

function renderSwitcher(over: Partial<Parameters<typeof ViewSwitcher>[0]> = {}) {
  const onApply = vi.fn()
  const onRename = vi.fn()
  const onDelete = vi.fn()
  const onReorder = vi.fn()
  const onOverwrite = vi.fn()
  const utils = render(
    <ViewSwitcher
      views={VIEWS}
      currentSearch=""
      isAdmin={false}
      onApply={onApply}
      onRename={onRename}
      onDelete={onDelete}
      onReorder={onReorder}
      onOverwrite={onOverwrite}
      {...over}
    />,
  )
  return { ...utils, onApply, onRename, onDelete, onReorder, onOverwrite }
}

// Fires a native-drag-event sequence (dragstart on the handle, dragover +
// drop on the target row) the way jsdom's fireEvent expects: a real browser
// drag populates DataTransfer automatically, jsdom does not, so a bare
// object standing in for it is passed through and read back by the
// component's own handlers.
// The grip's accessible name names the view and then the shortcut it offers
// ("Reorder Alpha view. Press Alt with the up or down arrow keys."), so it is
// matched by prefix rather than by the bare exact name it used to carry.
function gripFor(name: string) {
  return screen.getByLabelText(new RegExp(`^Reorder ${name}\\.`))
}

function fakeDataTransfer() {
  let stored = ''
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (_type: string, value: string) => { stored = value },
    getData: () => stored,
  }
}

function dragRow(fromEl: Element, toEl: Element) {
  const dataTransfer = fakeDataTransfer()
  fireEvent.dragStart(fromEl, { dataTransfer })
  fireEvent.dragOver(toEl, { dataTransfer })
  fireEvent.drop(toEl, { dataTransfer })
  fireEvent.dragEnd(fromEl, { dataTransfer })
}

describe('ViewSwitcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    demoState.demoMode = false
    demoState.settled = true
  })

  it('does not fetch match counts before the menu is opened', () => {
    const spy = vi.spyOn(api, 'apiFetch')
    renderSwitcher()
    expect(spy).not.toHaveBeenCalled()
  })

  it('fetches and renders match counts after opening the menu', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockImplementation(async (path) => {
      const p = String(path)
      if (p.includes('subject=UT%3AAudits')) return { pagination: { total: 7 } } as never
      if (p.includes('subject=UT%3AElections')) return { pagination: { total: 42 } } as never
      return { pagination: { total: 100 } } as never // "All bills" — no filter params
    })
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: /views/i }))

    // A minimal-page-size /bills request per row: one for "All bills", one per view.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3))
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\/bills\?page=1&pageSize=1$/))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('subject=UT%3AElections'))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('subject=UT%3AAudits'))

    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument())
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('renders a failed count as no number, not 0', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path) => {
      if (String(path).includes('subject=UT%3AAudits')) throw new Error('boom')
      return { pagination: { total: 42 } } as never
    })
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: /views/i }))

    await waitFor(() => expect(screen.getAllByText('42').length).toBeGreaterThan(0))
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('renders nothing when no views exist', () => {
    const { container } = renderSwitcher({ views: [] })
    expect(container).toBeEmptyDOMElement()
  })

  it('reads "Views" when no view matches the current filters', () => {
    renderSwitcher({ currentSearch: '?status=1' })
    expect(screen.getByRole('button', { name: /views/i })).toBeTruthy()
  })

  it('names the active view when the filters match it', () => {
    renderSwitcher({ currentSearch: '?subject=UT%3AElections' })
    expect(screen.getByRole('button', { name: /clerk bills/i })).toBeTruthy()
  })

  it('falls back to "Views" once the filters diverge', () => {
    renderSwitcher({ currentSearch: '?subject=UT%3AElections&status=1' })
    expect(screen.queryByRole('button', { name: /clerk bills/i })).toBeNull()
    expect(screen.getByRole('button', { name: /views/i })).toBeTruthy()
  })

  it('applies a view when its row is chosen', () => {
    const { onApply } = renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.click(screen.getByText('Auditor bills'))
    expect(onApply).toHaveBeenCalledWith(VIEWS[1])
  })

  it('applies null when "All bills" is chosen', () => {
    const { onApply } = renderSwitcher({ currentSearch: '?subject=UT%3AElections' })
    fireEvent.click(screen.getByRole('button', { name: /clerk bills/i }))
    fireEvent.click(screen.getByText('All bills'))
    expect(onApply).toHaveBeenCalledWith(null)
  })

  it('shows no rename or delete affordance to a member', () => {
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('reaches Rename via focus alone, with no mouseEnter — keyboard/touch users have no other path', () => {
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    fireEvent.focus(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.getAllByRole('button', { name: /rename/i })[0]).toBeTruthy()
    fireEvent.blur(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
  })

  it('renames through an inline input for an admin', () => {
    const { onRename } = renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    fireEvent.click(screen.getAllByRole('button', { name: /rename/i })[0])
    const input = screen.getByLabelText('View name')
    fireEvent.change(input, { target: { value: 'County clerk bills' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onRename).toHaveBeenCalledWith('v1', 'County clerk bills')
  })

  it('keeps the rename input open when onRename rejects', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('boom'))
    renderSwitcher({ isAdmin: true, onRename })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    fireEvent.click(screen.getAllByRole('button', { name: /rename/i })[0])
    const input = screen.getByLabelText('View name')
    fireEvent.change(input, { target: { value: 'County clerk bills' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('v1', 'County clerk bills'))
    // The rejection must not close the row as though the rename succeeded —
    // the input stays open (and keeps the edited draft) so the user can see
    // the rename didn't take.
    expect(screen.getByLabelText('View name')).toBeTruthy()
    expect(screen.getByLabelText('View name')).toHaveValue('County clerk bills')
  })

  it('requires a confirm step before deleting, and says it affects everyone', () => {
    const { onDelete } = renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByText(/delete for everyone/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(onDelete).toHaveBeenCalledWith('v1')
  })

  it('offers rename, overwrite, and delete on the hovered row', () => {
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.getByRole('button', { name: /rename/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /replace this view's filters/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })

  it('confirms inline before overwriting, naming what is lost', () => {
    const { onOverwrite } = renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    fireEvent.click(screen.getByRole('button', { name: /replace this view's filters/i }))
    expect(screen.getByText(/Replace this view's filters with the current ones\?/)).toBeInTheDocument()
    expect(onOverwrite).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^replace$/i }))
    expect(onOverwrite).toHaveBeenCalledWith('v1')
  })

  it('places Rename and Delete before the count chip in the row', () => {
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    const row = screen.getByText('Clerk bills').closest('div')!
    fireEvent.mouseEnter(row)
    const rename = screen.getAllByRole('button', { name: /rename/i })[0]
    // The count badge renders '…' until its fetch resolves — this test never
    // awaits it, so the placeholder span is what DOM order is checked
    // against. It's the last <span> in the row; the buttons' wrapper <span>
    // comes first.
    const spans = row.querySelectorAll('span')
    const count = spans[spans.length - 1]
    expect(count.textContent).toBe('…')
    expect(rename.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('gives the menu a fixed width so revealing the buttons cannot widen it', () => {
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    const menu = screen.getByRole('group', { name: /saved views/i })
    const widthBefore = menu.style.width
    expect(widthBefore).not.toBe('')
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    expect(menu.style.width).toBe(widthBefore)
  })

  it('clears a stale hovered/focused row when the menu is reopened after applying a view', () => {
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.focus(screen.getByText('Auditor bills').closest('div')!)
    expect(screen.getAllByRole('button', { name: /rename/i }).length).toBeGreaterThan(0)

    // Applying the view closes the menu. In a real browser, focus on the
    // Rename button that unmounts underneath the click doesn't reliably blur
    // — this asserts the close-effect clears focusedId regardless, so a
    // reopen never inherits it.
    fireEvent.click(screen.getByText('Auditor bills'))
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
  })

  it('clears a stale hovered/focused row when the menu is reopened after choosing "All bills"', () => {
    renderSwitcher({ isAdmin: true, currentSearch: '?subject=UT%3AElections' })
    fireEvent.click(screen.getByRole('button', { name: /clerk bills/i }))
    // "Clerk bills" now appears twice — the trigger button (labeled with the
    // active view's name) and the row inside the open menu; the row is the
    // last match.
    const clerkTexts = screen.getAllByText('Clerk bills')
    fireEvent.focus(clerkTexts[clerkTexts.length - 1].closest('div')!)
    expect(screen.getAllByRole('button', { name: /rename/i }).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('All bills'))
    // onApply is mocked, so currentSearch (and thus the trigger's label)
    // doesn't change — reopen via the still-labeled "Clerk bills" trigger.
    fireEvent.click(screen.getByRole('button', { name: /clerk bills/i }))
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
  })

  it('hides Rename and Delete on a demo tenant even for an admin', () => {
    demoState.demoMode = true
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.focus(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('hides Rename and Delete before the demo config request settles', () => {
    demoState.settled = false
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.focus(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
  })

  it('still shows Rename and Delete to an admin on a settled non-demo tenant', () => {
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.focus(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.getAllByRole('button', { name: /rename/i }).length).toBeGreaterThan(0)
  })

  describe('drag-to-reorder', () => {
    it('does not render a grip for a member', () => {
      renderSwitcher({ isAdmin: false })
      fireEvent.click(screen.getByRole('button', { name: /views/i }))
      expect(screen.queryByLabelText(/reorder/i)).toBeNull()
    })

    it('does not render a grip on a demo tenant even for an admin', () => {
      demoState.demoMode = true
      renderSwitcher({ isAdmin: true })
      fireEvent.click(screen.getByRole('button', { name: /views/i }))
      expect(screen.queryByLabelText(/reorder/i)).toBeNull()
    })

    it('renders no grip on the "All bills" row', () => {
      renderSwitcher({ isAdmin: true })
      fireEvent.click(screen.getByRole('button', { name: /views/i }))
      const allBillsRow = screen.getByText('All bills').closest('button')!
      expect(allBillsRow.querySelector('[aria-label^="Reorder"]')).toBeNull()
    })

    it('does not render a grip for a row being renamed', () => {
      renderSwitcher({ isAdmin: true })
      fireEvent.click(screen.getByRole('button', { name: /views/i }))
      fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
      fireEvent.click(screen.getAllByRole('button', { name: /rename/i })[0])
      expect(screen.queryByLabelText(/^Reorder Clerk bills\./)).toBeNull()
      // The other row, not being renamed, still has its grip.
      expect(gripFor('Auditor bills')).toBeTruthy()
    })

    it('reorders a view via drag and calls onReorder with the new id order', () => {
      const { onReorder } = renderSwitcher({ isAdmin: true })
      fireEvent.click(screen.getByRole('button', { name: /views/i }))
      const fromGrip = gripFor('Auditor bills')
      const toRow = screen.getByText('Clerk bills').closest('div')!
      dragRow(fromGrip, toRow)
      expect(onReorder).toHaveBeenCalledWith(['v2', 'v1'])
    })

    // The same outcome matrix the tag table and custom fields carry, asserting
    // the resulting ORDER rather than counting indicator elements — counting is
    // what let two bugs survive here, because the line renders in the right
    // place and only the result is wrong.
    describe('outcomes', () => {
      const THREE: SavedView[] = [
        { id: 'a', name: 'Alpha view', query: '' },
        { id: 'b', name: 'Bravo view', query: '' },
        { id: 'c', name: 'Charlie view', query: '' },
      ]

      function open3() {
        const onReorder = vi.fn()
        render(
          <ViewSwitcher
            views={THREE}
            currentSearch=""
            isAdmin
            onApply={vi.fn()}
            onRename={vi.fn()}
            onDelete={vi.fn()}
            onReorder={onReorder}
            onOverwrite={vi.fn()}
          />,
        )
        fireEvent.click(screen.getByRole('button', { name: /views/i }))
        return { onReorder }
      }

      const menu = () => screen.getByRole('group', { name: 'Saved views' })
      const row = (name: string) => screen.getByText(name).closest('div')!
      /** The append-at-end zone: the last child of the menu. */
      const tail = () => menu().lastElementChild!

      function order() {
        return ['Alpha view', 'Bravo view', 'Charlie view']
          .map(n => ({ n, el: screen.getByText(n) }))
          .sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
          .map(x => x.n)
      }

      function drag(from: string, to: string | 'tail') {
        const dataTransfer = fakeDataTransfer()
        const target = to === 'tail' ? tail() : row(to)
        fireEvent.dragStart(gripFor(from), { dataTransfer })
        fireEvent.dragOver(target, { dataTransfer })
        fireEvent.drop(target, { dataTransfer })
        fireEvent.dragEnd(target, { dataTransfer })
      }

      it('drag Alpha, drop on Charlie inserts Alpha immediately before Charlie', () => {
        const { onReorder } = open3()
        drag('Alpha view', 'Charlie view')
        expect(order()).toEqual(['Bravo view', 'Alpha view', 'Charlie view'])
        expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c'])
      })

      it('drag Charlie, drop on Alpha inserts Charlie immediately before Alpha', () => {
        const { onReorder } = open3()
        drag('Charlie view', 'Alpha view')
        expect(order()).toEqual(['Charlie view', 'Alpha view', 'Bravo view'])
        expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b'])
      })

      it('drag Alpha, drop on the tail zone moves Alpha to the end', () => {
        const { onReorder } = open3()
        drag('Alpha view', 'tail')
        expect(order()).toEqual(['Bravo view', 'Charlie view', 'Alpha view'])
        expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a'])
      })

      it('drag Alpha, drop on Bravo changes nothing and calls nothing', () => {
        const { onReorder } = open3()
        drag('Alpha view', 'Bravo view')
        expect(order()).toEqual(['Alpha view', 'Bravo view', 'Charlie view'])
        expect(onReorder).not.toHaveBeenCalled()
      })

      it('drag Charlie, drop on the tail zone changes nothing and calls nothing', () => {
        const { onReorder } = open3()
        drag('Charlie view', 'tail')
        expect(order()).toEqual(['Alpha view', 'Bravo view', 'Charlie view'])
        expect(onReorder).not.toHaveBeenCalled()
      })

      it('dims the whole source row, not just its grip', () => {
        open3()
        const dataTransfer = fakeDataTransfer()
        fireEvent.dragStart(gripFor('Bravo view'), { dataTransfer })
        expect(row('Bravo view')).toHaveStyle({ opacity: '0.4' })
        expect(row('Alpha view')).toHaveStyle({ opacity: '1' })
        expect(gripFor('Bravo view')).toHaveStyle({ opacity: '1' })
      })

      // Dragging needs a pointer, and a pointer is the only thing that can
      // drag — so before this the saved views could not be reordered by keyboard
      // at all. Same matrix as the other two lists, because it is one shared
      // implementation, plus the two questions only a popup raises.
      describe('by keyboard', () => {
        const status = () => screen.getByRole('status')

        function press(name: string, key: 'ArrowUp' | 'ArrowDown') {
          const target = gripFor(name)
          target.focus()
          fireEvent.keyDown(target, { key, altKey: true })
        }

        it('Alt+ArrowDown on the first view moves it down, announces it and persists', () => {
          const { onReorder } = open3()
          press('Alpha view', 'ArrowDown')
          expect(order()).toEqual(['Bravo view', 'Alpha view', 'Charlie view'])
          expect(status()).toHaveTextContent('Alpha view moved to position 2 of 3')
          expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c'])
        })

        it('Alt+ArrowUp on the last view moves it to position 2', () => {
          const { onReorder } = open3()
          press('Charlie view', 'ArrowUp')
          expect(order()).toEqual(['Alpha view', 'Charlie view', 'Bravo view'])
          expect(status()).toHaveTextContent('Charlie view moved to position 2 of 3')
          expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b'])
        })

        it('Alt+ArrowUp on the first view does nothing, announces nothing, persists nothing', () => {
          const { onReorder } = open3()
          press('Alpha view', 'ArrowUp')
          expect(order()).toEqual(['Alpha view', 'Bravo view', 'Charlie view'])
          expect(status()).toHaveTextContent('')
          expect(onReorder).not.toHaveBeenCalled()
        })

        it('Alt+ArrowDown on the last view does nothing, announces nothing, persists nothing', () => {
          const { onReorder } = open3()
          press('Charlie view', 'ArrowDown')
          expect(order()).toEqual(['Alpha view', 'Bravo view', 'Charlie view'])
          expect(status()).toHaveTextContent('')
          expect(onReorder).not.toHaveBeenCalled()
        })

        it('leaves focus on the view it moved, so a second press moves the same view', async () => {
          open3()
          press('Alpha view', 'ArrowDown')
          await waitFor(() => expect(gripFor('Alpha view')).toHaveFocus())
          fireEvent.keyDown(gripFor('Alpha view'), { key: 'ArrowDown', altKey: true })
          expect(order()).toEqual(['Bravo view', 'Charlie view', 'Alpha view'])
        })

        // The row's name button applies the view and closes the menu. A reorder
        // shortcut that did either would make the list unusable by keyboard: the
        // menu would vanish mid-reorder, taking the rest of the list with it.
        it('neither applies a view nor closes the popup', async () => {
          const onApply = vi.fn()
          render(
            <ViewSwitcher
              views={THREE}
              currentSearch=""
              isAdmin
              onApply={onApply}
              onRename={vi.fn()}
              onDelete={vi.fn()}
              onReorder={vi.fn()}
            />,
          )
          fireEvent.click(screen.getByRole('button', { name: /views/i }))
          press('Alpha view', 'ArrowDown')
          expect(onApply).not.toHaveBeenCalled()
          expect(menu()).toBeInTheDocument()
          // And focus landing on the moved grip does not dismiss it either.
          await waitFor(() => expect(gripFor('Alpha view')).toHaveFocus())
          expect(menu()).toBeInTheDocument()
          expect(onApply).not.toHaveBeenCalled()
        })

        it('makes the grip a Tab stop that names the view and the shortcut', () => {
          open3()
          expect(gripFor('Alpha view')).toHaveAttribute('tabindex', '0')
          expect(gripFor('Alpha view')).toHaveAccessibleName(
            'Reorder Alpha view. Press Alt with the up or down arrow keys.',
          )
        })

        it('reverts the visible order when a keyboard move fails to persist', async () => {
          const onReorder = vi.fn().mockRejectedValue(new Error('boom'))
          renderSwitcher({ isAdmin: true, onReorder })
          fireEvent.click(screen.getByRole('button', { name: /views/i }))
          press('Auditor bills', 'ArrowUp')
          await waitFor(() => expect(onReorder).toHaveBeenCalledWith(['v2', 'v1']))
          await waitFor(() => {
            const clerk = screen.getByRole('button', { name: 'Clerk bills' })
            const auditor = screen.getByRole('button', { name: 'Auditor bills' })
            expect(clerk.compareDocumentPosition(auditor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
          })
          // And the announcement reverts with it: the optimistic "moved to
          // position 1 of 2" would otherwise be left standing over a list that
          // has snapped back, telling the user the opposite of what happened.
          expect(status()).not.toHaveTextContent('moved to position')
          expect(status()).toHaveTextContent('Auditor bills could not be moved. The list is unchanged.')
        })

        it('is no keyboard target for a member, who has no grip at all', () => {
          renderSwitcher({ isAdmin: false })
          fireEvent.click(screen.getByRole('button', { name: /views/i }))
          expect(screen.queryByLabelText(/reorder/i)).toBeNull()
        })

        it('is no keyboard target on a demo tenant, even for an admin', () => {
          demoState.demoMode = true
          renderSwitcher({ isAdmin: true })
          fireEvent.click(screen.getByRole('button', { name: /views/i }))
          expect(screen.queryByLabelText(/reorder/i)).toBeNull()
        })
      })

    })

    it('reverts the visible order when the reorder request fails', async () => {
      const onReorder = vi.fn().mockRejectedValue(new Error('boom'))
      renderSwitcher({ isAdmin: true, onReorder })
      fireEvent.click(screen.getByRole('button', { name: /views/i }))
      const fromGrip = gripFor('Auditor bills')
      const toRow = screen.getByText('Clerk bills').closest('div')!
      dragRow(fromGrip, toRow)

      await waitFor(() => expect(onReorder).toHaveBeenCalled())
      // Reverted: original order (Clerk bills before Auditor bills) restored.
      await waitFor(() => {
        const clerk = screen.getByRole('button', { name: 'Clerk bills' })
        const auditor = screen.getByRole('button', { name: 'Auditor bills' })
        expect(clerk.compareDocumentPosition(auditor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      })
      expect(screen.getByRole('status')).not.toHaveTextContent('moved to position')
    })
  })
})
