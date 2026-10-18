import type { BillExtraField } from '../../../shared/providerExtras'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import { safeDate } from '../lib/dates'
import { ExternalLinkIcon } from './ExternalLinkIcon'
import { HoverTooltip } from './HoverTooltip'

/**
 * The fields of a bill's "Additional information from <provider>" panel: one
 * row per extra, labeled as the provider's vocabulary labels it and shown by
 * its display type. Generic on purpose, so no provider needs UI code of its
 * own. Display only.
 *
 * Which fields reach the panel is `placeExtras`'s call: only those placed in
 * `panel`. The others show in the meta row (`ExtraMetaItem`), under it
 * (`ExtraDetailList`), or as chips beside the body label (`ExtraFlagChips`),
 * and every one of them takes its place from the `placement` central sends.
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

/**
 * Sort a bill's extras by `placement`, keeping the order central sent within
 * each place. Every field lands in exactly one place:
 * - a missing or unknown placement is `panel`, so a page and a central of
 *   different ages still show every value;
 * - a flag whose value isn't "Yes" is a meta item, so a value is never hidden
 *   behind a chip that says nothing;
 * - a date that is only the placeholder (`0000-00-00`) is dropped, since it
 *   says nothing.
 */
export function placeExtras(fields: BillExtraField[]): PlacedExtras {
  const placed: PlacedExtras = { meta: [], detail: [], flags: [], panel: [] }
  for (const f of fields) {
    if (f.display === 'date' && safeDate(f.value) === null) continue
    switch (f.placement) {
      case 'meta': placed.meta.push(f); break
      case 'detail': placed.detail.push(f); break
      case 'flag': (f.value === 'Yes' ? placed.flags : placed.meta).push(f); break
      default: placed.panel.push(f)
    }
  }
  return placed
}

/**
 * One meta item: "Label: value", for the bill page's meta row. The label keeps
 * its hover and click explainer. A long value wraps (it never holds the row
 * open past the page's width), and an identifier is one click from selected.
 */
export function ExtraMetaItem({ field }: { field: BillExtraField }) {
  return (
    <span data-testid={`extra-meta-${field.key}`} style={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>
      <span style={{ color: color.textMuted }}>
        <HoverTooltip text={field.explainer} describe>{field.label}</HoverTooltip>:
      </span>{' '}
      <ExtraValue field={field} />
    </span>
  )
}

/**
 * The fields placed in `detail`: a labeled, full-width list under the meta
 * row, for values too long for the dotted row. Line breaks are kept and a long
 * value wraps. Nothing for no fields.
 */
export function ExtraDetailList({ fields }: { fields: BillExtraField[] }) {
  if (fields.length === 0) return null
  return (
    <dl data-testid="extras-detail" style={{ width: '100%', boxSizing: 'border-box', margin: '0 0 6px', padding: 0, fontSize: fontSize.sm, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {fields.map(f => (
        <div key={f.key} style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, minWidth: 0 }}>
          <dt style={{ color: color.textMuted }}>
            <HoverTooltip text={f.explainer} describe>{f.label}</HoverTooltip>
          </dt>
          <dd style={{ margin: 0, color: color.textSlate, flex: '1 1 200px', minWidth: 0 }}>
            <ExtraValue field={f} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The fields placed in `flag`, as small chips named by their labels. The value is "Yes", so it isn't shown. */
export function ExtraFlagChips({ fields }: { fields: BillExtraField[] }) {
  return (
    <>
      {fields.map(f => (
        <span
          key={f.key}
          data-testid={`extra-flag-${f.key}`}
          style={{ display: 'inline-flex', alignItems: 'center', background: color.bgAmberPriority, color: color.textAmberDark, borderRadius: radius.pill, padding: '1px 8px', fontSize: fontSize.xs, fontWeight: fontWeight.medium }}
        >
          <HoverTooltip text={f.explainer} describe>{f.label}</HoverTooltip>
        </span>
      ))}
    </>
  )
}
