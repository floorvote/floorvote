/**
 * Provider extras: fields only one provider publishes (a DC law number, say),
 * shown on the bill page under the provider's name instead of being dropped.
 * A provider declares each extra in its vocabulary file, with a label, an
 * optional explainer, and one of these display types. Central sends a bill's
 * extras with labels in the bill's rich detail, and instances pass them
 * through to one generic panel.
 *
 * Extras are display-only: nothing sorts, filters, notifies, or runs AI on
 * them. A field that needs any of those becomes a shared column instead (see
 * "Provider extras" in docs/internal/sync-pipeline.md).
 */
export const EXTRA_DISPLAYS = ['text', 'date', 'link', 'identifier'] as const

/**
 * How the bill page shows an extra's value:
 * - `text`: as written.
 * - `date`: a date, sent as YYYY-MM-DD.
 * - `link`: an http(s) URL, shown as a link.
 * - `identifier`: a code or number (a law or act number), set so it is easy to read and copy.
 */
export type ExtraDisplay = typeof EXTRA_DISPLAYS[number]

/** One extra on a bill, as central's bill detail sends it. */
export interface BillExtraField {
  key: string
  label: string
  explainer: string | null
  display: ExtraDisplay
  value: string
}

/** A bill's extras, as central's bill detail sends them: null when the bill has none. */
export interface BillExtras {
  /** The display name of the provider the extras come from, for the panel's title. */
  providerName: string
  /** In the order the provider's vocabulary declares them. */
  fields: BillExtraField[]
}
