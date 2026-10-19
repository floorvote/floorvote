// The comment composer's attachment pieces (#465): the upload state, the
// pending rows under the editor, and the paperclip. RichTextEditor wires them
// to the toolbar, the drop target, and paste.
import { useCallback, useEffect, useRef, useState } from 'react'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import {
  attachmentKind, formatFileSize, removeAttachment, uploadAttachment,
  type AttachmentLimits,
} from '../lib/attachments'

export type PendingAttachment = {
  key: string
  name: string
  size: number
  contentType: string
  status: 'uploading' | 'done' | 'refused'
  /** The server's id once uploaded. */
  id?: string
  /** Why a refused file was refused. */
  message?: string
}

export function useAttachmentUploads(limits: AttachmentLimits | null | undefined) {
  const [items, setItems] = useState<PendingAttachment[]>([])
  // A mirror, so several files added in one go count each other before React re-renders.
  const itemsRef = useRef<PendingAttachment[]>([])
  const controllers = useRef(new Map<string, AbortController>())
  const limitsRef = useRef(limits)
  limitsRef.current = limits
  const seq = useRef(0)

  const commit = useCallback((next: (prev: PendingAttachment[]) => PendingAttachment[]) => {
    itemsRef.current = next(itemsRef.current)
    setItems(itemsRef.current)
  }, [])
  const patch = useCallback((key: string, change: Partial<PendingAttachment>) => {
    commit(prev => prev.map(i => (i.key === key ? { ...i, ...change } : i)))
  }, [commit])

  const addFiles = useCallback((files: File[]) => {
    const lim = limitsRef.current
    if (!lim) return
    for (const file of files) {
      const key = `f${++seq.current}`
      const base = { key, name: file.name, size: file.size, contentType: file.type }
      const taken = itemsRef.current.filter(i => i.status !== 'refused').length
      const refusal = taken >= lim.maxPerComment
        ? `A comment can have up to ${lim.maxPerComment} files`
        : file.size > lim.maxBytes ? `This file is over the ${formatFileSize(lim.maxBytes)} limit` : null
      if (refusal) {
        commit(prev => [...prev, { ...base, status: 'refused', message: refusal }])
        continue
      }
      commit(prev => [...prev, { ...base, status: 'uploading' }])
      const ctl = new AbortController()
      controllers.current.set(key, ctl)
      uploadAttachment(file, ctl.signal)
        .then(a => patch(key, { status: 'done', id: a.id, contentType: a.contentType }))
        .catch(e => {
          if (ctl.signal.aborted) return
          patch(key, { status: 'refused', message: e instanceof Error ? e.message : 'The upload failed. Try again.' })
        })
        .finally(() => { controllers.current.delete(key) })
    }
  }, [commit, patch])

  /** The × on a row: cancels an upload in flight, or removes an uploaded file from the server. */
  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find(i => i.key === key)
    if (!item) return
    controllers.current.get(key)?.abort()
    if (item.status === 'done' && item.id) removeAttachment(item.id).catch(() => { /* the server clears it after a day */ })
    commit(prev => prev.filter(i => i.key !== key))
  }, [commit])

  /** After a post: the files belong to the comment now, so just forget the rows. */
  const clear = useCallback(() => { commit(() => []) }, [commit])

  /** Throw the draft's files away: for a cancelled or reset composer. */
  const discard = useCallback(() => {
    for (const i of [...itemsRef.current]) remove(i.key)
  }, [remove])

  // While a post is in flight its files are about to be attached: leave them be.
  const posting = useRef(false)
  const [announcement, setAnnouncement] = useState('')
  const wasUploading = useRef(false)
  const uploadingNow = items.some(i => i.status === 'uploading')
  useEffect(() => {
    if (uploadingNow) {
      const n = items.filter(i => i.status === 'uploading').length
      setAnnouncement(n === 1 ? 'Uploading 1 file' : `Uploading ${n} files`)
    } else if (wasUploading.current) {
      setAnnouncement('Files uploaded')
    }
    wasUploading.current = uploadingNow
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the count only matters while uploading
  }, [uploadingNow])

  // When the composer goes away (another bill, a remount): cancel what is in flight and
  // remove finished uploads that were never posted, rather than leave them for the daily cleanup.
  useEffect(() => () => {
    controllers.current.forEach(c => c.abort())
    if (posting.current) return
    for (const i of itemsRef.current) {
      if (i.status === 'done' && i.id) removeAttachment(i.id).catch(() => { /* the server clears it after a day */ })
    }
  }, [])

  return {
    items,
    addFiles,
    remove,
    clear,
    discard,
    setPosting: (v: boolean) => { posting.current = v },
    announcement,
    ids: () => itemsRef.current.filter(i => i.status === 'done' && i.id).map(i => i.id!),
    uploading: items.some(i => i.status === 'uploading'),
    hasFiles: items.some(i => i.status !== 'refused'),
  }
}

export function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg width="24" height="24" className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
    </svg>
  )
}

/** The type tile a file wears, in the composer and on a posted comment. */
export function AttachmentTile({ contentType, name }: { contentType: string; name: string }) {
  const kind = attachmentKind(contentType, name)
  return (
    <span aria-hidden="true" style={{
      flex: 'none', width: 34, height: 34, borderRadius: radius.md, background: kind.bg, color: kind.fg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: fontSize.xs, fontWeight: fontWeight.bold, letterSpacing: 0.3,
    }}>{kind.tile}</span>
  )
}

export function PendingAttachmentRows({ items, onRemove }: { items: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (items.length === 0) return null
  return (
    <ul aria-label="Files to attach" style={{ listStyle: 'none', margin: 0, padding: '6px 10px', borderTop: `1px solid ${color.surfaceMuted}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map(item => {
        const refused = item.status === 'refused'
        const detail = refused
          ? item.message
          : item.status === 'uploading' ? `Uploading… ${formatFileSize(item.size)}` : `${attachmentKind(item.contentType, item.name).label} · ${formatFileSize(item.size)}`
        return (
          <li key={item.key} aria-label={item.name} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px',
            border: `1px solid ${refused ? color.textDanger : color.borderDefault}`, borderRadius: radius.md,
            background: refused ? color.bgDangerFaint : color.white, opacity: item.status === 'uploading' ? 0.75 : 1,
          }}>
            <AttachmentTile contentType={item.contentType} name={item.name} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: color.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
              <span role={refused ? 'alert' : undefined} style={{ display: 'block', fontSize: fontSize.sm, color: refused ? color.textDanger : color.textMuted }}>{detail}</span>
            </span>
            <button
              type="button"
              aria-label={`Remove ${item.name}`}
              data-remove-attachment={item.key}
              onClick={() => onRemove(item.key)}
              style={{ flex: 'none', border: 'none', background: 'transparent', color: color.textMuted, cursor: 'pointer', fontSize: fontSize.xl, lineHeight: 1, padding: '2px 6px' }}
            >×</button>
          </li>
        )
      })}
    </ul>
  )
}

export function DropOverlay() {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: color.bgBlueChip, opacity: 0.94,
      border: `2px dashed ${color.linkBlue}`, borderRadius: radius.lg,
      color: color.linkBlue, fontSize: fontSize.base, fontWeight: fontWeight.semibold,
    }}>Drop to attach</div>
  )
}
