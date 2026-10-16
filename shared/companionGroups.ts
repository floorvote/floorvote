/**
 * Companion groups: bills linked by `identical` relationships in either
 * direction (see **Companion group** in CONTEXT.md). The shapes the instance
 * API stores and serves for them, shared with the web app.
 */

/** A bill in a group, as an event or a comment names it. */
export type GroupBill = { billId: string; billNumber: string }

/** The `team_events.type` of a group forming around a bill, or splitting from it. */
export type GroupingEventType = 'grouped' | 'split'

/**
 * A team field value one bill held that grouping replaced with another bill's
 * (see **Team field** in CONTEXT.md). A group reads each team field from the
 * member where it was set most recently, so when bills with different values
 * group, the older ones give way. Values are as the page shows them ("High",
 * "Energy, Labor"), and `label` names the field ("position", "priority", or a
 * custom field's name).
 */
export type ReplacedTeamValue = {
  field: 'position' | 'priority' | 'customField'
  /** The custom field's id, for a custom field. */
  fieldId?: string
  label: string
  billId: string
  billNumber: string
  value: string
  replacedBy: { billId: string; billNumber: string; value: string }
}

/** `team_events.metadata` for a grouping event, one row per bill. */
export type GroupingEventMetadata = {
  /** The bills this bill joined (grouped) or left (split), by bill number. */
  with: GroupBill[]
  /** Every bill in the bill's group once the event took effect, sorted. Just the bill itself after a split leaves it alone. */
  groupBillIds: string[]
  replaced: ReplacedTeamValue[]
  /**
   * The splits an admin's grouping by hand undid, each a pair of bills by bill number, when it did. Grouping a
   * bill again with one it was split from undoes that split and every other split between the two groups. Absent
   * from an event that undid none, and from one written before this was recorded.
   */
  undoneSplits?: Array<[GroupBill, GroupBill]>
}

/**
 * A grouping event as the bill page reads it. `actorName` is null when
 * FloorVote grouped or split the bills automatically, from the provider's data.
 */
export type GroupingEvent = {
  id: string
  type: GroupingEventType
  createdAt: string
  actorName: string | null
  with: GroupBill[]
  /**
   * The subset of `with` that had a comment posted on it before the event, which is what makes the line worth
   * showing when FloorVote grouped or split the bills itself: those comments now appear in this thread (grouped)
   * or no longer do (split). Computed when the bill is read, from the comments table, so a split still names the
   * bills whose comments it took away.
   */
  commentBills: GroupBill[]
  /** The team field values the grouping replaced. Always empty for a split. */
  replaced: ReplacedTeamValue[]
  /** The splits the grouping undid (see `GroupingEventMetadata`). Absent when it undid none. */
  undoneSplits?: Array<[GroupBill, GroupBill]>
}

/** One of a member's private notes in a group, as the bill page and note route serve them. */
export type GroupNote = { billId: string; billNumber: string; content: string; updatedAt: string }
