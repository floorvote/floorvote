import type { BillExtraField } from '../../../shared/providerExtras'
import { color, fontSize, fontWeight } from '../styles/tokens'
import { safeDate } from '../lib/dates'
import { ExternalLinkIcon } from './ExternalLinkIcon'
import { HoverTooltip } from './HoverTooltip'

/**
 * The fields of a bill's "Additional information from <provider>" panel: one
 * row per extra, labeled as the provider's vocabulary labels it and shown by
 * its display type. Generic on purpose, so no provider needs UI code of its
 * own. Display only.
 */
export function ProviderExtrasList({ fields }: { fields: BillExtraField[] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, max-content) minmax(0, 1fr)', columnGap: 16, rowGap: 6, margin: 0, padding: '6px 0 6px 8px', fontSize: fontSize.sm }}>
      {fields.map(f => (
        <div key={f.key} style={{ display: 'contents' }}>
          <dt style={{ color: color.textSecondary }}>
            <HoverTooltip text={f.explainer} describe>{f.label}</HoverTooltip>
          </dt>
          <dd style={{ margin: 0, color: color.textSlate, minWidth: 0 }}>
            <ExtraValue field={f} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ExtraValue({ field }: { field: BillExtraField }) {
  switch (field.display) {
    case 'date':
      return <>{safeDate(field.value) ?? field.value}</>
    case 'link':
      // Central only sends http(s) links. Anything else shows as text, never as an href.
      return isHttpUrl(field.value) ? (
        <a
          href={field.value}
          target="_blank"
          rel="noreferrer"
          title={field.value}
          style={{ color: color.linkBlue, textDecoration: 'none', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
        >
          {field.value}<ExternalLinkIcon />
        </a>
      ) : <span style={{ overflowWrap: 'anywhere' }}>{field.value}</span>
    case 'identifier':
      // One click selects the whole identifier, for copying.
      return <span style={{ fontWeight: fontWeight.medium, fontVariantNumeric: 'tabular-nums', userSelect: 'all' }}>{field.value}</span>
    default:
      // pre-line keeps a multi-paragraph value's line breaks.
      return <span style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{field.value}</span>
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** A bill's extras sorted by where the page shows them (`placeExtras`). */
export interface PlacedExtras {
  meta: BillExtraField[]
  detail: BillExtraField[]
  flags: BillExtraField[]
  panel: BillExtraField[]
}

/** Stub: filled in by the implementation commit. */
export function placeExtras(_fields: BillExtraField[]): PlacedExtras {
  return { meta: [], detail: [], flags: [], panel: [] }
}
export function ExtraMetaItem(_p: { field: BillExtraField }) { return null }
export function ExtraDetailList(_p: { fields: BillExtraField[] }) { return null }
export function ExtraFlagChips(_p: { fields: BillExtraField[] }) { return null }
