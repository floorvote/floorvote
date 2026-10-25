import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ResizableTextarea } from './ResizableTextarea'

describe('ResizableTextarea: keyboard focus ring', () => {
  // An inline `outline: 'none'` beat the global *:focus-visible ring. The
  // wrapper's overflow:hidden would clip a ring drawn outside the textarea, so
  // it is drawn inside. jsdom can't evaluate :focus-visible, so pin the style.
  it('sets no inline outline and draws the ring inside the textarea', () => {
    render(<ResizableTextarea aria-label="Notes" />)
    const textarea = screen.getByRole('textbox', { name: 'Notes' })
    expect(textarea.style.outline).toBe('')
    expect(textarea.style.outlineOffset).toBe('-2px')
    expect(textarea.parentElement!.style.overflow).toBe('hidden')
  })
})
