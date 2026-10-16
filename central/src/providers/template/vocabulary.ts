import type { ProviderVocabulary } from '../sdk'

/**
 * TEMPLATE: what the provider's codes mean. Empty until the mapping writes
 * codes. Once it's in the registry, central/test/providers/vocabulary.test.ts
 * checks these rules for it.
 *
 * - `statuses`: every code the mapping writes to `bills.status`, each with a
 *   label (what members see), a common stage from shared/statusStages.ts (or
 *   null for a status outside the legislative path), a rank (the stage's
 *   position times 100, plus the provider's own order within the stage, or 0
 *   with no stage), a terminal flag (nothing more the feed publishes will move
 *   the measure), and a plain-language explainer. Labels and ranks are unique.
 *   Use a block of codes no other provider uses (LegiScan 0 to 12, LIMS the
 *   100s, MGA the 200s, LIS the 300s), and declare TEMPLATE_STATUS_BASE as the
 *   measure with no status (stage null, rank 0), as LIMS does with 100.
 * - `billTypes`: every value the mapping writes to `bill_type`, with a label.
 * - `eventTypes`: every calendar entry `type_id`, with a label and its kind
 *   (hearing, markup, meeting, or deadline, from shared/calendarKinds.ts).
 * - `calendarName`: the name of the legislature's own calendar, when the
 *   provider implements `listBodyEvents`.
 * - `extras`: fields only this feed publishes, in the order the bill page
 *   shows them, each with a label, an optional explainer, and a display type
 *   (text, date, link, or identifier, from shared/providerExtras.ts).
 * - `relationships`: if the feed links bills, a `default` map from each
 *   relationship label the mapping writes (the `type` of a `sasts` entry) to
 *   `identical` (the same bill filed twice), `package` (different bills moved
 *   together), or `related` (the kind of any label left out), and optional
 *   `states` overrides by two-letter state. Labels match by name, never by
 *   type id, ignoring case, spacing, and hyphens. Leave it out when the feed
 *   publishes nothing worth grouping.
 *
 * Explainers appear next to real bills, so keep them factual, and cite the
 * legislature's own guide to its process here.
 */
export const TEMPLATE_STATUS_BASE = 900

export const vocabulary: ProviderVocabulary = {
  statuses: {},
  billTypes: {},
  eventTypes: {},
  extras: {},
}
