import { useState } from 'react'
import { apiFetch } from '../lib/api'
import { CARD } from '../lib/cardStyle'
import { InfoTooltip } from './InfoTooltip'
import { SECTION_LABEL } from '../lib/textStyles'
import { CommentContent } from './CommentContent'
import { RichTextEditor } from './RichTextEditor'
import { color, fontSize, radius } from '../styles/tokens'

interface PersonalNoteProps {
  billId: string
  initialContent: string | null
}

export function PersonalNote({ billId, initialContent }: PersonalNoteProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [content, setContent] = useState(initialContent ?? '')

  async function save(value: string | null) {
    await apiFetch(`/bills/${billId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ content: value }),
    })
    setContent(value ?? '')
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
          {isEmpty ? (
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
