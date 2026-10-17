import type { FieldInventory } from '../sdk'

/**
 * Every field of a Bill Status file (`BILLSTATUS-119hr3132.xml` in GovInfo's
 * bulk zips), and what the provider does with it. The mapping test checks the
 * recorded files against it, and a second check covers every field in all
 * 19,690 files of the 119th Congress, so a field GovInfo starts sending fails
 * both until someone decides what to do with it.
 *
 * A path is dotted from the file's root element, which isn't named. Every
 * `item` (and `summary`, `amendment`, `committeeReport`, `link`, and
 * `recordedVote`, which a file repeats too) is an array, written `item[]`
 * however many a file has, so `bill.actions.item[].actionCode` is the code of
 * each of a bill's actions. An ignored element covers everything inside it.
 *
 * The full read reads a few fields into a bill's compact record (map.ts). The
 * ingest of a tracked bill downloads the whole file again and reads the rest
 * (detail.ts): history, sponsors, texts, committees, subjects, related bills,
 * and the four extras the vocabulary declares. "Read at ingest" below means a
 * field the ingest of roll calls reads (#618), which isn't built yet.
 */

const ingest = (what: string) => ({ ignored: `Read at ingest by the roll call ticket (#618), not by the bill detail ingest: ${what}.` })

export const billInventory: FieldInventory = {
  version: { ignored: 'The file format\'s version (3.0.0 on every file). The structure is checked instead: a file the record can\'t be read from fails closed.' },

  // The bill itself.
  'bill.number': 'mapped',
  'bill.type': 'mapped',
  'bill.congress': 'mapped',
  'bill.originChamber': { ignored: 'The chamber\'s name ("House"). originChamberCode is read instead.' },
  'bill.originChamberCode': 'mapped',
  'bill.introducedDate': 'mapped',
  'bill.title': 'mapped',
  'bill.legislationUrl': { ignored: 'The bill\'s congress.gov address, which is built from the Congress, the type, and the number (missing from some files).' },
  'bill.updateDate': { ignored: 'When the file was last regenerated. Left out of the record hash, or a restamp would look like a change.' },
  'bill.updateDateIncludingText': { ignored: 'When the file or its text was last regenerated. Left out of the record hash, like updateDate.' },

  // Titles. The "Official Title as Introduced" is the bill's description, as LegiScan has it.
  'bill.titles.item[].titleType': 'mapped',
  'bill.titles.item[].title': 'mapped',
  'bill.titles.item[].titleTypeCode': { ignored: 'The number for titleType, which is read by name.' },
  'bill.titles.item[].updateDate': { ignored: 'When the title was last changed. Left out of the record hash.' },
  'bill.titles.item[].billTextVersionCode': { ignored: 'The text version a title belongs to. Only the title as introduced is read.' },
  'bill.titles.item[].billTextVersionName': { ignored: 'The text version a title belongs to. Only the title as introduced is read.' },
  'bill.titles.item[].chamberCode': { ignored: 'The chamber a title belongs to. Only the title as introduced is read.' },
  'bill.titles.item[].chamberName': { ignored: 'The chamber a title belongs to. Only the title as introduced is read.' },
  'bill.titles.item[].sourceSystem': { ignored: 'Where a title came from (Library of Congress).' },

  // Actions. A bill's status comes from these, oldest first, and only from their structured fields.
  'bill.actions.item[].actionDate': 'mapped',
  'bill.actions.item[].actionCode': 'mapped',
  'bill.actions.item[].type': 'mapped',
  // The latest action's text is kept; no other action's text is ever read for a status.
  'bill.actions.item[].text': 'mapped',
  // An action that names a committee puts the bill In committee. The committees themselves are read from the bill's own list.
  'bill.actions.item[].committees.item[].name': { ignored: 'The committee an action names. That it names one puts the bill In committee, and the committee is read from the bill\'s own list.' },
  'bill.actions.item[].committees.item[].systemCode': { ignored: 'The committee an action names. That it names one puts the bill In committee, and the committee is read from the bill\'s own list.' },
  'bill.actions.item[].actionTime': { ignored: 'The time of day. Actions are ordered as the feed lists them (newest first), never by time.' },
  'bill.actions.item[].calendarNumber': { ignored: 'The calendar number an action placed the bill on, which the action\'s own text already says.' },
  'bill.actions.item[].recordedVotes': ingest('the roll calls an action links'),
  // An action's chamber comes from its source system, and the Library of Congress's duplicate introduction is dropped by it.
  'bill.actions.item[].sourceSystem.name': 'mapped',
  'bill.actions.item[].sourceSystem.code': { ignored: 'The number for the source system\'s name, which is read by name.' },

  'bill.latestAction.actionDate': 'mapped',
  'bill.latestAction.text': 'mapped',
  'bill.latestAction.actionTime': { ignored: 'The time of day of the latest action.' },

  // Committees. A bill's own record of a referral stands in for an action that carries none.
  'bill.committees.item[].activities.item[].name': 'mapped',
  'bill.committees.item[].activities.item[].date': 'mapped',
  'bill.committees.item[].name': 'mapped',
  'bill.committees.item[].systemCode': 'mapped',
  'bill.committees.item[].chamber': 'mapped',
  'bill.committees.item[].type': { ignored: 'Standing, Select, Special, or Other, which the committee\'s name already says.' },
  'bill.committees.item[].subcommittees': { ignored: 'Subcommittees and their referrals. A bill\'s committee is the full committee, and a subcommittee\'s referral is the full committee\'s too.' },

  // Laws. A law element is also what makes a bill a law.
  'bill.laws.item[].number': { extra: 'publicLaw' },
  'bill.laws.item[].type': { extra: 'publicLaw' },

  // The four extras.
  'bill.policyArea.name': { extra: 'policyArea' },
  'bill.summaries.summary[].text': { extra: 'summary' },
  'bill.summaries.summary[].cdata.text': { extra: 'summary' },
  'bill.summaries.summary[].versionCode': { ignored: 'The number for a summary\'s actionDesc, which is shown in words.' },
  'bill.summaries.summary[].actionDesc': { extra: 'summary' },
  'bill.summaries.summary[].actionDate': { extra: 'summary' },
  'bill.summaries.summary[].updateDate': { extra: 'summary' },
  'bill.cboCostEstimates.item[].url': { extra: 'costEstimate' },
  'bill.cboCostEstimates.item[].title': { ignored: 'The estimate\'s title, which names the bill.' },
  'bill.cboCostEstimates.item[].description': { ignored: 'The CBO\'s note on which version of the bill it estimated.' },
  'bill.cboCostEstimates.item[].pubDate': { extra: 'costEstimate' },

  // Sponsors: the sponsor and cosponsors, by Bioguide id, in the feed's order, a withdrawn cosponsor left out.
  'bill.sponsors.item[].bioguideId': 'mapped',
  'bill.sponsors.item[].fullName': 'mapped',
  'bill.sponsors.item[].firstName': 'mapped',
  'bill.sponsors.item[].middleName': 'mapped',
  'bill.sponsors.item[].lastName': 'mapped',
  'bill.sponsors.item[].party': 'mapped',
  'bill.sponsors.item[].state': 'mapped',
  'bill.sponsors.item[].district': 'mapped',
  'bill.sponsors.item[].isByRequest': { ignored: 'Whether the sponsor introduced the bill by request, which the sponsor list doesn\'t show.' },
  'bill.cosponsors.item[].bioguideId': 'mapped',
  'bill.cosponsors.item[].fullName': 'mapped',
  'bill.cosponsors.item[].firstName': 'mapped',
  'bill.cosponsors.item[].middleName': 'mapped',
  'bill.cosponsors.item[].lastName': 'mapped',
  'bill.cosponsors.item[].party': 'mapped',
  'bill.cosponsors.item[].state': 'mapped',
  'bill.cosponsors.item[].district': 'mapped',
  'bill.cosponsors.item[].sponsorshipWithdrawnDate': 'mapped',
  'bill.cosponsors.item[].sponsorshipDate': { ignored: 'When a cosponsor signed on. Cosponsors are listed in the feed\'s order, and #612 leaves cosponsor dates out of scope.' },
  'bill.cosponsors.item[].isOriginalCosponsor': { ignored: 'Whether a cosponsor signed on at introduction, which the sponsor list doesn\'t show.' },
  'bill.onBehalfOfSponsor': { ignored: 'Whom a bill was introduced on behalf of (six bills in the 119th Congress), which the sponsor list doesn\'t carry.' },

  // Subjects: the legislative subjects. The policy area is an extra.
  'bill.subjects.legislativeSubjects': 'mapped',
  'bill.subjects.legislativeSubjects.item[].name': 'mapped',
  'bill.subjects.legislativeSubjects.item[].updateDate': { ignored: 'When a subject was last changed. Left out of the record hash.' },
  'bill.subjects.policyArea': { ignored: 'The policy area again, with its updateDate. bill.policyArea is read.' },

  // Related bills: each becomes a relationship, labeled with the strongest relationship type named for it.
  'bill.relatedBills.item[].congress': 'mapped',
  'bill.relatedBills.item[].type': 'mapped',
  'bill.relatedBills.item[].number': 'mapped',
  'bill.relatedBills.item[].relationshipDetails.item[].type': 'mapped',
  'bill.relatedBills.item[].relationshipDetails.item[].identifiedBy': { ignored: 'Who named the relationship (CRS, the House, or GPO).' },
  'bill.relatedBills.item[].title': { ignored: 'The related bill\'s title, which central shows by its own bill when it has one.' },
  'bill.relatedBills.item[].latestAction': { ignored: 'The related bill\'s latest action, which central shows by its own bill when it has one.' },

  // Texts: one for each text version that has a file on GovInfo, linked by the PDF of its package.
  'bill.textVersions.item[].type': 'mapped',
  'bill.textVersions.item[].date': 'mapped',
  'bill.textVersions.item[].formats': 'mapped',
  'bill.textVersions.item[].formats.item[].url': 'mapped',
  'bill.textVersions.item[].formats.item[].type': { ignored: 'The name of a format ("United States Legislative Markup"). The link is built from the package, to its PDF.' },

  // Out of scope for the GovInfo provider (#612).
  'bill.amendments': { ignored: 'Amendments, which the GovInfo spec leaves out of scope.' },
  'bill.committeeReports': { ignored: 'Committee reports, which the GovInfo spec leaves out of scope.' },
  'bill.notes': { ignored: 'Notes the Library of Congress adds to a bill, in HTML, which the provider doesn\'t show.' },
  'bill.constitutionalAuthorityStatementText': { ignored: 'The sponsor\'s statement of constitutional authority, as Congressional Record markup, which the provider doesn\'t show.' },
  'bill.cdata': { ignored: 'A wrapper for the constitutional authority statement in some files, and empty in others.' },

  dublinCore: { ignored: 'The Dublin Core block: format, language, rights, contributor, and a description of the file. The same on every file, and left out of the record hash.' },
}
