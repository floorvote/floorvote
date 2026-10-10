import type { FieldInventory } from '../sdk'

/**
 * Every field of a record in the MGA's session file
 * ({session}/misc/billsmasterlist/legislation.json), and what the mapping
 * (map.ts) does with it. Core stores each record whole (`provider_records`),
 * so an ignored field can be mapped later without fetching again. The mapping
 * test checks the recorded fixture against this, so a field the MGA starts
 * sending fails it until someone decides what to do.
 *
 * A list listed by its own path (`Sponsors`, `Statutes`) is there for when the
 * file sends null in its place (HJ 5's Statutes). Its items' fields are listed
 * on their own.
 */

export const recordInventory: FieldInventory = {
  BillNumber: 'mapped',
  // Also the chapter extra: a chapter of the session laws ("CH0775"), or a joint resolution's number ("JR0003").
  ChapterNumber: 'mapped',
  CrossfileBillNumber: 'mapped',
  SponsorPrimary: 'mapped',
  Sponsors: 'mapped',
  'Sponsors[].Name': 'mapped',
  Synopsis: 'mapped',
  Title: 'mapped',
  Status: 'mapped',
  // Referrals, the history's committee names, and each hearing's committee.
  CommitteePrimaryOrigin: 'mapped',
  CommitteeSecondaryOrigin: 'mapped',
  CommitteePrimaryOpposite: 'mapped',
  CommitteeSecondaryOpposite: 'mapped',
  // The history, the status, and (the hearing times) the calendar.
  FirstReadingDateHouseOfOrigin: 'mapped',
  HearingDateTimePrimaryHouseOfOrigin: 'mapped',
  HearingDateTimeSecondaryHouseOfOrigin: 'mapped',
  ReportDateHouseOfOrigin: 'mapped',
  ReportActionHouseOfOrigin: 'mapped',
  SecondReadingDateHouseOfOrigin: 'mapped',
  SecondReadingActionHouseOfOrigin: 'mapped',
  ThirdReadingDateHouseOfOrigin: 'mapped',
  ThirdReadingActionHouseOfOrigin: 'mapped',
  FirstReadingDateOppositeHouse: 'mapped',
  HearingDateTimePrimaryOppositeHouse: 'mapped',
  HearingDateTimeSecondaryOppositeHouse: 'mapped',
  ReportDateOppositeHouse: 'mapped',
  ReportActionOppositeHouse: 'mapped',
  SecondReadingDateOppositeHouse: 'mapped',
  SecondReadingActionOppositeHouse: 'mapped',
  ThirdReadingDateOppositeHouse: 'mapped',
  ThirdReadingActionOppositeHouse: 'mapped',
  InteractionBetweenChambers: { extra: 'chamberInteraction' },
  PassedByMGA: 'mapped',
  EmergencyBill: { extra: 'emergency' },
  ConstitutionalAmendment: { extra: 'constitutionalAmendment' },
  BroadSubjects: 'mapped',
  'BroadSubjects[].Code': 'mapped',
  'BroadSubjects[].Name': 'mapped',
  NarrowSubjects: 'mapped',
  'NarrowSubjects[].Code': 'mapped',
  'NarrowSubjects[].Name': 'mapped',
  BillType: { ignored: 'Whether the bill was pre-filed ("Pre-Filed") or not ("Regular"). The status says Pre-filed until the first reading, and nothing after it depends on this.' },
  BillVersion: 'mapped',
  Statutes: { extra: 'statutes' },
  'Statutes[].Article.Code': { ignored: 'The MGA\'s short code for the article ("gpu"). The extra names the article by its title.' },
  'Statutes[].Article.Title': { extra: 'statutes' },
  'Statutes[].Sections[].Section': { extra: 'statutes' },
  YearAndSession: { ignored: 'The session ("2026 Regular Session"), which the file\'s path already says.' },
  StatusCurrentAsOf: { ignored: 'When the MGA last regenerated the whole file, the same on every record. Left out of the record hash too, or every bill would look changed on every regeneration.' },
}
