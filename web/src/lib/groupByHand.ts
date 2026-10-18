import { apiFetch } from './api'
import { undoSplitsConfirmText } from './splitConfirm'

/**
 * Group two bills by hand (see **Group override** in CONTEXT.md), as the
 * "Group with…" dialog and a title-matched companion suggestion (#521) both
 * do: the server's preview first, and when the grouping would undo splits, a
 * confirmation naming them, which writes nothing if declined. Answers whether
 * the bills were grouped. A refusal throws the server's ApiError (409 says why).
 */
export async function groupByHand(billId: string, billNumber: string, withBillId: string, withNumber: string): Promise<boolean> {
  const { undoneSplits = [] } = await apiFetch<{ undoneSplits?: Array<[{ billNumber: string }, { billNumber: string }]> }>(
    `/bills/${billId}/group-preview?withBillId=${encodeURIComponent(withBillId)}`)
  if (undoneSplits.length > 0 && !window.confirm(undoSplitsConfirmText(billNumber, withNumber, undoneSplits))) return false
  await apiFetch(`/bills/${billId}/group`, { method: 'POST', body: JSON.stringify({ withBillId }) })
  return true
}
