import type { GroupBillTexts, GroupTextVersion } from '../../../shared/companionGroups'

/** Newest first, a tie broken by document id so the order never depends on how the versions arrived. */
const newestFirst = (a: GroupTextVersion, b: GroupTextVersion) => b.date.localeCompare(a.date) || b.docId.localeCompare(a.docId)

/**
 * The group's bills as the Bill texts list shows them (#712): each bill's
 * versions newest first, and the bills ordered by their newest version, newest
 * first, a tie broken by bill number. The order is a function of the data alone,
 * so it is the same on every page in the group. A bill with no versions has no row.
 */
export function orderGroupTexts(rows: GroupBillTexts[]): GroupBillTexts[] {
  return rows
    .filter(r => r.texts.length > 0)
    .map(r => ({ ...r, texts: [...r.texts].sort(newestFirst) }))
    .sort((a, b) => b.texts[0].date.localeCompare(a.texts[0].date) || a.billNumber.localeCompare(b.billNumber, 'en', { numeric: true }) || a.billId.localeCompare(b.billId))
}
