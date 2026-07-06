import { useState, useRef, useCallback } from 'react'
import { color, radius } from '../styles/tokens'

/**
 * Vertical resize hook.
 *
 * @param initialHeight starting/default height in px
 * @param minHeight minimum allowed height (default 80)
 * @param getMaxHeight optional getter for the max allowed height, evaluated each
 *   pointer-move tick. Lets callers clamp against sibling layout (e.g. another
 *   resizable widget) without re-creating the hook.
 */
export function useVerticalResize(
  initialHeight: number,
  minHeight = 80,
  getMaxHeight?: () => number,
) {
  const [height, setHeight] = useState(initialHeight)
  const [hasResized, setHasResized] = useState(false)
  const heightRef = useRef(initialHeight)
  heightRef.current = height
  const getMaxHeightRef = useRef(getMaxHeight)
  getMaxHeightRef.current = getMaxHeight

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = heightRef.current

    function onMove(ev: PointerEvent) {
      const next = startHeight + ev.clientY - startY
      const maxH = getMaxHeightRef.current?.() ?? Infinity
      setHeight(Math.max(minHeight, Math.min(maxH, next)))
      setHasResized(true)
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [minHeight])

  return { height, hasResized, handlePointerDown, setHeight }
}

export function ResizeHandle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onPointerDown={onPointerDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 20,
        cursor: 'ns-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        touchAction: 'none',
        borderTop: `1px solid ${color.borderDefault}`,
        background: color.surfaceSubtle,
      }}
    >
      <div style={{
        width: 32,
        height: 3,
        borderRadius: radius.xs,
        background: hovered ? color.textMuted : color.borderStrong,
        transition: 'background 0.15s',
      }} />
    </div>
  )
}
