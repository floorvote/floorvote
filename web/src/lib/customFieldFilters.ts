/**
 * Single source of truth for "which custom field types are filterable, and
 * how" — shared by the desktop toolbar (pages/BillList/index.tsx) and the
 * mobile drill-down sheet (components/FilterSheet.tsx), plus the parity test
 * (pages/BillList/filterDimensionParity.test.tsx).
 *
 * Custom fields are tenant-defined and dynamic (a variable count, not fixed
 * entries), so they can't live in the static registry in filterDimensions.ts
 * — but the type-to-filterability and type-to-control mapping is exactly the
 * kind of decision that must not be duplicated across surfaces, the same
 * reason that registry exists. This module is that mapping's one home.
 *
 * Only two of the four CustomFieldDef types are filterable at all:
 *   - 'binary'   -> a direct toggle, same treatment as "My bills" / "New
 *                   matches" (a single on/off control, not a list to choose
 *                   among).
 *   - 'dropdown' -> an options list, same treatment as Status / Priority /
 *                   Tags (desktop: a FilterDropdown; mobile: a drill-down
 *                   dimension whose level 2 lists the options).
 *   - 'text' and 'date' are not filterable on either surface.
 */

import type { CustomFieldDef } from '../pages/BillList/types'

export type CustomFieldFilterKind = 'toggle' | 'options'

export interface FilterableCustomField {
  def: CustomFieldDef
  kind: CustomFieldFilterKind
}

/** The one place either surface (or a test) may decide whether a custom
 *  field type is filterable, and if so, what kind of control it gets. */
export function customFieldFilterKind(type: CustomFieldDef['type']): CustomFieldFilterKind | null {
  if (type === 'binary') return 'toggle'
  if (type === 'dropdown') return 'options'
  return null
}

/** All of `defs` that are filterable, each paired with its control kind, in
 *  the order they were defined (same order desktop and mobile both use). */
export function filterableCustomFields(defs: CustomFieldDef[]): FilterableCustomField[] {
  return defs.reduce<FilterableCustomField[]>((acc, def) => {
    const kind = customFieldFilterKind(def.type)
    if (kind) acc.push({ def, kind })
    return acc
  }, [])
}
