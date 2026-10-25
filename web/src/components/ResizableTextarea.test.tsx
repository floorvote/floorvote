import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ResizableTextarea } from './ResizableTextarea'

const mobileCss = readFileSync(resolve(__dirname, '../styles/mobile.css'), 'utf8')

describe('ResizableTextarea: keyboard focus ring', () => {
  // The borderless textarea sits in a rounded, overflow:hidden wrapper that also
  // holds the resize handle. A ring on the textarea is rectangular, clipped at
  // the corners, and stops above the handle, so the wrapper is ringed instead
  // (an outline on the wrapper is not clipped by its own overflow). jsdom can't
  // evaluate :focus-visible, so pin the class and inline styles.
  it('rings the wrapper and keeps the textarea outline off', () => {
    render(<ResizableTextarea aria-label="Notes" />)
    const textarea = screen.getByRole('textbox', { name: 'Notes' })
    const wrapper = textarea.parentElement!
    expect(textarea.style.outline).toBe('none')
    expect(textarea.style.outlineOffset).toBe('')
    expect(wrapper).toHaveClass('resizable-textarea')
    expect(wrapper.style.overflow).toBe('hidden')
    expect(wrapper.style.borderRadius).not.toBe('')
    expect(mobileCss).toMatch(/\.resizable-textarea:has\(>\s*textarea:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--fv-focus-ring\)/)
  })
})
