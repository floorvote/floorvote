import { useState } from 'react'
import { CompactPrioritySelect } from './CompactPrioritySelect'
import { DismissAnnouncement } from './DismissAnnouncement'
import { HoverTooltip } from './HoverTooltip'
import { NewMatchChip } from './NewMatchChip'
import type { FeedListEntry } from './FeedBillList'

/**
 * The right side of a feed list entry, where a Bills list row has its priority
 * control. An admin gets the dropdown, set on the entry's lead bill (the bill
 * its title names), which for a companion group is the group's priority, as on
 * the group's card. It reads "Set priority", or the amber "New · Set priority"
 * with Dismiss for an untriaged new match. Anyone else gets the read-only "New
 * match" label, or nothing: an entry here has no priority, or it would not be
 * listed.
 *
 * The dropdown sits beside the entry's links, not inside them, and the row's
 * toggle is a button apart from the list, so using it never follows a link or
 * collapses the row. It leaves the entry when a priority is saved; a failed
 * save keeps the entry and shows the dropdown's own message.
 */
export function FeedEntryPriority({ entry, isAdmin, onPrioritized, onDismissed }: {
  entry: FeedListEntry
  isAdmin: boolean
  onPrioritized: (priority: 'high' | 'medium' | 'low') => void
  onDismissed: () => void
}) {
  const [announcement, setAnnouncement] = useState('')
  const lead = entry.bills[0]
  const newMatch = !!entry.newMatch
  if (!lead) return null
  if (!isAdmin) return newMatch ? <NewMatchChip /> : null

  const select = (
    <CompactPrioritySelect
      billId={lead.id}
      current={null}
      ariaLabel={newMatch ? `Priority for ${lead.billNumber} (new match: set a priority or dismiss)` : `Priority for ${lead.billNumber}`}
      onChange={(p) => { if (p !== null) onPrioritized(p) }}
      newMatch={newMatch}
      onDismiss={() => { setAnnouncement('Dismissed'); onDismissed() }}
      errorAlign="right"
    />
  )
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <DismissAnnouncement message={announcement} />
      {/* Only a new match's control needs a word: its label alone does not say what to do. The wrapper stays
          when the word goes (Dismiss), so the select is not remounted and keyboard focus stays on it. */}
      <HoverTooltip text={newMatch ? 'New keyword match — set a priority or dismiss' : ''}>{select}</HoverTooltip>
    </span>
  )
}
