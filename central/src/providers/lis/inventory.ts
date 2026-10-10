import type { FieldInventory } from '../sdk'

/**
 * Every column of every LIS data file a pass reads, and what the mapping
 * (map.ts) does with it, by file: `bills[].Bill_id` is BILLS.CSV's Bill_id
 * column. Core stores each bill's joined record whole (`provider_records`),
 * with every BILLS.CSV column, so an ignored one can be mapped later without
 * reading the files again. The mapping test checks the recorded fixtures
 * against this, so a column the LIS adds fails it until someone decides what
 * to do with it.
 *
 * VOTE.CSV has no header. Its first line is `count`, and each row after it is
 * a vote's `id` and then `member` and `vote` pairs.
 */

const TEXT_VERSIONS = { ignored: 'A text version\'s document id and date. Text needs the LIS API, whose terms are non-commercial, so Virginia bills have none.' }
const LATEST_ACTION = { ignored: 'The latest action in one chamber, or by the conference committee or the Governor. The history has every action.' }
const ACTION_ID = { ignored: 'The LIS\'s internal id for a latest action. Nothing links by it.' }

export const inventory: FieldInventory = {
  'bills[].Bill_id': 'mapped',
  'bills[].Bill_description': 'mapped',
  'bills[].Patron_id': { ignored: 'The chief patron, whom Sponsors.csv lists with every other patron.' },
  'bills[].Patron_name': { ignored: 'The chief patron, whom Sponsors.csv lists with every other patron.' },
  'bills[].Last_house_committee_id': { ignored: 'The House committee the bill was last in. The history\'s referrals name every committee.' },
  'bills[].Last_house_action': LATEST_ACTION,
  'bills[].Last_house_action_date': LATEST_ACTION,
  'bills[].Last_senate_committee_id': { ignored: 'The Senate committee the bill was last in. The history\'s referrals name every committee.' },
  'bills[].Last_senate_action': LATEST_ACTION,
  'bills[].Last_senate_action_date': LATEST_ACTION,
  'bills[].Last_conference_action': LATEST_ACTION,
  'bills[].Last_conference_action_date': LATEST_ACTION,
  'bills[].Last_governor_action': LATEST_ACTION,
  'bills[].Last_governor_action_date': LATEST_ACTION,
  'bills[].Emergency': { extra: 'emergency' },
  'bills[].Passed_house': 'mapped',
  'bills[].Passed_senate': 'mapped',
  'bills[].Passed': 'mapped',
  'bills[].Failed': 'mapped',
  'bills[].Carried_over': 'mapped',
  'bills[].Approved': 'mapped',
  'bills[].Vetoed': 'mapped',
  'bills[].Full_text_doc1': TEXT_VERSIONS,
  'bills[].Full_text_date1': TEXT_VERSIONS,
  'bills[].Full_text_doc2': TEXT_VERSIONS,
  'bills[].Full_text_date2': TEXT_VERSIONS,
  'bills[].Full_text_doc3': TEXT_VERSIONS,
  'bills[].Full_text_date3': TEXT_VERSIONS,
  'bills[].Full_text_doc4': TEXT_VERSIONS,
  'bills[].Full_text_date4': TEXT_VERSIONS,
  'bills[].Full_text_doc5': TEXT_VERSIONS,
  'bills[].Full_text_date5': TEXT_VERSIONS,
  'bills[].Full_text_doc6': TEXT_VERSIONS,
  'bills[].Full_text_date6': TEXT_VERSIONS,
  'bills[].Last_house_actid': ACTION_ID,
  'bills[].Last_senate_actid': ACTION_ID,
  'bills[].Last_conference_actid': ACTION_ID,
  'bills[].Last_governor_actid': ACTION_ID,
  'bills[].Last_actid': ACTION_ID,
  // Also decides the status: a chapter means the bill became law.
  'bills[].Chapter_id': { extra: 'chapter' },
  'bills[].Introduction_date': 'mapped',

  'history[].Bill_id': 'mapped',
  'history[].History_date': 'mapped',
  'history[].History_description': 'mapped',
  'history[].History_refid': 'mapped',

  'votes.count': { ignored: 'A count the LIS writes on the first line. Its meaning isn\'t documented, and it matches neither the votes nor the rows.' },
  'votes.rows[].id': 'mapped',
  'votes.rows[].pairs[].member': 'mapped',
  'votes.rows[].pairs[].vote': 'mapped',

  'sponsors[].MEMBER_NAME': 'mapped',
  'sponsors[].MEMBER_ID': 'mapped',
  'sponsors[].BILL_NUMBER': 'mapped',
  'sponsors[].PATRON_TYPE': 'mapped',

  // The latest summary is the bill's description, and each earlier one an
  // extra by its type (summaryIntroduced, summaryPassedHouse, and so on).
  'summaries[].SUM_BILNO': 'mapped',
  'summaries[].SUMMARY_DOCID': { ignored: 'The summary\'s document id. Nothing links by it.' },
  'summaries[].SUMMARY_TYPE': 'mapped',
  'summaries[].SUMMARY_TEXT': 'mapped',

  'fiscal[].HST_BILNO': 'mapped',
  'fiscal[].HST_REFID': 'mapped',
  'fiscal[].HST_URL': 'mapped',

  'dockets[].Com_no': 'mapped',
  'dockets[].Doc_date': 'mapped',
  'dockets[].Doc_no': 'mapped',
  'dockets[].Bill_no': 'mapped',

  'subdockets[].Com_no': 'mapped',
  'subdockets[].Sub_no': 'mapped',
  'subdockets[].Doc_date': 'mapped',
  'subdockets[].Bill_no': 'mapped',

  'members[].MBR_HOU': 'mapped',
  'members[].MBR_MBRNO': 'mapped',
  'members[].MBR_NAME': 'mapped',

  'committees[].CHAMBER': { ignored: 'The committee number\'s first letter says the same (H01, S01).' },
  'committees[].COM_NAME': 'mapped',
  'committees[].COM_COMNO': 'mapped',
}
