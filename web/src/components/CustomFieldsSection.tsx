import { useState } from 'react'
import { apiFetch } from '../lib/api'
import { relativeTime, absoluteTime } from '../lib/time'
import { SECTION_LABEL } from '../lib/textStyles'
import { RichTextEditor } from './RichTextEditor'
import { CommentContent } from './CommentContent'
import { Picker } from './Picker'
import { InfoTooltip } from './InfoTooltip'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'
import { normalizeDocument, parseStoredDocuments, DOCUMENTS_PER_FIELD_MAX, type DocumentLink } from '../../../shared/customFieldValues'

export type CustomFieldDef = {
  id: string
  name: string
  slug: string | null
  type: 'binary' | 'dropdown' | 'text' | 'date' | 'document'
  options: string[] | null
  multiple?: boolean
  displayOrder: number
  pinned: boolean
}

type CustomFieldsSectionProps = {
  fields: CustomFieldDef[]
  values: Record<string, { value: string; setBy: string | null; updatedAt: string }>
  isAdmin: boolean
  onUpdate: (fieldId: string, value: string | null, setBy: string) => void
} & (
  // Bill page: each change is saved to this bill immediately.
  | { billId: string; collect?: false }
  // Collect-values mode (the create-draft form): each change only goes to
  // onUpdate, for the caller to send later; values have no "Set by" line yet.
  | { billId?: undefined; collect: true }
)

function parseMultiValue(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch { /* fall through */ }
  return [raw]
}

function pickerTriggerStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: fontSize.sm,
    padding: '4px 8px',
    borderRadius: radius.sm,
    background: active ? color.bgInfo : color.white,
    color: active ? color.linkBlue : color.textSlate,
    border: `1px solid ${active ? color.tagBorderBlue : color.borderDefault}`,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
    fontWeight: active ? fontWeight.medium : fontWeight.normal,
    fontFamily: 'inherit',
    maxWidth: 220,
  }
}

function PickerCaret({ open }: { open: boolean }) {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ flexShrink: 0 }}>
      <path
        d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const CARD: React.CSSProperties = {
  background: color.white,
  borderRadius: radius.lg,
  border: `1px solid ${color.borderDefault}`,
  boxShadow: shadow.sm,
}

const notSetStyle: React.CSSProperties = {
  color: color.textMuted,
  fontSize: fontSize.sm,
}

const auditStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  color: color.textMuted,
  cursor: 'default',
}

const inputStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  padding: '3px 8px',
  borderRadius: radius.sm,
  border: `1px solid ${color.borderDefault}`,
  fontFamily: 'inherit',
  width: 200,
}

export function CustomFieldsSection({ fields, billId, values, isAdmin, onUpdate, collect }: CustomFieldsSectionProps) {
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [hoveredFieldId, setHoveredFieldId] = useState<string | null>(null)

  if (fields.length === 0) return null

  const hasAnyValue = Object.keys(values).length > 0
  if (!isAdmin && !hasAnyValue) return null

  const sorted = [...fields].sort((a, b) => a.displayOrder - b.displayOrder)

  async function save(fieldId: string, value: string | string[] | DocumentLink[] | null) {
    if (!collect) {
      await apiFetch(`/bills/${billId}/custom-fields`, {
        method: 'PUT',
        body: JSON.stringify({ [fieldId]: value }),
      })
    }
    // Local state holds the canonical serialized form so subsequent reads parse identically.
    const serialized: string | null = value === null
      ? null
      : Array.isArray(value)
        ? (value.length === 0 ? null : JSON.stringify(value))
        : value
    onUpdate(fieldId, serialized, 'You')
    setEditingFieldId(null)
  }

  function auditLine(entry: { setBy: string | null; updatedAt: string } | undefined) {
    if (!entry || collect) return null
    return (
      <div title={absoluteTime(entry.updatedAt)} style={auditStyle}>
        Set by {entry.setBy ?? 'Unknown'} · {relativeTime(entry.updatedAt)}
      </div>
    )
  }

  const labelStyle: React.CSSProperties = {
    fontSize: fontSize.sm,
    color: color.textSecondary,
    textAlign: 'right',
    paddingRight: 10,
  }

  const ROW: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '150px 1fr',
    alignItems: 'center',
    paddingTop: 4,
    paddingBottom: 4,
  }

  function renderField(field: CustomFieldDef) {
    const entry = values[field.id]
    const currentValue = entry?.value ?? null

    if (!isAdmin && currentValue === null) return null

    if (field.type === 'binary') {
      const checked = currentValue === '1'
      return (
        <div key={field.id} style={ROW}>
          <span style={labelStyle}>{field.name}</span>
          <div style={{ display: 'flex' }}>
            <label
              aria-label={field.name}
              style={{ display: 'inline-flex', alignItems: 'center', cursor: isAdmin ? 'pointer' : 'default' }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!isAdmin}
                onChange={e => isAdmin && save(field.id, e.target.checked ? '1' : null)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0, margin: 0 }}
              />
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 16, height: 16,
                border: `1px solid ${checked ? color.linkBlue : color.borderDefault}`,
                borderRadius: radius.sm,
                background: checked ? color.linkBlue : color.white,
                flexShrink: 0,
                transition: 'background 0.1s, border-color 0.1s',
              }}>
                <span style={{ color: color.white, fontSize: fontSize.sm, lineHeight: 1, marginTop: -1, opacity: checked ? 1 : 0 }}>✓</span>
              </span>
            </label>
          </div>
          {entry && !collect && <><div />{auditLine(entry)}</>}
        </div>
      )
    }

    if (field.type === 'dropdown') {
      const parsedOptions = field.options ?? []

      if (field.multiple) {
        const arrayValue = parseMultiValue(currentValue)
        const knownValues = arrayValue.filter(v => parsedOptions.includes(v))
        const staleValues = arrayValue.filter(v => !parsedOptions.includes(v))
        const display = arrayValue.length === 0
          ? 'Not set'
          : [...knownValues, ...staleValues.map(v => `${v} (removed)`)].join(', ')
        return (
          <div key={field.id} style={ROW}>
            <span style={labelStyle}>{field.name}</span>
            <div>
              {isAdmin ? (
                <Picker
                  mode="multi"
                  value={knownValues}
                  options={parsedOptions.map(o => ({ value: o, label: o }))}
                  onChange={(next) => save(field.id, next)}
                  ariaLabel={field.name}
                  trigger={({ toggle, open }) => (
                    <button type="button" onClick={toggle} style={pickerTriggerStyle(arrayValue.length > 0)}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{display}</span>
                      <PickerCaret open={open} />
                    </button>
                  )}
                />
              ) : (
                <span style={arrayValue.length === 0 ? notSetStyle : { fontSize: fontSize.sm, color: color.textSlate }}>{display}</span>
              )}
            </div>
            {entry && !collect && <><div />{auditLine(entry)}</>}
          </div>
        )
      }

      const singleValue: string | null = typeof currentValue === 'string' ? currentValue : null
      const isStale = singleValue !== null && !parsedOptions.includes(singleValue)
      const display = singleValue
        ? (isStale ? `${singleValue} (removed)` : singleValue)
        : 'Not set'
      return (
        <div key={field.id} style={ROW}>
          <span style={labelStyle}>{field.name}</span>
          <div>
            {isAdmin ? (
              <Picker
                mode="single"
                value={singleValue}
                options={parsedOptions.map(o => ({ value: o, label: o }))}
                emptyOption={{ label: 'Not set' }}
                onChange={(next) => save(field.id, next)}
                ariaLabel={field.name}
                trigger={({ toggle, open }) => (
                  <button type="button" onClick={toggle} style={pickerTriggerStyle(singleValue !== null)}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{display}</span>
                    <PickerCaret open={open} />
                  </button>
                )}
              />
            ) : (
              <span style={singleValue ? { fontSize: fontSize.sm, color: color.textSlate } : notSetStyle}>{display}</span>
            )}
          </div>
          {entry && !collect && <><div />{auditLine(entry)}</>}
        </div>
      )
    }

    if (field.type === 'text') {
      // Collect mode: an always-open editor that reports every keystroke, like
      // the form's other rich-text fields. An Edit/Save toggle here would drop
      // text typed without clicking Save when the form is submitted.
      if (collect) {
        return (
          <div key={field.id} style={{ ...ROW, alignItems: 'start' }}>
            <span style={{ ...labelStyle, paddingTop: 6 }}>{field.name}</span>
            <div>
              <RichTextEditor
                enableMentions={false}
                allowEmpty
                initialContent={currentValue ?? ''}
                placeholder="Not set"
                onChange={html => save(field.id, html.replace(/<[^>]*>/g, '').trim() ? html : null)}
              />
            </div>
          </div>
        )
      }

      const isEditing = isAdmin && editingFieldId === field.id

      if (!isAdmin) {
        if (!currentValue) return null
        return (
          <div key={field.id} style={{ ...ROW, alignItems: 'start' }}>
            <span style={{ ...labelStyle, paddingTop: 2 }}>{field.name}</span>
            <div>
              <CommentContent content={currentValue} fontSize={12} />
              {auditLine(entry)}
            </div>
          </div>
        )
      }

      return (
        <div key={field.id} style={{ ...ROW, alignItems: 'start' }}>
          <span style={{ ...labelStyle, paddingTop: isEditing ? 6 : 2 }}>{field.name}</span>
          <div>
            {isEditing ? (
              <RichTextEditor
                enableMentions={false}
                allowEmpty
                initialContent={currentValue ?? ''}
                submitLabel="Save"
                // eslint-disable-next-line jsx-a11y/no-autofocus -- pre-existing: focus follows the user's own click/Enter into edit mode, out of scope for this task's focus-management redesign
                autoFocus
                onSubmit={html => save(field.id, html.replace(/<[^>]*>/g, '').trim() ? html : null)}
                onCancel={() => setEditingFieldId(null)}
              />
            ) : (
              <button
                type="button"
                aria-label={`Edit ${field.name}`}
                onClick={() => setEditingFieldId(field.id)}
                onMouseEnter={() => setHoveredFieldId(field.id)}
                onMouseLeave={() => setHoveredFieldId(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  margin: 0,
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: 'text',
                  minHeight: 28,
                  border: `1px solid ${hoveredFieldId === field.id ? color.borderStrong : color.borderDefault}`,
                  borderRadius: radius.md,
                  padding: '4px 8px',
                  background: hoveredFieldId === field.id ? color.surfaceMuted : color.white,
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                {currentValue
                  ? <CommentContent content={currentValue} fontSize={12} />
                  : <span style={notSetStyle}>Click to add…</span>
                }
              </button>
            )}
            {!isEditing && auditLine(entry)}
          </div>
        </div>
      )
    }

    if (field.type === 'date') {
      return (
        <div key={field.id} style={ROW}>
          <span style={labelStyle}>{field.name}</span>
          <div>
            {isAdmin
              ? (
                <input
                  type="date"
                  aria-label={field.name}
                  value={currentValue ?? ''}
                  onChange={e => save(field.id, e.target.value || null)}
                  style={inputStyle}
                />
              )
              : <span style={currentValue ? { fontSize: fontSize.sm, color: color.textSlate } : notSetStyle}>{currentValue ?? 'Not set'}</span>
            }
          </div>
          {entry && !collect && <><div />{auditLine(entry)}</>}
        </div>
      )
    }

    if (field.type === 'document') {
      const docs = parseStoredDocuments(currentValue)
      return (
        <div key={field.id} style={{ ...ROW, alignItems: 'start' }}>
          <span style={{ ...labelStyle, paddingTop: 2 }}>{field.name}</span>
          <div>
            <DocumentList
              fieldName={field.name}
              docs={docs}
              isAdmin={isAdmin}
              onChange={next => save(field.id, next.length === 0 ? null : next)}
            />
            {entry && !collect && auditLine(entry)}
          </div>
        </div>
      )
    }

    return null
  }

  return (
    <div style={{ ...CARD, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={SECTION_LABEL}>Custom fields</span>
        <InfoTooltip text="Admins can create custom fields and set their values." maxWidth={240} />
      </div>
      <div>
        {sorted.map(renderField)}
      </div>
    </div>
  )
}

/** A document field: titled links, each opening in a new tab. Admins can add
 *  and remove them; the server checks every link again (https only). */
function DocumentList({ fieldName, docs, isAdmin, onChange }: {
  fieldName: string
  docs: DocumentLink[]
  isAdmin: boolean
  onChange: (next: DocumentLink[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setAdding(false); setTitle(''); setUrl(''); setError(null)
  }

  function add() {
    const r = normalizeDocument({ title, url })
    if (!r.ok) { setError(r.reason.charAt(0).toUpperCase() + r.reason.slice(1) + '.'); return }
    onChange([...docs, r.doc])
    reset()
  }

  return (
    <div>
      {docs.length === 0 && !adding && !isAdmin && <span style={notSetStyle}>Not set</span>}
      {docs.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {docs.map((d, i) => (
            <li key={`${d.url}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: fontSize.sm }}>
              <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color: color.linkBlue, overflowWrap: 'anywhere' }}>{d.title}</a>
              {isAdmin && (
                <button
                  type="button"
                  aria-label={`Remove ${d.title} from ${fieldName}`}
                  onClick={() => onChange(docs.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: color.textMuted, display: 'inline-flex' }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: fontSize.base }}>delete</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && adding && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: docs.length > 0 ? 6 : 0 }}>
          <input
            aria-label={`${fieldName} document title`}
            placeholder="Title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            style={inputStyle}
          />
          <input
            aria-label={`${fieldName} document link`}
            placeholder="https://"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            style={inputStyle}
          />
          {error && <span role="alert" style={{ fontSize: fontSize.xs, color: color.textErrorRed }}>{error}</span>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={add} style={{ ...pickerTriggerStyle(true), cursor: 'pointer' }}>Add</button>
            <button type="button" onClick={reset} style={{ ...pickerTriggerStyle(false), cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
      {isAdmin && !adding && docs.length < DOCUMENTS_PER_FIELD_MAX && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{ background: 'none', border: 'none', padding: 0, marginTop: docs.length > 0 ? 4 : 0, cursor: 'pointer', color: color.linkBlue, fontSize: fontSize.sm, fontFamily: 'inherit' }}
        >
          {docs.length === 0 ? 'Add a document…' : 'Add another…'}
        </button>
      )}
    </div>
  )
}
