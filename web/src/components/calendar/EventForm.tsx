import { useImperativeHandle, useRef } from 'react'
import type { Ref } from 'react'
import { PopPanel, type PopPanelHandle } from '../ui/PopPanel'
import { EventFormFields, type EventFormValues } from './EventFormFields'
import type { BillOption } from '../BillPicker'
import type { EventPopoverPosition } from './EventPopover'
import { radius } from '../../styles/tokens'

export type { EventFormValues } from './EventFormFields'

// The `ref` prop exposes the panel's animated close() so the parent can toggle
// the form shut (e.g. clicking "Add event" again), matching EventPopover/DayPopover.
export function EventForm({ initial, billOptions, multiState, onSave, onClose, position, triggerRef, clampPosition, ref }: {
  initial?: EventFormValues
  billOptions: BillOption[]
  multiState: boolean
  onSave: (v: EventFormValues) => void
  onClose: () => void
  position: EventPopoverPosition
  triggerRef?: React.RefObject<HTMLElement | null>
  clampPosition?: (naturalHeight: number) => { left: number; top: number }
  ref?: Ref<PopPanelHandle>
}) {
  const panelRef = useRef<PopPanelHandle>(null)
  useImperativeHandle(ref, () => ({ close: () => panelRef.current?.close() }), [])

  return (
    <PopPanel
      ref={panelRef}
      onClose={onClose}
      triggerRef={triggerRef}
      ariaLabel={initial?.id ? 'Edit event' : 'Add event'}
      cornerRadius={radius.md}
      transformOrigin={position.transformOrigin}
      enterOffsetY={position.enterOffsetY}
      positionStyle={position.positionStyle}
      clampPosition={clampPosition}
    >
      <EventFormFields
        initial={initial}
        billOptions={billOptions}
        multiState={multiState}
        onSave={onSave}
        onClose={() => panelRef.current?.close()}
      />
    </PopPanel>
  )
}
