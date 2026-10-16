import { useState } from 'react'
import { apiFetch } from '../lib/api'
import { CARD } from '../lib/cardStyle'
import { InfoTooltip } from './InfoTooltip'
import { SECTION_LABEL } from '../lib/textStyles'
import { CommentContent } from './CommentContent'
import { RichTextEditor } from './RichTextEditor'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import type { GroupNote } from '../../../shared/companionGroups'

interface PersonalNoteProps {
  billId: string
  /** The note to edit. For a bill in a companion group, every note the member wrote on its bills, each under its bill number. */
  initialContent: string | null
  /** The member's notes across the bill's companion group, this bill's first. */
  notes?: GroupNote[]
}

export function PersonalNote({ billId, initialContent, notes }: PersonalNoteProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [content, setContent] = useState(initialContent ?? '')
  // Notes from several bills in the group show stacked under their numbers.
  // The next save stores them as one note on this bill, and the API removes
  // the member's others.
  const [stacked, setStacked] = useState<GroupNote[] | null>(notes && notes.length > 1 ? notes : null)
  // The other bills' notes this page shows, stacked or, for a lone one, as
  // this bill's note. The next save replaces them, and the API deletes only
  // these, so it never removes a note this page didn't show.
  const [shownElsewhere, setShownElsewhere] = useState<string[]>(() => (notes ?? []).map(n => n.billId).filter(id => id !== billId))

  async function save(value: string | null) {
    await apiFetch(`/bills/${billId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ content: value, merges: shownElsewhere }),
    })
    setContent(value ?? '')
    setStacked(null)
    setShownElsewhere([])
    setIsEditing(false)
  }

  const isEmpty = !content.replace(/<[^>]*>/g, '').trim()

  return (
    <div style={{ ...CARD, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={SECTION_LABEL}>Personal note</span>
        <InfoTooltip text="Only visible to you, but may be included in administrative data exports." />
      </div>

      {isEditing ? (
        <RichTextEditor
          enableMentions={false}
          allowEmpty
          initialContent={content}
          placeholder="Write a personal note…"
          submitLabel="Save"
          autoFocus
          onSubmit={html => save(html.replace(/<[^>]*>/g, '').trim() ? html : null)}
          onCancel={() => setIsEditing(false)}
        />
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label="Personal note"
          onClick={() => setIsEditing(true)}
          // A role="button" div is not natively keyboard-operable. It is always
          // tabIndex={0} now (demo tenants accept notes, so it is never a
          // focus-skipped read-only box), which without this made it
          // focusable-but-inoperable for keyboard users. Space preventDefaults so
          // activating the note doesn't also scroll the page.
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsEditing(true) } }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          style={{
            cursor: 'text',
            minHeight: 60,
            border: `1px solid ${isHovered ? color.borderStrong : color.borderDefault}`,
            borderRadius: radius.md,
            padding: '6px 8px',
            background: isHovered ? color.surfaceMuted : color.white,
            transition: 'border-color 0.15s, background 0.15s',
          }}
        >
          {stacked ? (
            stacked.map(n => (
              <div key={n.billId} style={{ marginBottom: 8 }}>
                <h4 style={{ margin: '0 0 2px', fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textMuted }}>{n.billNumber}</h4>
                <CommentContent content={n.content} />
              </div>
            ))
          ) : isEmpty ? (
            <span style={{ color: color.textMuted, fontSize: fontSize.sm }}>
              Write a personal note…
            </span>
          ) : (
            <CommentContent content={content} />
          )}
        </div>
      )}
    </div>
  )
}
