import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { FORM_LABEL } from '../lib/textStyles'
import { Dialog } from './ui/Dialog'
import { BillPicker, type BillOption } from './BillPicker'
import { MissingRequiredReason, useRequiredSubmit } from './RequiredField'

/**
 * "Group with…" from the bill page's overflow menu (admins): pick another bill
 * in the instance and group the two by hand, each with its whole group (see
 * **Group override** in CONTEXT.md). The picker offers the instance's tracked
 * bills, less drafts and the bills already in this one's group.
 */
export function GroupWithDialog({ billId, billNumber, groupBillIds, onGrouped, onClose }: {
  billId: string
  billNumber: string
  /** The bills already in this bill's group, this one included. */
  groupBillIds: readonly string[]
  onGrouped: () => void
  onClose: () => void
}) {
  const [options, setOptions] = useState<BillOption[]>([])
  const [target, setTarget] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gate = useRequiredSubmit({ missingRequired: !target, blocked: saving })

  useEffect(() => {
    let cancelled = false
    apiFetch<BillOption[]>('/calendar/bill-options')
      .then(data => { if (!cancelled) setOptions(data.filter(o => !o.isDraft && !groupBillIds.includes(o.id))) })
      .catch(() => { if (!cancelled) setError("Couldn't load bills to pick from.") })
    return () => { cancelled = true }
    // groupBillIds is a fresh array on every render of the page; the bill's id names the group well enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billId])

  async function group() {
    if (!target || saving) return
    setSaving(true)
    setError(null)
    try {
      await apiFetch(`/bills/${billId}/group`, { method: 'POST', body: JSON.stringify({ withBillId: target }) })
      onGrouped()
    } catch {
      setError("Couldn't group the bills. Try again.")
      setSaving(false)
    }
  }

  const button = (primary: boolean, disabled: boolean): React.CSSProperties => ({
    background: primary ? (disabled ? color.accentBlueMuted : color.accentBlue) : 'none',
    color: primary ? color.white : color.textSecondary,
    border: primary ? 'none' : `1px solid ${color.borderDefault}`,
    borderRadius: radius.md, padding: '8px 14px', fontSize: fontSize.sm, fontWeight: fontWeight.medium,
    cursor: disabled ? 'not-allowed' : 'pointer',
  })

  return (
    <Dialog onClose={saving ? () => {} : onClose} labelledBy="group-with-title" cardStyle={{ width: 460 }}>
      <div id="group-with-title" style={{ fontWeight: fontWeight.bold, fontSize: fontSize.base, color: color.textPrimary, marginBottom: 8 }}>
        Group {billNumber} with another bill
      </div>
      <p style={{ fontSize: fontSize.sm, color: color.textSecondary, margin: '0 0 14px', lineHeight: 1.5 }}>
        Grouped bills share one discussion, one vote per member, and the team's position, priority, and fields.
        Each keeps its own page. The grouping holds through later updates from the legislature, and splitting
        the bill from its group undoes it.
      </p>
      <label htmlFor="group-with-target" style={{ ...FORM_LABEL, marginBottom: 0 }}>Bill</label>
      <BillPicker
        options={options}
        value={target ? [target] : []}
        onChange={ids => setTarget(ids[0] ?? null)}
        multiState={options.some(o => o.state !== options[0]?.state)}
        single
        inputId="group-with-target"
        required
      />
      {error && <p role="alert" style={{ color: color.textDanger, fontSize: fontSize.sm, margin: '10px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" onClick={onClose} disabled={saving} style={button(false, saving)}>Cancel</button>
        <button type="button" {...gate.buttonProps(group)} style={button(true, gate.disabled)}>
          {saving ? 'Grouping…' : 'Group bills'}
        </button>
      </div>
      {/* Below the buttons' row, never in it: revealing it must not move them. */}
      <MissingRequiredReason {...gate.reasonProps} style={{ textAlign: 'right' }} />
    </Dialog>
  )
}
