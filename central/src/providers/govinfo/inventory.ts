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
 * the four extras the vocabulary declares, and the roll calls a bill's actions
 * link (rollcalls.ts), each of which is a file of its own. Those two shapes,
 * the House Clerk's and the Senate's, have inventories below.
 */

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
  // The roll calls an action links: the address, checked against the fields, is how the ingest finds each roll call file.
  'bill.actions.item[].recordedVotes.recordedVote[].url': 'mapped',
  'bill.actions.item[].recordedVotes.recordedVote[].chamber': 'mapped',
  'bill.actions.item[].recordedVotes.recordedVote[].congress': 'mapped',
  'bill.actions.item[].recordedVotes.recordedVote[].sessionNumber': 'mapped',
  'bill.actions.item[].recordedVotes.recordedVote[].rollNumber': 'mapped',
  'bill.actions.item[].recordedVotes.recordedVote[].date': { ignored: 'When the vote was taken, in UTC. The roll call file gives the day it was taken, in Washington\'s time, so that is the one shown.' },
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

/**
 * Every field of a House Clerk roll call file (`clerk.house.gov/evs/2026/roll009.xml`),
 * written like the Bill Status inventory above, from the file's root element,
 * which isn't named. A voter's `legislator` element is mapped whole: its text
 * is the name the Clerk prints, and its attributes `name-id` (the Bioguide id),
 * `party`, and `state` are read with it. `sort-field`, `unaccented-name`, and
 * `role` (`legislator` or `speaker`) are not.
 */
export const houseRollCallInventory: FieldInventory = {
  'vote-metadata.congress': 'mapped',
  'vote-metadata.session': 'mapped',
  'vote-metadata.rollcall-num': 'mapped',
  'vote-metadata.vote-question': 'mapped',
  'vote-metadata.amendment-num': 'mapped',
  'vote-metadata.amendment-author': 'mapped',
  'vote-metadata.action-date': 'mapped',
  'vote-metadata.vote-result': 'mapped',
  'vote-metadata.vote-totals.totals-by-vote.yea-total': 'mapped',
  'vote-metadata.vote-totals.totals-by-vote.nay-total': 'mapped',
  'vote-metadata.vote-totals.totals-by-vote.present-total': 'mapped',
  'vote-metadata.vote-totals.totals-by-vote.not-voting-total': 'mapped',
  'vote-metadata.vote-totals.totals-by-vote.total-stub': { ignored: 'The label "Totals".' },
  'vote-metadata.vote-totals.totals-by-party': { ignored: 'The tally by party. The total of all parties is read, and a member\'s party comes with the member.' },
  'vote-metadata.vote-totals.totals-by-party-header': { ignored: 'The column headings of the tally by party.' },
  'vote-data.recorded-vote[].legislator': 'mapped',
  'vote-data.recorded-vote[].vote': 'mapped',
  'vote-metadata.chamber': { ignored: 'The words "U.S. House of Representatives". The chamber is the one the bill file linked the roll call under.' },
  'vote-metadata.majority': { ignored: 'The party in the majority (R or D).' },
  'vote-metadata.legis-num': { ignored: 'The measure voted on ("H R 131"). The bill file linked the roll call, so the bill is known.' },
  'vote-metadata.vote-type': { ignored: 'The kind of vote ("YEA-AND-NAY", "RECORDED VOTE", "2/3 YEA-AND-NAY"). The result says whether the question was carried.' },
  'vote-metadata.vote-desc': { ignored: 'The measure\'s title, for a vote on passage, and empty for most others. The question is read.' },
  'vote-metadata.committee': { ignored: 'The words "U.S. House of Representatives", on some files, where chamber is on the rest.' },
  'vote-metadata.action-time': { ignored: 'The time of day. The day is read.' },
}

/**
 * Every field of a Senate roll call file
 * (`senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00082.xml`),
 * written the same way. A member is named by `lis_member_id`, which senate.gov's
 * member list and congress-legislators' historical file map to a Bioguide id.
 */
export const senateRollCallInventory: FieldInventory = {
  congress: 'mapped',
  session: 'mapped',
  vote_number: 'mapped',
  vote_date: 'mapped',
  vote_question_text: 'mapped',
  question: 'mapped',
  vote_result: 'mapped',
  'count.yeas': 'mapped',
  'count.nays': 'mapped',
  'count.present': 'mapped',
  'count.absent': 'mapped',
  'members.member[].lis_member_id': 'mapped',
  'members.member[].last_name': 'mapped',
  'members.member[].first_name': 'mapped',
  'members.member[].party': 'mapped',
  'members.member[].state': 'mapped',
  'members.member[].vote_cast': 'mapped',
  'members.member[].member_full': { ignored: 'The name, party, and state as one string ("Alsobrooks (D-MD)"), which the fields it is made of give.' },
  congress_year: { ignored: 'The calendar year. The day of the vote is read.' },
  modify_date: { ignored: 'When the Senate last changed the file.' },
  vote_title: { ignored: 'A shorter title of the question, such as "Motion to Invoke Cloture: Motion to Proceed to S. 5". The question text is read.' },
  vote_result_text: { ignored: 'The result with its count ("Cloture Motion Agreed to (84-9, 3/5 majority required)"). The result and the count are read.' },
  vote_document_text: { ignored: 'A statement of what was voted on, such as an amendment\'s purpose or the bill\'s title.' },
  majority_requirement: { ignored: 'The majority the question needed ("1/2", "3/5"). The result says whether it was carried.' },
  document: { ignored: 'The measure voted on. The bill file linked the roll call, so the bill is known.' },
  amendment: { ignored: 'The amendment voted on, when the vote was on one. The question text names it.' },
  tie_breaker: { ignored: 'The Vice President\'s tie-breaking vote, when there was one. The result says how the question came out.' },
}

// Stubs: the red tests run against these empty inventories (#619).
export const meetingInventory: FieldInventory = {}
export const meetingListInventory: FieldInventory = {}
