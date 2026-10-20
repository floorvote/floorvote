import type { Treatment } from './billTableCoverage'

// One entry per table that holds a bill id, plus any table that refers to bills
// by another key. Update this, and the Link and delete routes in
// src/routes/billsApi/draftRoutes.ts, together.
export const TREATMENT: Record<string, Treatment> = {
  comments: { link: 'moved', delete: 'deleted', reason: 'Engagement; delete refuses a draft with live comments, then removes the rest.' },
  notifications: { link: 'moved', delete: 'cascade', reason: 'Mentions carry over unread; on delete they go with the draft by foreign key.' },
  official_positions: { link: 'moved', delete: 'deleted', reason: 'Engagement; the filed bill keeps its own position when it has one.' },
  member_votes: { link: 'moved', delete: 'deleted', reason: "Engagement; the filed bill keeps a member's vote when they already voted." },
  notes: { link: 'moved', delete: 'deleted', reason: "Engagement; the filed bill keeps a member's note when they already have one." },
  bill_mutes: { link: 'moved', delete: 'cascade', reason: 'A mute follows the member to the filed bill; on delete it goes with the draft by foreign key.' },
  bill_custom_field_values: { link: 'moved', delete: 'cascade', reason: 'Team field values move; on delete they go with the draft by foreign key.' },
  calendar_event_bills: { link: 'moved', delete: 'deleted', reason: 'No foreign key, so both routes handle it; the events themselves stay.' },
  feed_events: { link: 'moved', delete: 'deleted', reason: "No foreign key; the draft's history joins the filed bill, or is removed with the draft." },
  team_events: { link: 'moved', delete: 'cascade', reason: 'Field-change history (FIELD_CHANGED) moves to the filed bill; a deleted draft has only disposable history, so it cascades.' },
  bill_texts: { link: 'cascade', delete: 'deleted', reason: "The draft's own text; the filed bill has its own." },
  bill_subjects: { link: 'cascade', delete: 'cascade', reason: 'Written by sync for filed bills; a draft has none.' },
  calendar_events: { link: 'not-applicable', delete: 'not-applicable', reason: "Only central's hearing sync writes a bill id, and a draft has no external id; custom and body events store null." },
  bill_group_overrides: { link: 'not-applicable', delete: 'not-applicable', reason: 'Grouping by hand refuses drafts, and a draft is in no group to split from.' },
  companion_suggestion_dismissals: { link: 'cascade', delete: 'cascade', reason: 'Drafts are never suggested a companion; only a direct API call writes a row, which is meaningless once the draft goes.' },
  bill_identical_links: { link: 'not-applicable', delete: 'not-applicable', reason: 'Keyed by external handle, not bill id, and a draft has no external id.' },
  public_reports: { link: 'not-applicable', delete: 'not-applicable', reason: 'bill_ids is a JSON list with no foreign key; no code path writes a report, so none names a draft.' },
}
