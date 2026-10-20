import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { apiFetch, ApiError } from '../../lib/api'
import { useDemo } from '../../context/DemoContext'
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick'
import { HoverTooltip } from '../../components/HoverTooltip'
import { MissingRequiredReason, useRequiredSubmit } from '../../components/RequiredField'
import { inlineEditSaveStyle } from '../../lib/inlineEditStyles'
import { markJustCreatedDraft } from '../../lib/justCreatedDraft'

const EXPLAINER = "Track a bill before it's filed. Link it to the filed bill later to carry over its votes, comments, and notes."
const LOCKED_HOVER = 'Locked in demo mode'

const MENU_ITEM_STYLE: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', boxSizing: 'border-box',
  fontFamily: 'inherit', fontSize: fontSize.sm, padding: '6px 14px', border: 'none',
  background: 'none', color: color.textPrimary, cursor: 'pointer',
}

/**
 * The bills page's "Add draft bill" button, for admins (the page decides who
 * sees it). One click creates a blank draft and opens its page. A tenant that
 * tracks several states asks for the state first: a menu of the states that
 * have bills, or a two-letter field when none do yet.
 *
 * Single-state or multi-state comes from GET /bills/draft-defaults'
 * `tenantState` (a value means one state, null means several), fetched on the
 * click. It is deliberately not the bills page's facet-derived `isMultiState`,
 * which only counts states that already have bills and so cannot tell a
 * single-state tenant from a multi-state one whose bills sit in one state. The
 * facets call only supplies the menu's options.
 */
export function AddDraftButton() {
  const navigate = useNavigate()
  const { demoLocked } = useDemo()
  // The multi-state picker, open: the states to offer (empty means ask for a typed state).
  const [picker, setPicker] = useState<{ states: string[] } | null>(null)
  const [typedState, setTypedState] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A second click can land before the first one's re-render disables anything,
  // so the guard is a ref, not the state.
  const inFlight = useRef(false)
  // Dismissing the picker (Escape, a click outside, the button again) also drops
  // an error left beside it: the attempt it described is over.
  function closePicker() {
    setPicker(null)
    setError(null)
  }
  const ref = useDismissOnOutsideClick(picker !== null, closePicker)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  const gate = useRequiredSubmit({ missingRequired: typedState.length !== 2, blocked: busy })
  const resetGate = gate.reset

  useEffect(() => {
    if (picker === null) {
      resetGate()
      return
    }
    if (picker.states.length === 0) fieldRef.current?.focus()
    else firstItemRef.current?.focus()
  }, [picker, resetGate])

  // Runs one request at a time. `work` returns normally once it has navigated
  // or opened the picker; any throw becomes the error shown beside the button.
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create draft.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function create(state?: string) {
    const created = await apiFetch<{ id: string }>('/bills/draft', {
      method: 'POST',
      ...(state ? { body: JSON.stringify({ state }) } : {}),
    })
    setPicker(null)
    setTypedState('')
    // Marked before navigating, so the page's first render already finds it.
    markJustCreatedDraft(created.id)
    navigate('/bills/' + created.id)
  }

  function handleClick() {
    if (demoLocked) return
    if (picker) { closePicker(); return }
    void run(async () => {
      const { tenantState } = await apiFetch<{ tenantState?: string | null }>('/bills/draft-defaults')
      if (tenantState) {
        await create()
        return
      }
      // A facets failure only costs the menu's options: the admin can still type a state.
      const states = await apiFetch<{ state: Record<string, number> }>('/bills/facets')
        .then(f => Object.keys(f.state).sort())
        .catch(() => [] as string[])
      setPicker({ states })
    })
  }

  function submitTyped() {
    if (gate.refuse()) return
    void run(() => create(typedState))
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePicker()
      // The focused item or field unmounts with the picker; keep focus on the trigger.
      triggerRef.current?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    if (items.length === 0) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next].focus()
  }

  // A click may open a menu of states (a multi-state tenant), so the button always
  // says so and whether it is open, as the repo's other menu triggers do. In a
  // locked demo it is disabled and says why in its title, as the repo's other
  // locked controls do, rather than relying on a hover bubble over a disabled button.
  const button = (
    <button
      ref={triggerRef}
      type="button"
      onClick={handleClick}
      disabled={demoLocked}
      title={demoLocked ? LOCKED_HOVER : undefined}
      aria-busy={busy || undefined}
      aria-haspopup="menu"
      aria-expanded={picker !== null}
      style={{
        // A quiet "Add ..." text button: no fill, no border, secondary text.
        fontFamily: 'inherit', fontSize: fontSize.sm, fontWeight: fontWeight.medium,
        padding: '4px 6px', border: 'none', background: 'none', color: color.textSecondary,
        cursor: demoLocked ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        opacity: demoLocked ? 0.6 : 1,
      }}
    >
      Add draft bill
    </button>
  )

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 10px', minWidth: 0, maxWidth: '100%' }}>
      {demoLocked ? button : (
        <HoverTooltip text={EXPLAINER} maxWidth={300} placement="bottom">{button}</HoverTooltip>
      )}
      {error && (
        <span role="alert" style={{ minWidth: 0, overflowWrap: 'anywhere', fontSize: fontSize.sm, color: color.textErrorRed }}>{error}</span>
      )}
      {picker && (
        <div
          role={picker.states.length > 0 ? 'menu' : 'group'}
          aria-label="State for the new draft"
          onKeyDown={onMenuKeyDown}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
            background: color.white, border: `1px solid ${color.borderDefault}`,
            borderRadius: radius.lg, boxShadow: shadow.md, minWidth: 140,
            maxHeight: 300, overflowY: 'auto', padding: picker.states.length > 0 ? '4px 0' : 12,
          }}
        >
          {picker.states.length > 0 ? picker.states.map((s, i) => (
            <button
              key={s}
              ref={i === 0 ? firstItemRef : undefined}
              type="button"
              role="menuitem"
              onClick={() => { void run(() => create(s)) }}
              style={MENU_ITEM_STYLE}
            >
              {s}
            </button>
          )) : (
            <>
              <label htmlFor="add-draft-state" style={{
                display: 'block', margin: '0 0 6px', fontSize: fontSize.xs, fontWeight: fontWeight.semibold,
                letterSpacing: '0.07em', textTransform: 'uppercase', color: color.textMuted,
              }}>
                State
              </label>
              <input
                id="add-draft-state"
                ref={fieldRef}
                aria-label="State"
                aria-required="true"
                {...gate.fieldProps}
                value={typedState}
                maxLength={2}
                placeholder="UT"
                onChange={e => setTypedState(e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase())}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitTyped() } }}
                style={{
                  width: 64, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: fontSize.sm,
                  padding: '4px 8px', border: `1px solid ${color.accentBlue}`,
                  borderRadius: radius.sm, color: color.textPrimary,
                }}
              />
              <div style={{ marginTop: 10 }}>
                <button {...gate.buttonProps(submitTyped)} style={inlineEditSaveStyle(gate.disabled)}>
                  Create draft
                </button>
              </div>
              {/* Below the button, not beside it: revealing it must not move Create draft. */}
              <MissingRequiredReason {...gate.reasonProps} style={{ marginTop: 6 }} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
