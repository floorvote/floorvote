import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import {
  DRAG_REORDER_MIME, DragReorder, DropIndicator, ReorderLiveRegion, destinationFor, useDragReorder,
} from './dragReorder'

// jsdom does not populate DataTransfer the way a real browser drag does, so a
// bare object standing in for it is passed through and read back by the hook's
// own handlers — the same helper the three call sites' tests use.
function fakeDataTransfer() {
  let stored = ''
  let storedType = ''
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => { storedType = type; stored = value },
    getData: (type: string) => (type === storedType ? stored : ''),
  }
}

/**
 * A minimal list that wires the primitive the way a call site should: the grip
 * starts the drag, the whole row is the drop target, a tail zone follows, and
 * the indicator is drawn wherever the primitive says.
 */
function List({
  items, onOrder, disabled, onReorderSpy, unlabelled, gripTabStop,
}: {
  items: string[]
  onOrder?: (next: string[]) => void
  disabled?: boolean
  onReorderSpy?: (from: number, to: number) => void
  /** Drops the `label` option, to pin what an unlabelled list falls back to. */
  unlabelled?: boolean
  gripTabStop?: boolean
}) {
  const [order, setOrder] = useState(items)
  const dnd: DragReorder = useDragReorder({
    count: order.length,
    disabled,
    gripTabStop,
    label: unlabelled ? undefined : i => order[i],
    onReorder: (from, to) => {
      onReorderSpy?.(from, to)
      const next = [...order]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      setOrder(next)
      onOrder?.(next)
    },
  })
  return (
    <div>
      <div data-testid="order">{order.join(',')}</div>
      {order.map((name, i) => (
        // Keyed by INDEX, like the tag table (TagTaxonomyTable.tsx), which is
        // the harder case for focus: React then keeps each DOM node at its
        // position and reassigns identities across it, so a focused grip
        // silently comes to stand for a different item after a move. Keying by
        // a stable id would move the nodes instead and hide that entirely.
        <div key={i}>
          {dnd.indicatorBefore(i) && <DropIndicator className={`ind-${i}`} />}
          <div data-testid={`row-${name}`} style={dnd.sourceStyle(i)} {...dnd.dropProps(i)}>
            <span data-testid={`grip-${name}`} {...dnd.gripProps(i)}>grip</span>
            {name}
          </div>
        </div>
      ))}
      <div data-testid="tail" {...dnd.tailDropProps()}>
        {dnd.indicatorAtEnd() && <DropIndicator className="ind-tail" />}
      </div>
      <div data-testid="probe">
        {order.map((_, i) => (dnd.canDropBefore(i) ? `before-${i} ` : '')).join('')}
        {dnd.canDropAtEnd() ? 'tail' : ''}
      </div>
      <ReorderLiveRegion announcement={dnd.announcement} />
    </div>
  )
}

const order = () => screen.getByTestId('order').textContent
const probe = () => screen.getByTestId('probe').textContent

describe('destinationFor', () => {
  // The whole off-by-one lives here and nowhere else. A move is a splice-out
  // followed by a splice-in, so on a DOWNWARD drag the removal shifts the
  // target up one before the insert happens.
  it('adjusts a downward drag so the row lands BEFORE the target, not after it', () => {
    // [A, B, C]: grab A (0), aim at slot 2 (before C). Post-removal the array
    // is [B, C]; inserting at 2 would append (→ [B, C, A]). 1 gives [B, A, C].
    expect(destinationFor(0, 2)).toBe(1)
    expect(destinationFor(0, 1)).toBe(0)
    expect(destinationFor(1, 3)).toBe(2)
  })

  it('leaves an upward drag alone — nothing below the target shifts', () => {
    expect(destinationFor(2, 0)).toBe(0)
    expect(destinationFor(2, 1)).toBe(1)
    expect(destinationFor(3, 1)).toBe(1)
  })

  it('sends the append-at-end slot to the last position', () => {
    // Slot === count is always above the source, so the downward rule already
    // yields count - 1; no special case exists to get wrong.
    expect(destinationFor(0, 3)).toBe(2)
    expect(destinationFor(1, 3)).toBe(2)
  })
})

describe('useDragReorder — the single predicate', () => {
  function start(name: string) {
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getByTestId(`grip-${name}`), { dataTransfer })
    return dataTransfer
  }

  it('refuses every slot before a drag starts', () => {
    render(<List items={['A', 'B', 'C']} />)
    expect(probe()).toBe('')
  })

  it('is false for the source and for the position immediately after the source', () => {
    render(<List items={['A', 'B', 'C']} />)
    start('B') // index 1
    // before-1 is B's own slot; before-2 is the slot immediately after B, i.e.
    // between B and C — dropping there puts B back where it was.
    expect(probe()).toBe('before-0 tail')
  })

  it('refuses the tail slot for the last item, which is already at the end', () => {
    render(<List items={['A', 'B', 'C']} />)
    start('C') // index 2 — the tail slot is the no-op "after the source"
    expect(probe()).toBe('before-0 before-1 ')
  })

  it('accepts every non-adjacent slot for the first item', () => {
    render(<List items={['A', 'B', 'C']} />)
    start('A')
    expect(probe()).toBe('before-2 tail')
  })

  it('draws the line only where the predicate accepts a drop, and only under the pointer', () => {
    render(<List items={['A', 'B', 'C']} />)
    const dataTransfer = start('A')

    fireEvent.dragOver(screen.getByTestId('row-C'), { dataTransfer })
    expect(document.querySelector('.ind-2')).toBeInTheDocument()
    expect(document.querySelectorAll('[class^="ind-"]')).toHaveLength(1)

    // A's own slot: predicate false, so no line even though the pointer is here.
    fireEvent.dragOver(screen.getByTestId('row-A'), { dataTransfer })
    expect(document.querySelectorAll('[class^="ind-"]')).toHaveLength(0)

    // The slot right after A: also a no-op position.
    fireEvent.dragOver(screen.getByTestId('row-B'), { dataTransfer })
    expect(document.querySelectorAll('[class^="ind-"]')).toHaveLength(0)

    fireEvent.dragOver(screen.getByTestId('tail'), { dataTransfer })
    expect(document.querySelector('.ind-tail')).toBeInTheDocument()

    fireEvent.dragEnd(screen.getByTestId('grip-A'))
    expect(document.querySelectorAll('[class^="ind-"]')).toHaveLength(0)
  })
})

describe('useDragReorder — outcomes', () => {
  function drag(from: string, to: string) {
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getByTestId(`grip-${from}`), { dataTransfer })
    const target = to === 'tail' ? screen.getByTestId('tail') : screen.getByTestId(`row-${to}`)
    fireEvent.dragOver(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })
  }

  it('drag A, drop on C → B, A, C (insert-before, both directions)', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    drag('A', 'C')
    expect(order()).toBe('B,A,C')
    expect(spy).toHaveBeenCalledWith(0, 1)
  })

  it('drag C, drop on A → C, A, B', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    drag('C', 'A')
    expect(order()).toBe('C,A,B')
    expect(spy).toHaveBeenCalledWith(2, 0)
  })

  it('drag A, drop on the tail zone → B, C, A', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    drag('A', 'tail')
    expect(order()).toBe('B,C,A')
    expect(spy).toHaveBeenCalledWith(0, 2)
  })

  it('drag A, drop on B → unchanged, and no reorder callback fires', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    drag('A', 'B')
    expect(order()).toBe('A,B,C')
    expect(spy).not.toHaveBeenCalled()
  })

  it('drag C, drop on the tail zone → unchanged, and no reorder callback fires', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    drag('C', 'tail')
    expect(order()).toBe('A,B,C')
    expect(spy).not.toHaveBeenCalled()
  })

  it('drag A, drop on its own row → unchanged, and no reorder callback fires', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    drag('A', 'A')
    expect(order()).toBe('A,B,C')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('useDragReorder — plumbing', () => {
  it('carries the source index on a custom MIME, not text/plain', () => {
    render(<List items={['A', 'B']} />)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('grip-B'), { dataTransfer })
    expect(dataTransfer.getData(DRAG_REORDER_MIME)).toBe('1')
    expect(dataTransfer.getData('text/plain')).toBe('')
  })

  it('honours a mime override', () => {
    function Custom() {
      const dnd = useDragReorder({ count: 2, onReorder: () => {}, mime: 'application/x-other' })
      return <span data-testid="g" {...dnd.gripProps(0)}>g</span>
    }
    render(<Custom />)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('g'), { dataTransfer })
    expect(dataTransfer.getData('application/x-other')).toBe('0')
  })

  it('cancels dragover during a reorder so the browser allows the drop', () => {
    render(<List items={['A', 'B', 'C']} />)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('grip-A'), { dataTransfer })
    // fireEvent returns false when the event was cancelled.
    expect(fireEvent.dragOver(screen.getByTestId('row-C'), { dataTransfer })).toBe(false)
    // Cancelled at the no-op positions too, so the pointer crossing the source
    // does not paint "no drop allowed" across the list.
    expect(fireEvent.dragOver(screen.getByTestId('row-B'), { dataTransfer })).toBe(false)
  })

  it('leaves a drag that did not start on a grip entirely to the browser', () => {
    render(<List items={['A', 'B', 'C']} />)
    // No dragStart: this is an ordinary drag (selected text heading for a
    // textarea, say). fireEvent returns true when the event was NOT cancelled,
    // so the browser's own "insert at caret" drop still happens.
    expect(fireEvent.dragOver(screen.getByTestId('row-A'))).toBe(true)
    expect(fireEvent.drop(screen.getByTestId('row-A'))).toBe(true)
  })

  it('dims the source row while dragging, and only the source row', () => {
    render(<List items={['A', 'B', 'C']} />)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('grip-B'), { dataTransfer })
    expect(screen.getByTestId('row-B')).toHaveStyle({ opacity: '0.4' })
    expect(screen.getByTestId('row-A')).toHaveStyle({ opacity: '1' })
    fireEvent.dragEnd(screen.getByTestId('grip-B'))
    expect(screen.getByTestId('row-B')).toHaveStyle({ opacity: '1' })
  })

  it('ignores a payload that is not an index', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('grip-A'), { dataTransfer })
    dataTransfer.setData(DRAG_REORDER_MIME, 'nonsense')
    fireEvent.dragOver(screen.getByTestId('row-C'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('row-C'), { dataTransfer })
    expect(order()).toBe('A,B,C')
    expect(spy).not.toHaveBeenCalled()
  })

  it('when disabled: no grip, no drop handlers, no indicator, no reorder', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} disabled onReorderSpy={spy} />)
    expect(screen.getByTestId('grip-A')).toHaveAttribute('draggable', 'false')
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('grip-A'), { dataTransfer })
    // dragstart is inert, so nothing is in flight and dragover is not cancelled.
    expect(fireEvent.dragOver(screen.getByTestId('row-C'), { dataTransfer })).toBe(true)
    fireEvent.drop(screen.getByTestId('row-C'), { dataTransfer })
    expect(order()).toBe('A,B,C')
    expect(spy).not.toHaveBeenCalled()
    expect(probe()).toBe('')
  })

  it('throws loudly when a call site asks about an item index that does not exist', () => {
    // The append-at-end slot is reached with tailDropProps()/canDropAtEnd(),
    // never with dropProps(count) — mistaking one for the other used to be the
    // sort of thing that silently reordered by one, so it is now an error.
    function Bad() {
      const dnd = useDragReorder({ count: 2, onReorder: () => {} })
      return <div {...dnd.dropProps(2)} />
    }
    expect(() => render(<Bad />)).toThrow(/outside 0\.\.1/)
  })
})

describe('useDragReorder — keyboard reordering', () => {
  const status = () => screen.getByRole('status').textContent
  const grip = (name: string) => screen.getByTestId(`grip-${name}`)

  async function press(name: string, key: 'ArrowUp' | 'ArrowDown') {
    const user = userEvent.setup()
    await user.click(grip(name))
    await user.keyboard(`{Alt>}{${key}}{/Alt}`)
  }

  it('Alt+ArrowDown on the first item moves it to position 2 and announces it', async () => {
    render(<List items={['A', 'B', 'C']} />)
    await press('A', 'ArrowDown')
    expect(order()).toBe('B,A,C')
    expect(status()).toBe('A moved to position 2 of 3')
  })

  it('Alt+ArrowUp on the last item moves it to position 2', async () => {
    render(<List items={['A', 'B', 'C']} />)
    await press('C', 'ArrowUp')
    expect(order()).toBe('A,C,B')
    expect(status()).toBe('C moved to position 2 of 3')
  })

  it('Alt+ArrowUp on the first item does nothing and announces nothing', async () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    await press('A', 'ArrowUp')
    expect(order()).toBe('A,B,C')
    expect(spy).not.toHaveBeenCalled()
    expect(status()).toBe('')
  })

  it('Alt+ArrowDown on the last item does nothing and announces nothing', async () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    await press('C', 'ArrowDown')
    expect(order()).toBe('A,B,C')
    expect(spy).not.toHaveBeenCalled()
    expect(status()).toBe('')
  })

  it('hands onReorder an already-adjusted destination, in both directions', async () => {
    // What this pins is the pair the call site actually receives, in both
    // directions — a call site that had to do its own arithmetic would be
    // free to get it wrong. It does NOT discriminate destinationFor from a
    // parallel single-step sum: for a one-place keyboard move those agree on
    // every (from, to), and the slot in between is not visible to the spy.
    // The slot arithmetic itself is pinned by the destinationFor tests above
    // and by the multi-row drop tests.
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    await press('A', 'ArrowDown')
    expect(spy).toHaveBeenCalledWith(0, 1)
    spy.mockClear()
    // And upward from the last item: slot 1, destination 1, no shift.
    await press('C', 'ArrowUp')
    expect(spy).toHaveBeenCalledWith(2, 1)
  })

  it('moves repeatedly on repeated presses, following the item as it goes', async () => {
    const user = userEvent.setup()
    render(<List items={['A', 'B', 'C']} />)
    await user.click(grip('A'))
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    // Focus is on the moved item now, so the second press acts on A again
    // rather than on whatever row slid under the old focus.
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(order()).toBe('B,C,A')
    expect(status()).toBe('A moved to position 3 of 3')
  })

  it('puts focus on the moved item', async () => {
    render(<List items={['A', 'B', 'C']} />)
    await press('A', 'ArrowDown')
    await waitFor(() => expect(grip('A')).toHaveFocus())
  })

  it('lets the call site take over where focus lands', async () => {
    const user = userEvent.setup()
    function WithOwnFocus() {
      const [order, setOrder] = useState(['A', 'B'])
      const dnd = useDragReorder<string>({
        count: order.length,
        label: i => order[i],
        focusAfterMove: (to, context) => {
          document.getElementById(`field-${context}-${to}`)?.focus()
          return true
        },
        onReorder: (from, to) => {
          const next = [...order]
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          setOrder(next)
        },
      })
      return (
        <div>
          {order.map((name, i) => (
            <div key={name}>
              <span data-testid={`grip-${name}`} {...dnd.gripProps(i)}>grip</span>
              <input id={`field-x-${i}`} onKeyDown={e => dnd.moveByKey(e, i, 'x')} />
            </div>
          ))}
        </div>
      )
    }
    render(<WithOwnFocus />)
    const first = document.getElementById('field-x-0') as HTMLInputElement
    await user.click(first)
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() => expect(document.getElementById('field-x-1')).toHaveFocus())
  })

  it('derives the total from `count`, so a row that is not an item is never counted', async () => {
    // The tag table's trailing blank: rendered, focusable, offered as the
    // tail drop slot — but not a tag. A site passing its own total is how it
    // came to announce "of 3" for two tags, so the total is not the site's to
    // pass, and a key press on the non-item is refused rather than throwing.
    const spy = vi.fn()
    function WithTrailingBlank() {
      const dnd = useDragReorder({ count: 2, label: i => ['A', 'B'][i], onReorder: spy })
      return (
        <div>
          <span data-testid="grip-A" {...dnd.gripProps(0)}>grip</span>
          <span data-testid="grip-B" {...dnd.gripProps(1)}>grip</span>
          <input data-testid="blank" onKeyDown={e => dnd.moveByKey(e, 2)} />
          <ReorderLiveRegion announcement={dnd.announcement} />
        </div>
      )
    }
    const user = userEvent.setup()
    render(<WithTrailingBlank />)
    await user.click(screen.getByTestId('grip-A'))
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(status()).toBe('A moved to position 2 of 2')

    // The non-item asks about slot 1, which acceptsSlot refuses because
    // index 2 is outside 0..count-1 — no move, no announcement, no throw.
    spy.mockClear()
    await user.click(screen.getByTestId('blank'))
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(spy).not.toHaveBeenCalled()
  })

  it('falls back to a positional label when the site supplies none', async () => {
    render(<List items={['A', 'B', 'C']} unlabelled />)
    expect(grip('A')).toHaveAttribute('aria-label', 'Reorder item 1. Press Alt with the up or down arrow keys.')
    await press('A', 'ArrowDown')
    expect(status()).toBe('Item 1 moved to position 2 of 3')
  })

  it('makes the grip a labelled, focusable button that says what the shortcut is', () => {
    render(<List items={['A', 'B']} />)
    expect(grip('A')).toHaveAttribute('role', 'button')
    expect(grip('A')).toHaveAttribute('tabindex', '0')
    expect(grip('A')).toHaveAccessibleName('Reorder A. Press Alt with the up or down arrow keys.')
  })

  it('keeps the grip out of the tab order, but still operable, when the site opts out', async () => {
    render(<List items={['A', 'B']} gripTabStop={false} />)
    expect(grip('A')).toHaveAttribute('tabindex', '-1')
    await press('A', 'ArrowDown')
    expect(order()).toBe('B,A')
  })

  it('ignores an arrow press without Alt, leaving the key to the browser', () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} onReorderSpy={spy} />)
    // fireEvent returns true when the event was NOT cancelled: a bare arrow
    // must still move the caret inside a text field the handler sits on.
    expect(fireEvent.keyDown(grip('A'), { key: 'ArrowDown' })).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    expect(order()).toBe('A,B,C')
  })

  it('consumes Alt+Arrow even at the ends, so the caret does not jump on the end rows alone', () => {
    render(<List items={['A', 'B']} />)
    expect(fireEvent.keyDown(grip('A'), { key: 'ArrowUp', altKey: true })).toBe(false)
    expect(order()).toBe('A,B')
  })

  it('when disabled: the grip is not focusable, claims no role, and promises no shortcut', async () => {
    const spy = vi.fn()
    render(<List items={['A', 'B', 'C']} disabled onReorderSpy={spy} />)
    expect(grip('A')).not.toHaveAttribute('tabindex')
    expect(grip('A')).not.toHaveAttribute('role')
    expect(grip('A')).not.toHaveAttribute('aria-label')
    fireEvent.keyDown(grip('A'), { key: 'ArrowDown', altKey: true })
    expect(spy).not.toHaveBeenCalled()
    expect(order()).toBe('A,B,C')
    expect(status()).toBe('')
  })

  // Focus, when a drop moves it, moves inside a queueMicrotask, so NOTHING can
  // be asserted about post-drop focus from a synchronous test body: the
  // assertion would pass whatever the component does. Draining the task queue
  // once is what makes the two tests below able to fail.
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  it('announces a pointer drop, and follows the moved item when the drop came off its grip', async () => {
    render(<List items={['A', 'B', 'C']} />)
    const dataTransfer = fakeDataTransfer()
    // The ordinary mouse drag: grips carry a tabIndex, so the mousedown that
    // starts the drag focuses the grip, and focus is still there on drop.
    grip('A').focus()
    fireEvent.dragStart(grip('A'), { dataTransfer })
    fireEvent.dragOver(screen.getByTestId('row-C'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('row-C'), { dataTransfer })
    expect(order()).toBe('B,A,C')
    expect(status()).toBe('A moved to position 2 of 3')
    await settle()
    // Not merely "some grip is focused": the grip at the SOURCE index now
    // belongs to B, and leaving focus there would make the next Alt+Arrow
    // move B and undo the drop.
    expect(grip('A')).toHaveFocus()
  })

  it('leaves focus alone for a drop released with focus outside the interaction', async () => {
    render(
      <div>
        <button data-testid="elsewhere">elsewhere</button>
        <List items={['A', 'B', 'C']} />
      </div>,
    )
    const elsewhere = screen.getByTestId('elsewhere')
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(grip('A'), { dataTransfer })
    elsewhere.focus()
    fireEvent.dragOver(screen.getByTestId('row-C'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('row-C'), { dataTransfer })
    expect(order()).toBe('B,A,C')
    await settle()
    // Nothing stale to fix here, and yanking focus across the page on drop is
    // a jolt, so the drop leaves it where the user left it.
    expect(elsewhere).toHaveFocus()
  })
})
