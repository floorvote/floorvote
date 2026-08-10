import { useState } from 'react'
import { apiFetch } from '../lib/api'
import { relativeTime, absoluteTime } from '../lib/time'
import { SECTION_LABEL } from '../lib/textStyles'
import { RichTextEditor } from './RichTextEditor'
import { CommentContent } from './CommentContent'
import { Picker } from './Picker'
import { InfoTooltip } from './InfoTooltip'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'

export type CustomFieldDef = {
  id: string
  name: string
  slug: string | null
  type: 'binary' | 'dropdown' | 'text' | 'date'
  options: string[] | null
  multiple?: boolean
  displayOrder: number
  pinned: boolean
}

interface CustomFieldsSectionProps {
  fields: CustomFieldDef[]
  billId: string
  values: Record<string, { value: string; setBy: string | null; updatedAt: string }>
  isAdmin: boolean
  onUpdate: (fieldId: string, value: string | null, setBy: string) => void
  disabled?: boolean
}

function parseMultiValue(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch { /* fall through */ }
  return [raw]
}

function pickerTriggerStyle(active: boolean, disabled?: boolean): React.CSSProperties {
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
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
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

export function CustomFieldsSection({ fields, billId, values, isAdmin, onUpdate, disabled }: CustomFieldsSectionProps) {
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [hoveredFieldId, setHoveredFieldId] = useState<string | null>(null)

  if (fields.length === 0) return null

  const hasAnyValue = Object.keys(values).length > 0
  if (!isAdmin && !hasAnyValue) return null

  const sorted = [...fields].sort((a, b) => a.displayOrder - b.displayOrder)

  async function save(fieldId: string, value: string | string[] | null) {
    await apiFetch(`/bills/${billId}/custom-fields`, {
      method: 'PUT',
      body: JSON.stringify({ [fieldId]: value }),
    })
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
    if (!entry) return null
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
              style={{ display: 'inline-flex', alignItems: 'center', cursor: (isAdmin && !disabled) ? 'pointer' : (isAdmin ? 'not-allowed' : 'default'), opacity: (isAdmin && disabled) ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!isAdmin || disabled}
                onChange={e => isAdmin && !disabled && save(field.id, e.target.checked ? '1' : null)}
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
          {entry && <><div />{auditLine(entry)}</>}
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
                    <button type="button" onClick={toggle} disabled={disabled} style={pickerTriggerStyle(arrayValue.length > 0, disabled)}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{display}</span>
                      <PickerCaret open={open} />
                    </button>
                  )}
                />
              ) : (
                <span style={arrayValue.length === 0 ? notSetStyle : { fontSize: fontSize.sm, color: color.textSlate }}>{display}</span>
              )}
            </div>
            {entry && <><div />{auditLine(entry)}</>}
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
                  <button type="button" onClick={toggle} disabled={disabled} style={pickerTriggerStyle(singleValue !== null, disabled)}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{display}</span>
                    <PickerCaret open={open} />
                  </button>
                )}
              />
            ) : (
              <span style={singleValue ? { fontSize: fontSize.sm, color: color.textSlate } : notSetStyle}>{display}</span>
            )}
          </div>
          {entry && <><div />{auditLine(entry)}</>}
        </div>
      )
    }

    if (field.type === 'text') {
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
                disabled={disabled}
                onSubmit={html => save(field.id, html.replace(/<[^>]*>/g, '').trim() ? html : null)}
                onCancel={() => setEditingFieldId(null)}
              />
            ) : (
              <button
                type="button"
                aria-label={`Edit ${field.name}`}
                disabled={disabled}
                onClick={() => setEditingFieldId(field.id)}
                onMouseEnter={() => setHoveredFieldId(field.id)}
                onMouseLeave={() => setHoveredFieldId(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  margin: 0,
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: disabled ? 'not-allowed' : 'text',
                  opacity: disabled ? 0.5 : 1,
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
                  disabled={disabled}
                  onChange={e => save(field.id, e.target.value || null)}
                  style={{ ...inputStyle, cursor: disabled ? 'not-allowed' : 'text', opacity: disabled ? 0.5 : 1 }}
                />
              )
              : <span style={currentValue ? { fontSize: fontSize.sm, color: color.textSlate } : notSetStyle}>{currentValue ?? 'Not set'}</span>
            }
          </div>
          {entry && <><div />{auditLine(entry)}</>}
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
