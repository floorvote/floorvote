/**
 * Starting points for a team's DC Council calendar rules (Settings →
 * Configuration → DC Council calendar). A preset fills the form; the team then
 * edits and saves it, so nothing here is applied on its own.
 *
 * Committees and hearing types are the names the Council's hearing calendar
 * uses (lims.dccouncil.gov/hearings) in Council Period 26. The settings page
 * merges them with the names in the live calendar and the team's saved rules,
 * so a new committee in a later Council period still shows up.
 */
export interface CouncilCalendarRulesShape {
  include?: { committee: string; type?: string }[]
  types?: string[]
  topicKeywords?: string[]
  trackedBills?: boolean
}

export const KNOWN_COUNCIL_COMMITTEES = [
  'Legislative Meeting',
  'Committee of the Whole',
  'Business and Economic Development',
  'Executive Administration and Labor',
  'Facilities',
  'Health',
  'Housing',
  'Human Services',
  'Judiciary and Public Safety',
  'Public Works and Operations',
  'Transportation and the Environment',
  'Youth Affairs',
]

export const KNOWN_COUNCIL_HEARING_TYPES = [
  'Hearing',
  'Roundtable',
  'Performance Oversight Hearing',
  'Budget Oversight Hearing',
  'Oversight Hearing',
  'Joint Hearing',
  'Meeting',
]

/** Plain-language gloss for a hearing type, shown next to its checkbox. */
export const COUNCIL_HEARING_TYPE_HINTS: Record<string, string> = {
  'Hearing': 'Public hearing on bills or nominations. Anyone can sign up to testify.',
  'Roundtable': 'Like a hearing, often on a resolution, a nomination, or an issue.',
  'Performance Oversight Hearing': 'Winter and early spring: each committee reviews how each agency it oversees performed over the past year.',
  'Budget Oversight Hearing': 'Spring, after the Mayor proposes a budget: each committee reviews each agency\'s proposed budget.',
  'Oversight Hearing': 'An oversight hearing on an issue or agency outside the annual cycle.',
  'Joint Hearing': 'A hearing held by two or more committees together.',
  'Meeting': 'Business meetings, including committee mark-ups where committees vote on bills.',
}

const LEGISLATIVE_AND_COW = [
  { committee: 'Legislative Meeting' },
  { committee: 'Committee of the Whole', type: 'Meeting' },
]

export const COUNCIL_CALENDAR_PRESETS: { id: string; label: string; description: string; rules: CouncilCalendarRulesShape }[] = [
  {
    id: 'youth-justice',
    label: 'Youth and criminal justice',
    description: 'Youth Affairs and Judiciary and Public Safety, legislative and breakfast meetings, and hearings on youth, corrections, and policing agencies.',
    rules: {
      include: [{ committee: 'Youth Affairs' }, { committee: 'Judiciary and Public Safety' }, ...LEGISLATIVE_AND_COW],
      topicKeywords: [
        'youth rehabilitation*', 'dyrs', 'youth services center', 'juvenile*', 'child and family services', 'cfsa',
        'metropolitan police*', 'police complaints', 'department of corrections', 'corrections information council',
        'neighborhood safety*', 'criminal justice coordinating*', 'attorney general', 'public defender*',
        'sentencing commission', 'deputy mayor for public safety*', 'office of victim services*',
      ],
      trackedBills: true,
    },
  },
  {
    id: 'public-safety',
    label: 'Public safety and policing',
    description: 'Judiciary and Public Safety, legislative meetings, and hearings on police, fire, emergency, and forensic agencies.',
    rules: {
      include: [{ committee: 'Judiciary and Public Safety' }, ...LEGISLATIVE_AND_COW],
      topicKeywords: [
        'metropolitan police*', 'police complaints', 'fire and emergency medical*', 'homeland security*',
        'unified communications', 'forensic sciences', 'chief medical examiner', 'neighborhood safety*',
        'deputy mayor for public safety*', 'department of corrections', 'attorney general',
      ],
      trackedBills: true,
    },
  },
  {
    id: 'education',
    label: 'Education',
    description: 'Legislative meetings and hearings on public schools, charter schools, OSSE, libraries, and UDC. Education is before the Committee of the Whole this period.',
    rules: {
      include: [...LEGISLATIVE_AND_COW],
      topicKeywords: [
        'public schools', 'dcps', 'public charter school*', 'state superintendent*', 'osse',
        'deputy mayor for education', 'university of the district of columbia', 'public library', 'school*',
      ],
      trackedBills: true,
    },
  },
  {
    id: 'housing',
    label: 'Housing and homelessness',
    description: 'Housing and Human Services, legislative meetings, and hearings on housing and homeless services agencies.',
    rules: {
      include: [{ committee: 'Housing' }, { committee: 'Human Services' }, ...LEGISLATIVE_AND_COW],
      topicKeywords: [
        'housing authority', 'housing and community development', 'housing finance agency', 'rental housing*',
        'tenant*', 'homeless*', 'interagency council on homelessness', 'department of human services',
      ],
      trackedBills: true,
    },
  },
  {
    id: 'health',
    label: 'Health and behavioral health',
    description: 'The Health committee, legislative meetings, and hearings on health agencies.',
    rules: {
      include: [{ committee: 'Health' }, ...LEGISLATIVE_AND_COW],
      topicKeywords: ['behavioral health', 'health care finance', 'medicaid', 'department of health', 'hospital*'],
      trackedBills: true,
    },
  },
  {
    id: 'budget',
    label: 'Budget season, every agency',
    description: 'Every budget oversight hearing, plus legislative meetings. Useful alongside another preset; expect about 50 hearings each spring.',
    rules: {
      include: [...LEGISLATIVE_AND_COW],
      types: ['Budget Oversight Hearing'],
      trackedBills: true,
    },
  },
]
