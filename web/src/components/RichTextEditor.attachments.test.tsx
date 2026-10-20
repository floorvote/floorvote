import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/core'
import { RichTextEditor } from './RichTextEditor'

// The comment composer's file attachments (#465): the toolbar paperclip, drag
// and drop, paste, and the pending rows under the editor. Uploads go through
// the real attachments lib; only fetch is replaced.

vi.mock('../lib/api', () => ({ apiFetch: vi.fn(() => Promise.resolve([])) }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'member' } }) }))

const LIMITS = { maxBytes: 25 * 1024 * 1024, maxPerComment: 3 }

type Reply = { status: number; body?: unknown }
let replies: Reply[]
let fetchMock: ReturnType<typeof vi.fn>
let nextId = 0

beforeAll(() => {
  document.elementFromPoint = () => null
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  nextId = 0
  replies = []
  fetchMock = vi.fn((url: string, init: RequestInit) => {
    if (init.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
    const queued = replies.shift()
    if (queued) return Promise.resolve(new Response(JSON.stringify(queued.body), { status: queued.status }))
    const file = init.body as File
    return Promise.resolve(new Response(JSON.stringify({ id: `att${++nextId}`, name: file.name, contentType: file.type, size: file.size }), { status: 201 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

const pdf = (name = 'memo.pdf', size = 2048) => new File([new Uint8Array(size)], name, { type: 'application/pdf' })

async function mount(props: Partial<React.ComponentProps<typeof RichTextEditor>> = {}) {
  const onSubmit = vi.fn()
  const utils = render(<RichTextEditor onSubmit={onSubmit} attachments={LIMITS} {...props} />)
  await waitFor(() => expect(utils.container.querySelector('.ProseMirror')).not.toBeNull())
  const pm = utils.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }
  return { ...utils, onSubmit, pm, editor: pm.editor, wrapper: utils.container.querySelector('.comment-editor-wrapper') as HTMLElement }
}

const input = (c: HTMLElement) => c.querySelector('input[type="file"]') as HTMLInputElement

async function pick(c: HTMLElement, ...files: File[]) {
  await act(async () => { await userEvent.upload(input(c), files) })
}

function dataTransfer(files: File[], html = '') {
  return {
    files,
    types: ['Files'],
    getData: (t: string) => (t === 'text/html' ? html : ''),
    items: files.map(f => ({ kind: 'file', type: f.type })),
  }
}

function uploadCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')
}

describe('composer attachments, availability', () => {
  it('has no paperclip when attachments are off', async () => {
    await mount({ attachments: null })
    expect(screen.queryByRole('button', { name: 'Attach a file' })).toBeNull()
  })

  it('has no paperclip on an editor that does not ask for attachments', async () => {
    await mount({ attachments: undefined })
    expect(screen.queryByRole('button', { name: 'Attach a file' })).toBeNull()
  })

  it('has a paperclip in the toolbar when attachments are on', async () => {
    const { container } = await mount()
    const button = screen.getByRole('button', { name: 'Attach a file' })
    expect(container.querySelector('.tiptap-toolbar')).toContainElement(button)
    expect(button.querySelector('svg.tiptap-button-icon')).not.toBeNull()
  })

  it('opens the file picker from the paperclip', async () => {
    const { container } = await mount()
    const click = vi.spyOn(input(container), 'click')
    await userEvent.click(screen.getByRole('button', { name: 'Attach a file' }))
    expect(click).toHaveBeenCalled()
  })
})

describe('composer attachments, adding files', () => {
  it('uploads a picked file and lists it with its type, name, and size', async () => {
    const { container } = await mount()
    await pick(container, pdf('budget memo.pdf', 2048))
    const [url, init] = uploadCalls()[0]
    expect(url).toBe('/api/attachments?name=budget%20memo.pdf')
    expect((init.body as File).name).toBe('budget memo.pdf')
    const row = await screen.findByRole('listitem', { name: /budget memo\.pdf/ })
    expect(row).toHaveTextContent('2 KB')
    expect(row).toHaveTextContent('PDF')
  })

  it('shows a file as uploading until the server answers', async () => {
    let finish!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(r => { finish = r }))
    const { container } = await mount()
    await pick(container, pdf())
    expect((await screen.findAllByText(/Uploading/)).length).toBeGreaterThan(0)
    await act(async () => { finish(new Response(JSON.stringify({ id: 'att9', name: 'memo.pdf', contentType: 'application/pdf', size: 2048 }), { status: 201 })) })
    await waitFor(() => expect(screen.queryByText(/Uploading/)).toBeNull())
  })

  it('attaches files dropped on the editor, and shows the overlay while dragging over', async () => {
    const { wrapper, pm } = await mount()
    expect(screen.queryByText('Drop to attach')).toBeNull()
    fireEvent.dragEnter(wrapper, { dataTransfer: dataTransfer([pdf()]) })
    expect(screen.getByText('Drop to attach')).toBeInTheDocument()
    fireEvent.drop(pm, { dataTransfer: dataTransfer([pdf('dropped.pdf')]) })
    await screen.findByRole('listitem', { name: /dropped\.pdf/ })
    expect(screen.queryByText('Drop to attach')).toBeNull()
    expect(uploadCalls()).toHaveLength(1)
  })

  it('attaches files dropped on the toolbar, once', async () => {
    const { wrapper } = await mount()
    const toolbar = wrapper.querySelector('.tiptap-toolbar') as HTMLElement
    fireEvent.drop(toolbar, { dataTransfer: dataTransfer([pdf('bar.pdf')]) })
    await screen.findByRole('listitem', { name: /bar\.pdf/ })
    expect(uploadCalls()).toHaveLength(1)
  })

  it('drops the overlay when the drag leaves', async () => {
    const { wrapper } = await mount()
    fireEvent.dragEnter(wrapper, { dataTransfer: dataTransfer([pdf()]) })
    fireEvent.dragLeave(wrapper, { dataTransfer: dataTransfer([pdf()]) })
    expect(screen.queryByText('Drop to attach')).toBeNull()
  })

  it('does not show the overlay for a drag that carries no files', async () => {
    const { wrapper } = await mount()
    fireEvent.dragEnter(wrapper, { dataTransfer: { files: [], types: ['text/plain'] } })
    expect(screen.queryByText('Drop to attach')).toBeNull()
  })

  it('attaches a file pasted on its own', async () => {
    const { pm } = await mount()
    fireEvent.paste(pm, { clipboardData: dataTransfer([new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' })]) })
    await screen.findByRole('listitem', { name: /shot\.png/ })
  })

  it('leaves files alone when pasted along with HTML (a copied spreadsheet range)', async () => {
    const { pm } = await mount()
    fireEvent.paste(pm, { clipboardData: dataTransfer([new File([new Uint8Array(10)], 'image.png', { type: 'image/png' })], '<table><tr><td>1</td></tr></table>') })
    await act(async () => { await Promise.resolve() })
    expect(uploadCalls()).toHaveLength(0)
  })

  it('takes no drops when attachments are off', async () => {
    const { pm } = await mount({ attachments: null })
    fireEvent.drop(pm, { dataTransfer: dataTransfer([pdf()]) })
    await act(async () => { await Promise.resolve() })
    expect(uploadCalls()).toHaveLength(0)
  })
})

describe('composer attachments, refusals', () => {
  it("shows the server's reason on the file's row and keeps no upload for it", async () => {
    replies.push({ status: 400, body: { error: 'Scripts and programs cannot be attached' } })
    const { container, onSubmit, editor } = await mount()
    await act(async () => { editor.commands.insertContent('hello') })
    await pick(container, pdf('run.bat'))
    const row = await screen.findByRole('listitem', { name: /run\.bat/ })
    expect(row).toHaveTextContent('Scripts and programs cannot be attached')
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.any(String), [])
  })

  it('refuses an oversize file without sending it', async () => {
    const { container } = await mount({ attachments: { maxBytes: 1024, maxPerComment: 3 } })
    await pick(container, pdf('big.pdf', 2048))
    const row = await screen.findByRole('listitem', { name: /big\.pdf/ })
    expect(row).toHaveTextContent('over the 1 KB limit')
    expect(uploadCalls()).toHaveLength(0)
  })

  it('refuses a file past the per-comment limit', async () => {
    const { container } = await mount({ attachments: { maxBytes: LIMITS.maxBytes, maxPerComment: 2 } })
    await pick(container, pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'))
    const row = await screen.findByRole('listitem', { name: /c\.pdf/ })
    expect(row).toHaveTextContent('up to 2 files')
    expect(uploadCalls()).toHaveLength(2)
  })

  it('lets a refused row be dismissed', async () => {
    replies.push({ status: 400, body: { error: 'Nope' } })
    const { container } = await mount()
    await pick(container, pdf('x.pdf'))
    await screen.findByText('Nope')
    await userEvent.click(screen.getByRole('button', { name: 'Remove x.pdf' }))
    expect(screen.queryByText('Nope')).toBeNull()
    expect(fetchMock.mock.calls.filter(([, i]) => i.method === 'DELETE')).toHaveLength(0)
  })
})

describe('composer attachments, removing and posting', () => {
  it('removes an uploaded file from the row and from the server', async () => {
    const { container } = await mount()
    await pick(container, pdf('a.pdf'))
    await screen.findByRole('listitem', { name: /a\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }))
    expect(screen.queryByRole('listitem', { name: /a\.pdf/ })).toBeNull()
    const del = fetchMock.mock.calls.find(([, i]) => i.method === 'DELETE')!
    expect(del[0]).toBe('/api/attachments/att1')
  })

  it('posts the ids of the uploaded files with the comment, then clears the rows', async () => {
    const { container, onSubmit, editor } = await mount()
    await act(async () => { editor.commands.insertContent('see attached') })
    await pick(container, pdf('a.pdf'), pdf('b.pdf'))
    await screen.findByRole('listitem', { name: /b\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(onSubmit).toHaveBeenCalledWith('<p>see attached</p>', ['att1', 'att2'])
    expect(screen.queryByRole('listitem', { name: /a\.pdf/ })).toBeNull()
  })

  it('holds the Post button while a file is still uploading', async () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}))
    const { container, editor } = await mount()
    await act(async () => { editor.commands.insertContent('hello') })
    expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled()
    await pick(container, pdf())
    await screen.findAllByText(/Uploading/)
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled()
  })

  it('cancels an upload in flight when its row is removed', async () => {
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) => new Promise<Response>((_r, rej) => {
      signal = init.signal ?? undefined
      signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const { container } = await mount()
    await pick(container, pdf('slow.pdf'))
    await screen.findAllByText(/Uploading/)
    await userEvent.click(screen.getByRole('button', { name: 'Remove slow.pdf' }))
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByRole('listitem', { name: /slow\.pdf/ })).toBeNull()
  })

  it('posts a comment with only a file: Post is enabled with no text', async () => {
    const { container, onSubmit } = await mount()
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled()
    await pick(container, pdf('report.pdf'))
    await screen.findByRole('listitem', { name: /report\.pdf/ })
    expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(onSubmit).toHaveBeenCalledWith('', ['att1'])
  })

  it('keeps Post disabled while the only file is still uploading', async () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}))
    const { container } = await mount()
    await pick(container, pdf())
    await screen.findAllByText(/Uploading/)
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled()
  })

  it('keeps Post disabled for a file that was refused, with no text', async () => {
    replies = [{ status: 400, body: { error: 'Not allowed' } }]
    const { container } = await mount()
    await pick(container, pdf('bad.pdf'))
    await screen.findByText(/Not allowed/)
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled()
  })

  it('still posts a plain comment with an empty id list', async () => {
    const { onSubmit, editor } = await mount()
    await act(async () => { editor.commands.insertContent('hi') })
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(onSubmit).toHaveBeenCalledWith('<p>hi</p>', [])
  })
})

describe('composer attachments, unmounting', () => {
  const deletes = () => fetchMock.mock.calls.filter(([, i]) => i.method === 'DELETE').map(([u]) => u)

  it('removes finished, unposted uploads from the server when the composer goes away', async () => {
    const { container, unmount } = await mount()
    await pick(container, pdf('a.pdf'))
    await screen.findByRole('listitem', { name: /a\.pdf/ })
    unmount()
    expect(deletes()).toEqual(['/api/attachments/att1'])
  })

  it('leaves posted files alone when the composer goes away', async () => {
    const { container, editor, unmount } = await mount()
    await act(async () => { editor.commands.insertContent('hi') })
    await pick(container, pdf('a.pdf'))
    await screen.findByRole('listitem', { name: /a\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    unmount()
    expect(deletes()).toEqual([])
  })

  it('leaves files alone while their post is still in flight', async () => {
    const { container, editor, onSubmit, unmount } = await mount()
    onSubmit.mockImplementation(() => new Promise(() => {}))
    await act(async () => { editor.commands.insertContent('hi') })
    await pick(container, pdf('a.pdf'))
    await screen.findByRole('listitem', { name: /a\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    unmount()
    expect(deletes()).toEqual([])
  })
})

describe('composer attachments, a post that fails', () => {
  it('keeps the draft text and the file rows, and says the post failed', async () => {
    const { container, editor, onSubmit } = await mount()
    onSubmit.mockRejectedValueOnce(new Error('Server error'))
    await act(async () => { editor.commands.insertContent('my draft') })
    await pick(container, pdf('a.pdf'))
    await screen.findByRole('listitem', { name: /a\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(await screen.findByText(/couldn.t post/i)).toBeInTheDocument()
    expect(editor.getText()).toBe('my draft')
    expect(screen.getByRole('listitem', { name: /a\.pdf/ })).toBeInTheDocument()
    // And it can be tried again with the same file.
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(onSubmit).toHaveBeenLastCalledWith('<p>my draft</p>', ['att1'])
  })

  it('clears the draft and the rows once the post succeeds', async () => {
    const { container, editor, onSubmit } = await mount()
    onSubmit.mockResolvedValue(undefined)
    await act(async () => { editor.commands.insertContent('done') })
    await pick(container, pdf('a.pdf'))
    await screen.findByRole('listitem', { name: /a\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(editor.getText()).toBe(''))
    expect(screen.queryByRole('listitem', { name: /a\.pdf/ })).toBeNull()
  })
})

describe('composer attachments, saying why Post is held', () => {
  it('ties visible Uploading text to the held Post button', async () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}))
    const { container, editor } = await mount()
    await act(async () => { editor.commands.insertContent('hi') })
    await pick(container, pdf('slow.pdf'))
    const post = screen.getByRole('button', { name: 'Post' })
    await waitFor(() => expect(post).toBeDisabled())
    const note = document.getElementById(post.getAttribute('aria-describedby') ?? 'none')
    expect(note).toHaveTextContent(/Uploading/)
  })

  it('announces uploading and then done in a polite live region', async () => {
    let finish!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(r => { finish = r }))
    const { container } = await mount()
    const live = screen.getByRole('status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    await pick(container, pdf('slow.pdf'))
    await waitFor(() => expect(live).toHaveTextContent(/Uploading/))
    await act(async () => { finish(new Response(JSON.stringify({ id: 'att9', name: 'slow.pdf', contentType: 'application/pdf', size: 2048 }), { status: 201 })) })
    await waitFor(() => expect(live).toHaveTextContent(/uploaded/i))
  })
})

describe('composer attachments, focus after removing a row', () => {
  it('moves to the next row’s × when there is one', async () => {
    const { container } = await mount()
    await pick(container, pdf('a.pdf'), pdf('b.pdf'))
    await screen.findByRole('listitem', { name: /b\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }))
    expect(screen.getByRole('button', { name: 'Remove b.pdf' })).toHaveFocus()
  })

  it('moves to the previous row’s × after removing the last row', async () => {
    const { container } = await mount()
    await pick(container, pdf('a.pdf'), pdf('b.pdf'))
    await screen.findByRole('listitem', { name: /b\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Remove b.pdf' }))
    expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toHaveFocus()
  })

  it('moves to the paperclip after removing the only row', async () => {
    const { container } = await mount()
    await pick(container, pdf('a.pdf'))
    await screen.findByRole('listitem', { name: /a\.pdf/ })
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }))
    expect(screen.getByRole('button', { name: 'Attach a file' })).toHaveFocus()
  })
})
