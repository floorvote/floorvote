import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import {
  DRAG_REORDER_MIME, DragReorder, DropIndicator, destinationFor, useDragReorder,
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
  items, onOrder, disabled, onReorderSpy,
}: {
  items: string[]
  onOrder?: (next: string[]) => void
  disabled?: boolean
  onReorderSpy?: (from: number, to: number) => void
}) {
  const [order, setOrder] = useState(items)
  const dnd: DragReorder = useDragReorder({
    count: order.length,
    disabled,
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
        <div key={name}>
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
