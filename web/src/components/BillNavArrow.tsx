interface BillNavArrowProps {
  direction: 'up' | 'down'
  size?: number
}

// The previous/next-bill arrows on a bill page. The bills list is vertical (and
// sits beside the bill in the split layout), so previous is up and next is down.
// Decorative: the button around it carries the accessible name.
export function BillNavArrow({ direction, size = 14 }: BillNavArrowProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-arrow={direction}
      style={{ display: 'block' }}
    >
      {direction === 'up'
        ? <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z" />
        : <path d="M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z" />}
    </svg>
  )
}
