import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { RichTextEditor } from './RichTextEditor'

// Typing a full email address after the @ must keep the suggestion list open
// (#514). tiptap's suggestion drops the list at a second "@" unless
// allowToIncludeChar is set, which made only the part before the @ matchable.

const directory = [
  { id: 'u1', name: 'Jordan Lee', email: 'jdoe@example.org', title: null, role: 'member', roles: [] },
  { id: 'u2', name: 'Sam Member', email: 'sam@example.com', title: null, role: 'member', roles: [] },
]

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn((path: string) => Promise.resolve(path === '/users' ? directory : [])),
}))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u2', role: 'member' } }),
}))
// The popup is a tippy instance; put its content in the document instead.
vi.mock('tippy.js', () => ({
  default: (_target: unknown, opts: { content: HTMLElement }) => {
    document.body.appendChild(opts.content)
    return [{ setProps: () => {}, hide: () => {}, destroy: () => opts.content.remove() }]
  },
}))

beforeAll(() => {
  document.elementFromPoint = () => null
  Element.prototype.scrollIntoView = vi.fn()
})

async function mountEditor() {
  const { container } = render(<RichTextEditor onSubmit={() => {}} />)
  await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull())
  // Let the directory load before typing.
  await act(async () => { await Promise.resolve() })
  return (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
}

async function type(editor: Editor, text: string) {
  await act(async () => { editor.commands.insertContent(text) })
}

describe('RichTextEditor, @mention by full email address', () => {
  it('keeps the list open and suggests the member while a full address is typed', async () => {
    const editor = await mountEditor()
    await type(editor, '@jdoe@example.org')
    const option = await screen.findByRole('button', { name: /Jordan Lee/ })
    expect(option).toHaveTextContent('Jordan Leejdoe@example.org')
    expect(screen.queryByRole('button', { name: /Sam Member/ })).toBeNull()
  })

  it('does not open the list for an email address typed mid-word', async () => {
    const editor = await mountEditor()
    await type(editor, 'write to a@b.org')
    expect(screen.queryByRole('button', { name: /Jordan Lee/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /everyone|admins/ })).toBeNull()
  })

  it('opens the list again on a second @ after a space', async () => {
    const editor = await mountEditor()
    await type(editor, '@jdoe@example.org and @sam')
    expect(await screen.findByRole('button', { name: /Sam Member/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Jordan Lee/ })).toBeNull()
  })
})
