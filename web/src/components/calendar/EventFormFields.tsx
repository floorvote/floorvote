import { useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { BillPicker, type BillOption } from '../BillPicker'
import { todayIso } from '../../lib/calendarGrid'
import { useDemo } from '../../context/DemoContext'

export interface EventFormValues {
  id?: string
  description: string
  date: string
  time: string | null
  location: string | null
  billIds: string[]
  details: string | null
  url: string | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function EventFormFields({ initial, billOptions, multiState, onSave, onClose, autoFocus = true }: {
  initial?: EventFormValues
  billOptions: BillOption[]
  multiState: boolean
  onSave: (v: EventFormValues) => void
  onClose: () => void
  autoFocus?: boolean
}) {
  const [description, setDescription] = useState(initial?.description ?? '')
  const [date, setDate] = useState(initial?.date ?? '')
  const [time, setTime] = useState(initial?.time ?? '')
  const [location, setLocation] = useState(initial?.location ?? '')
  const [billIds, setBillIds] = useState<string[]>(initial?.billIds ?? [])
  const [details, setDetails] = useState(initial?.details ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const { demoLocked } = useDemo()

  const dateValid = DATE_RE.test(date)
  const urlValid = url.trim() === '' || /^https?:\/\//i.test(url.trim())
  const canSave = description.trim().length > 0 && dateValid && urlValid
  const year = dateValid ? Number(date.slice(0, 4)) : null
  const warning = !dateValid ? null
    : date < todayIso() ? 'This date is in the past.'
    : year !== null && year > new Date().getFullYear() + 5 ? 'That year looks far in the future.'
    : null

  const field: React.CSSProperties = {
    width: '100%', padding: '7px 9px', fontSize: fontSize.sm,
    borderRadius: radius.md, border: `1px solid ${color.borderDefault}`,
    marginTop: 4, boxSizing: 'border-box', fontWeight: fontWeight.normal,
  }
  const labelStyle: React.CSSProperties = { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: color.textSlate }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return
    if (e.key !== 'Enter') return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA') {
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit() }
    } else if (tag === 'INPUT') {
      e.preventDefault()
      submit()
    }
  }

  function submit() {
    if (!canSave) return
    onSave({
      id: initial?.id,
      description: description.trim(),
      date,
      time: time || null,
      location: location.trim() || null,
      billIds,
      details: details.trim() || null,
      url: url.trim() || null,
    })
  }

  return (
    <div style={{ padding: 14 }} onKeyDown={handleKeyDown}>
      <label style={{ ...labelStyle, display: 'block' }}>
        Title
        <input autoFocus={autoFocus} aria-label="Title" placeholder="New event" style={{ ...field, fontWeight: fontWeight.semibold }} value={description} onChange={e => setDescription(e.target.value)} />
      </label>

      <label style={{ ...labelStyle, display: 'block', marginTop: 10 }}>
        Date
        <input type="date" aria-label="Date" max="9999-12-31" style={field} value={date} onChange={e => setDate(e.target.value)} />
      </label>
      {warning && <div style={{ fontSize: fontSize.xs, color: color.textAmberDark, marginTop: 4 }}>{warning}</div>}

      <label style={{ ...labelStyle, display: 'block', marginTop: 10 }}>
        Time
        <input type="time" aria-label="Time" style={field} value={time} onChange={e => setTime(e.target.value)} />
      </label>

      <label style={{ ...labelStyle, display: 'block', marginTop: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span className="material-symbols-outlined" style={{ fontSize: fontSize.sm, lineHeight: 1 }}>location_on</span>
          Location
        </span>
        <input style={field} value={location} onChange={e => setLocation(e.target.value)} />
      </label>

      <label style={{ ...labelStyle, display: 'block', marginTop: 10 }}>
        Description
        <textarea aria-label="Description" rows={3} style={{ ...field, resize: 'vertical' }} value={details} onChange={e => setDetails(e.target.value)} />
      </label>

      <label style={{ ...labelStyle, display: 'block', marginTop: 10 }}>
        Link
        <input aria-label="Link" placeholder="https://…" style={field} value={url} onChange={e => setUrl(e.target.value)} />
      </label>
      {!urlValid && <div style={{ fontSize: fontSize.xs, color: color.textAmberDark, marginTop: 4 }}>Link must start with http:// or https://</div>}

      <div style={{ ...labelStyle, marginTop: 10 }}>Linked bills</div>
      <BillPicker options={billOptions} value={billIds} onChange={setBillIds} multiState={multiState} />

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" onClick={onClose} style={{ background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, padding: '7px 14px', cursor: 'pointer', fontSize: fontSize.sm }}>Cancel</button>
        <button type="button" disabled={!canSave || demoLocked} onClick={submit} style={{
          background: (canSave && !demoLocked) ? color.accentBlue : color.accentBlueMuted, color: color.white, border: 'none',
          borderRadius: radius.md, padding: '7px 14px', cursor: (canSave && !demoLocked) ? 'pointer' : 'not-allowed',
          fontSize: fontSize.sm, fontWeight: fontWeight.medium,
        }}>Save</button>
      </div>
    </div>
  )
}
