import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { color } from '../../styles/tokens'
import {
  PANE_DEFAULT_WIDTH, PANE_MIN_WIDTH,
  clampPaneWidth, keyboardPaneWidth, paneMaxWidth,
  readSidebarWidth, readStoredPaneWidth, writeStoredPaneWidth,
} from './paneWidth'

/**
 * The split pane's width: what the reader chose (remembered in this browser)
 * held between the minimum and the room the window leaves. The choice itself
 * is never narrowed, only what is drawn, so a pane squeezed by a small window
 * is as wide as it was chosen once the window grows back.
 */
export function useBillListPaneWidth() {
  const [chosen, setChosen] = useState(() => readStoredPaneWidth() ?? PANE_DEFAULT_WIDTH)
  const [room, setRoom] = useState(() => ({ viewport: window.innerWidth, sidebar: readSidebarWidth() }))
  useEffect(() => {
    const onResize = () => setRoom({ viewport: window.innerWidth, sidebar: readSidebarWidth() })
    // The sidebar stores its width when its own drag ends, after this listener
    // has run, so read it a tick later. A wider sidebar costs the pane room.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onPointerUp = () => { clearTimeout(timer); timer = setTimeout(onResize, 0) }
    window.addEventListener('resize', onResize)
    document.addEventListener('pointerup', onPointerUp)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

  const max = paneMaxWidth(room.viewport, room.sidebar)
  const width = clampPaneWidth(chosen, max)

  // A drag or key press sets and remembers the width; reset forgets it.
  const choose = useCallback((next: number) => { setChosen(next); writeStoredPaneWidth(next) }, [])
  const reset = useCallback(() => { setChosen(PANE_DEFAULT_WIDTH); writeStoredPaneWidth(null) }, [])
  // The sidebar may have been dragged since the last window resize.
  const currentMax = useCallback(() => paneMaxWidth(window.innerWidth, readSidebarWidth()), [])

  return { width, max, chosen, choose, reset, setChosen, currentMax }
}

/**
 * The drag handle on the pane's right edge: a focusable separator (the
 * window-splitter pattern). Drag, Left/Right (16px), Home/End, or double-click
 * to reset. Absolutely positioned, so it takes no room from the header or
 * the rows.
 */
export function PaneResizeHandle({ width, max, pane }: { width: number; max: number; pane: ReturnType<typeof useBillListPaneWidth> }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  // Tears down an in-progress drag: on release, and if the pane unmounts first.
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const startChosen = pane.chosen
    const pointerId = e.pointerId
    let latest = startWidth

    const onMove = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      // The limit is read each move: the window or the sidebar may have changed.
      latest = clampPaneWidth(startWidth + ev.clientX - startX, pane.currentMax())
      pane.setChosen(latest)
    }
    const end = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      stopDrag.current = null
      setDragging(false)
    }
    // Only a drag that changed the width is a choice. A bare click, or a drag
    // back to where it began, leaves the stored preference alone (it may be
    // wider than this window shows). What is stored is the width that was shown.
    const onUp = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      end()
      const shown = clampPaneWidth(latest, pane.currentMax())
      if (shown === startWidth) pane.setChosen(startChosen)
      else pane.choose(shown)
    }

    stopDrag.current = end
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    setDragging(true)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = keyboardPaneWidth(width, e.key, max)
    if (next === null) return
    e.preventDefault()
    // At a bound the key changes nothing, and must not overwrite a stored width
    // wider (or narrower) than this window shows.
    if (next !== width) pane.choose(next)
  }

  const lit = hovered || focused || dragging
  // A focusable separator is a widget in the ARIA window-splitter pattern, which
  // jsx-a11y's role table doesn't know: it lists separator as non-interactive.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize bill list"
      aria-valuenow={width}
      aria-valuemin={PANE_MIN_WIDTH}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={pane.reset}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: 8,
        display: 'flex', justifyContent: 'flex-end',
        cursor: 'col-resize', touchAction: 'none', zIndex: 5,
        // The keyboard focus ring: the app's neutral focus token, drawn inside the 8px strip.
        outline: focused ? `2px solid ${color.focusRing}` : undefined, outlineOffset: -2,
      }}
    >
      <span data-resize-line aria-hidden style={{ width: 3, height: '100%', background: lit ? color.borderStrong : 'transparent', transition: 'background 0.15s' }} />
    </div>
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
