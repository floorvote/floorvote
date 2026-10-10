import type { FieldInventory } from '../sdk'

/**
 * Every field LIMS returns, and what the mapping (map.ts) does with it: one
 * inventory for the BulkData record the sync lists, one for the
 * LegislationDetails response the ingest adds. Core stores both whole
 * (`provider_records`), so an ignored field can be mapped later without
 * fetching again. The mapping test checks the recorded fixtures against these,
 * so a field LIMS starts sending fails it until someone decides what to do.
 *
 * A container listed as mapped (`actions`, `mayoralReview`) is there for when
 * LIMS sends null in its place. Its fields are listed on their own.
 */

const MEMBER_TITLE = { ignored: 'The title comes from the Councilmember\'s record (Members), which the name resolves to.' }
const REGISTER = { ignored: 'Where the D.C. Register printed it. The history\'s "Published in DC Register" entry names the volume and page.' }

/** POST BulkData/{categoryId}/{councilPeriodId}: one record per measure. */
export const bulkRecordInventory: FieldInventory = {
  legislationNumber: 'mapped',
  legislationCategory: 'mapped',
  legislationSubCategory: 'mapped',
  title: 'mapped',
  introductionDate: 'mapped',
  introducedBy: { ignored: 'Free text ("Councilmember Parker"). Sponsors come from the details response, matched to Councilmembers.' },
  coSponsors: { ignored: 'Free text, and usually empty. Sponsors come from the details response.' },
  committeeReferral: 'mapped',
  // Also the act or resolution number extra, when the details response has none.
  actResNumber: 'mapped',
  // Also the law number extra, when the details response has none.
  lawNumber: 'mapped',
  projectedLawDate: { extra: 'projectedLawDate' },
  status: 'mapped',
  'legislationHistory[].legislationNumber': { ignored: 'Repeats the record\'s own number.' },
  'legislationHistory[].actionDate': 'mapped',
  'legislationHistory[].actionDescription': 'mapped',
  'legislationHistory[].downloadURL': 'mapped',
}

/** GET LegislationDetails/{legislationNumber}. */
export const detailsInventory: FieldInventory = {
  legislationId: { ignored: 'LIMS\'s internal key. The measure number identifies the measure, and its central id is minted from that.' },
  legislationNumber: 'mapped',
  councilPeriodId: { ignored: 'The session comes from the BulkData record\'s Council Period.' },
  category: { ignored: 'The BulkData record\'s category says the same, and sets the bill type.' },
  subCategory: { ignored: 'The BulkData record\'s subcategory says the same, and sets the bill type.' },
  title: 'mapped',
  shortDescription: 'mapped',
  introductionDate: 'mapped',
  placeOfIntroduction: { ignored: 'Almost always the Office of the Secretary, and the history\'s introduction entry names it.' },
  placeRead: { ignored: 'Where the measure was read, which the history\'s reading entries cover.' },
  introducers: 'mapped',
  'introducers[].memberName': 'mapped',
  'introducers[].memberTitle': MEMBER_TITLE,
  coIntroducers: 'mapped',
  'coIntroducers[].memberName': 'mapped',
  'coIntroducers[].memberTitle': MEMBER_TITLE,
  coSponsors: 'mapped',
  'coSponsors[].memberName': 'mapped',
  'coSponsors[].memberTitle': MEMBER_TITLE,
  committeeReferralDate: 'mapped',
  committeesReferredTo: 'mapped',
  committeesReferredToWithComments: { extra: 'commentCommittees' },
  introductionPublicationDate: { ignored: 'When the D.C. Register published the introduction. The history has its own entry for it.' },
  atTheRequestOf: { extra: 'requestedBy' },
  status: 'mapped',
  legislationDocument: 'mapped',
  committeeReReferral: { ignored: 'Null in every recorded response. The history records each re-referral ("Re-Referred to ...").' },
  additionalInformation: 'mapped',

  committeeHearing: 'mapped',
  'committeeHearing[].hearingDate': 'mapped',
  'committeeHearing[].hearingType': { ignored: 'The history\'s entry for the hearing says the same ("Public Hearing on ...").' },
  'committeeHearing[].videoLink': 'mapped',
  'committeeHearing[].hearingNotice': 'mapped',
  'committeeHearing[].cancellationHearingNotice': 'mapped',
  'committeeHearing[].noticeFiledDate': 'mapped',
  'committeeHearing[].noticePublicationDate': { ignored: 'When the D.C. Register published the notice. The history has its own entry for it.' },
  'committeeHearing[].hearingRecord': 'mapped',

  committeeMarkup: 'mapped',
  'committeeMarkup[].committeeActionDate': 'mapped',
  'committeeMarkup[].committeePrint': 'mapped',
  'committeeMarkup[].committeeReport': 'mapped',
  'committeeMarkup[].reportFiledDate': 'mapped',
  'committeeMarkup[].videoLink': 'mapped',

  actions: 'mapped',
  'actions[].action': 'mapped',
  'actions[].actionDate': 'mapped',
  'actions[].videoLink': 'mapped',
  'actions[].attachmentType': { ignored: 'The attachment\'s URL names its type, which is what files it as a text or a supplement.' },
  'actions[].attachment': 'mapped',
  'actions[].voteDetails': 'mapped',
  'actions[].voteDetails.voteType': 'mapped',
  'actions[].voteDetails.voteResult': 'mapped',
  'actions[].voteDetails.votes[].councilMember': 'mapped',
  'actions[].voteDetails.votes[].vote': 'mapped',

  mayoralReview: 'mapped',
  'mayoralReview.transmittedDate': { extra: 'sentToMayor' },
  'mayoralReview.responseDueDate': { extra: 'mayorDeadline' },
  'mayoralReview.returnedDate': { ignored: 'The history\'s "Returned from Mayor" entry has it, and the signing or veto date is shown instead.' },
  'mayoralReview.signedDate': { extra: 'signedByMayor' },
  'mayoralReview.signedAct': 'mapped',
  'mayoralReview.actNumber': { extra: 'actNumber' },
  'mayoralReview.enactedDate': { extra: 'enacted' },
  'mayoralReview.vetoDate': { extra: 'vetoedByMayor' },
  'mayoralReview.expirationDate': { extra: 'actExpires' },
  'mayoralReview.actPublicationDate': REGISTER,
  'mayoralReview.actPublicationPageNumber': REGISTER,
  'mayoralReview.actPublicationVolume': REGISTER,

  congressionalReview: 'mapped',
  'congressionalReview.transmittedDate': { extra: 'sentToCongress' },
  'congressionalReview.lawProjectedDate': { extra: 'projectedLawDate' },
  'congressionalReview.effectiveDate': { extra: 'lawEffective' },
  'congressionalReview.lawNumber': { extra: 'lawNumber' },
  'congressionalReview.expirationDate': { extra: 'lawExpires' },
  'congressionalReview.lawPublicationDate': REGISTER,
  'congressionalReview.lawPublicationPageNumber': REGISTER,
  'congressionalReview.lawPublicationVolume': REGISTER,

  vendorName: { ignored: 'Set only on contracts (category 12), which the default LIMS_CATEGORIES leave out.' },
  withdrawnBy: { extra: 'withdrawnBy' },
  withdrawnDate: { extra: 'withdrawnOn' },
  linkedLegislation: { ignored: 'Empty in every recorded response, so its shape is unknown. Map it to related bills once a fixture shows one.' },
  resolutionDetails: { ignored: 'Null in every recorded response, so its shape is unknown. The resolution number comes from the BulkData record.' },

  otherDocuments: 'mapped',
  'otherDocuments[].legislationDocumentId': { ignored: 'The URL\'s own Id identifies the document, and its central id is minted from that.' },
  'otherDocuments[].documentTypeId': { ignored: 'documentTypeName says the same in words.' },
  'otherDocuments[].documentTypeName': 'mapped',
  'otherDocuments[].documentTitle': 'mapped',
  'otherDocuments[].url': 'mapped',
}

/**
 * POST Hearings/API/Public/GetHearingsCalendar (hearings.ts): one event per
 * item. The feed is undocumented, so this is everything the recorded
 * responses carry.
 */
export const hearingsInventory: FieldInventory = {
  hearingId: 'mapped',
  hearingDateTime: 'mapped',
  hearingTitle: 'mapped',
  hearingType: 'mapped',
  location: 'mapped',
  jointHearingCommittees: 'mapped',
  topics: 'mapped',
  'topics[].hearingTopicId': { ignored: 'The topic\'s own id. Nothing links to a topic on its own.' },
  'topics[].topic': 'mapped',
  'topics[].legislationNumber': 'mapped',
  address: { ignored: 'The John A. Wilson Building\'s address in every recorded event, rooms elsewhere included. location names the room.' },
  locationAddress: { ignored: 'The same as address.' },
  legislationUrl: { ignored: 'The same prefix in every event. Agenda bills link to their own pages.' },
  hearingTypeBGColor: { ignored: 'The Council site\'s display colors for the type.' },
  hearingTypeBorderColor: { ignored: 'The Council site\'s display colors for the type.' },
  witnessesCount: { ignored: 'Changes as people sign up to testify, which would change the event\'s hash and bump every subscriber\'s copy. The event page shows it.' },
  witnessListAttachment: { ignored: 'The witness list file, which the event page links.' },
}
