import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RichTextEditor } from './RichTextEditor'

const mobileCss = readFileSync(resolve(__dirname, '../styles/mobile.css'), 'utf8')
const inputScss = readFileSync(resolve(__dirname, './tiptap-ui-primitive/input/input.scss'), 'utf8')
const editorSource = readFileSync(resolve(__dirname, './RichTextEditor.tsx'), 'utf8')

beforeAll(() => {
  // jsdom lacks elementFromPoint, which ProseMirror's placeholder tracking calls.
  document.elementFromPoint = () => null
})

describe('RichTextEditor: keyboard focus ring', () => {
  // The ProseMirror surface sets outline: none inside a rounded, overflow:hidden
  // wrapper, so keyboard focus showed no ring at all. The wrapper is ringed
  // instead (an outline on the wrapper is not clipped by its own overflow).
  // jsdom can't evaluate :focus-visible, so pin the class, the stylesheet rule,
  // and the inline styles.
  it('keeps the wrapper rounded and the editable surface ring-free', () => {
    const { container } = render(<RichTextEditor enableMentions={false} onSubmit={() => {}} />)
    const wrapper = container.querySelector('.comment-editor-wrapper')
    expect(wrapper).not.toBeNull()
    const surface = wrapper!.querySelector('.tiptap.ProseMirror')
    expect(surface).not.toBeNull()
    expect(wrapper!.contains(surface)).toBe(true)
    expect(editorSource).toMatch(/\.comment-editor-wrapper \.tiptap\.ProseMirror \{\s*outline: none;/)
    expect(editorSource).toMatch(/\.comment-editor-wrapper \{[\s\S]*?border-radius: 8px;[\s\S]*?overflow: hidden;/)
  })

  it('rings the wrapper while the editable surface has keyboard focus', () => {
    expect(mobileCss).toMatch(
      /\.comment-editor-wrapper:has\(\.tiptap\.ProseMirror:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--fv-focus-ring\)/,
    )
  })

  it('does not hardcode the legacy amber or a one-off color for the ring', () => {
    const rule = mobileCss.match(/\.comment-editor-wrapper:has\([^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).not.toBe('')
    expect(rule.toLowerCase()).not.toContain('#f59e0b')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}/i)
  })
})

describe('tiptap input: keyboard focus ring', () => {
  // .tiptap-input (the link popover's URL field) set outline: none and only
  // nudged its border color on focus, so keyboard focus was nearly invisible.
  // It has its own border and radius, so it takes the global *:focus-visible ring.
  it('does not suppress the outline on the input', () => {
    const block = inputScss.match(/\n\.tiptap-input \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).not.toBe('')
    expect(block).not.toMatch(/outline\s*:\s*none/)
  })
})
