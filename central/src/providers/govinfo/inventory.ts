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
 * The full read this ticket builds reads a few fields into a bill's compact
 * record (map.ts) and the rest of a bill is read at ingest. "Read at ingest"
 * below means the ticket that downloads the whole file again for a bill's
 * detail (#617 bill detail, #618 roll calls), which is not built yet. The four
 * extras are named here because the vocabulary declares them, and the same
 * ticket fills them.
 */

const ingest = (what: string, ticket = '#617') => ({ ignored: `Read at ingest by the bill detail ticket (${ticket}), not by the full read: ${what}.` })

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
  // An action that names a committee puts the bill In committee. Which committee is read at ingest.
  'bill.actions.item[].committees.item[].name': 'mapped',
  'bill.actions.item[].committees.item[].systemCode': 'mapped',
  'bill.actions.item[].actionTime': { ignored: 'The time of day. Actions are ordered as the feed lists them (newest first), never by time.' },
  'bill.actions.item[].calendarNumber': ingest('the calendar an action placed the bill on'),
  'bill.actions.item[].recordedVotes': ingest('the roll calls an action links', '#618'),
  'bill.actions.item[].sourceSystem': { ignored: 'Which system recorded an action (Library of Congress, House floor, Senate). A bill\'s duplicate actions from different systems are read the same way.' },

  'bill.latestAction.actionDate': 'mapped',
  'bill.latestAction.text': 'mapped',
  'bill.latestAction.actionTime': { ignored: 'The time of day of the latest action.' },

  // Committees. A bill's own record of a referral stands in for an action that carries none.
  'bill.committees.item[].activities.item[].name': 'mapped',
  'bill.committees.item[].activities.item[].date': 'mapped',
  'bill.committees.item[].name': ingest('committees and their referrals'),
  'bill.committees.item[].systemCode': ingest('committees, whose ids are minted from the system code'),
  'bill.committees.item[].chamber': ingest('committees and their referrals'),
  'bill.committees.item[].type': ingest('committees and their referrals'),
  'bill.committees.item[].subcommittees': ingest('subcommittees and their referrals'),

  // Laws. A law element is also what makes a bill a law.
  'bill.laws.item[].number': { extra: 'publicLaw' },
  'bill.laws.item[].type': { extra: 'publicLaw' },

  // The four extras.
  'bill.policyArea.name': { extra: 'policyArea' },
  'bill.summaries.summary[].text': { extra: 'summary' },
  'bill.summaries.summary[].cdata.text': { extra: 'summary' },
  'bill.summaries.summary[].versionCode': { extra: 'summary' },
  'bill.summaries.summary[].actionDesc': { extra: 'summary' },
  'bill.summaries.summary[].actionDate': { extra: 'summary' },
  'bill.summaries.summary[].updateDate': { ignored: 'When a summary was last changed. Left out of the record hash.' },
  'bill.cboCostEstimates.item[].url': { extra: 'costEstimate' },
  'bill.cboCostEstimates.item[].title': { extra: 'costEstimate' },
  'bill.cboCostEstimates.item[].description': { ignored: 'The CBO\'s note on which version of the bill it estimated.' },
  'bill.cboCostEstimates.item[].pubDate': { ignored: 'When the CBO published the estimate.' },

  // Sponsors, subjects, related bills, and texts: read at ingest.
  'bill.sponsors': ingest('the sponsor, by Bioguide id'),
  'bill.cosponsors': ingest('the cosponsors, by Bioguide id, withdrawn ones left out'),
  'bill.onBehalfOfSponsor': ingest('whom a bill was introduced on behalf of, which the sponsor list doesn\'t carry'),
  'bill.subjects.legislativeSubjects': ingest('the legislative subjects'),
  'bill.subjects.policyArea': { ignored: 'The policy area again, with its updateDate. bill.policyArea is read.' },
  'bill.relatedBills': ingest('related bills, with the relationship labels the vocabulary maps'),
  'bill.textVersions': ingest('the text versions, which become texts'),

  // Out of scope for the GovInfo provider (#612).
  'bill.amendments': { ignored: 'Amendments, which the GovInfo spec leaves out of scope.' },
  'bill.committeeReports': { ignored: 'Committee reports, which the GovInfo spec leaves out of scope.' },
  'bill.notes': { ignored: 'Notes the Library of Congress adds to a bill, in HTML, which the provider doesn\'t show.' },
  'bill.constitutionalAuthorityStatementText': { ignored: 'The sponsor\'s statement of constitutional authority, as Congressional Record markup, which the provider doesn\'t show.' },
  'bill.cdata': { ignored: 'A wrapper for the constitutional authority statement in some files, and empty in others.' },

  dublinCore: { ignored: 'The Dublin Core block: format, language, rights, contributor, and a description of the file. The same on every file, and left out of the record hash.' },
}
