import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { RichTextEditor } from './RichTextEditor'
import { createUnsavedRegistry, UnsavedTextContext } from '../lib/unsavedText'

// Regression coverage for unsaved-text dirty detection. TipTap is mounted under
// jsdom with mentions disabled (no network / tippy). The dirty baseline is
// captured from editor.getText() (block-joined with "\n\n"), so multi-paragraph
// initial content must NOT report dirty on mount — the earlier regex-strip
// baseline ("HelloWorld") mismatched getText ("Hello\n\nWorld") and produced a
// spurious "unsaved text" warning.
//
// The opposite direction (typing makes it dirty) depends on real ProseMirror
// input handling that jsdom can't faithfully simulate, so it's covered by the
// manual browser pass, not here.

beforeAll(() => {
  // jsdom lacks elementFromPoint, which ProseMirror's placeholder viewport
  // tracking calls; stub it so the editor can mount headlessly.
  document.elementFromPoint = () => null
})

function renderInRegistry(ui: React.ReactElement<any>) {
  const reg = createUnsavedRegistry()
  render(<UnsavedTextContext.Provider value={reg}>{ui}</UnsavedTextContext.Provider>)
  return reg
}

describe('RichTextEditor unsaved registration', () => {
  it('is not dirty on mount for an empty composer', () => {
    const reg = renderInRegistry(
      <RichTextEditor enableMentions={false} onSubmit={() => {}} />,
    )
    expect(reg.hasUnsaved()).toBe(false)
  })

  it('is not dirty on mount for single-paragraph initial content', () => {
    const reg = renderInRegistry(
      <RichTextEditor enableMentions={false} initialContent="<p>Hello world</p>" onSubmit={() => {}} />,
    )
    expect(reg.hasUnsaved()).toBe(false)
  })

  it('is not dirty on mount for multi-paragraph initial content', () => {
    const reg = renderInRegistry(
      <RichTextEditor enableMentions={false} initialContent="<p>Hello</p><p>World</p>" onSubmit={() => {}} />,
    )
    expect(reg.hasUnsaved()).toBe(false)
  })
})
