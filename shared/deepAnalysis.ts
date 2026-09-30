/**
 * Deep analyses (a bill) and hearing briefs (a calendar event): the contract
 * between FloorVote and the external worker that writes them.
 *
 * FloorVote serves the worker an input bundle with these instructions and the
 * output shape, and validates what comes back with parseDeepContent. The web
 * renders the same types. Bump DEEP_PROMPT_VERSION when the instructions or the
 * shape change in a way that should redo existing analyses.
 */
export const DEEP_PROMPT_VERSION = 3

export interface BillDeepAnalysis {
  /** Two to four sentences: what the bill does and why it matters to the team. */
  bottomLine: string
  /** Each change the bill makes, tied to the section that makes it. */
  whatChanges: { section: string; change: string; quote?: string }[]
  whoItAffects: string[]
  /** How it interacts with existing law and recent acts. */
  howItFits: string[]
  openQuestions: string[]
  testimony: { questions: string[]; amendments: string[] }
  /** Where Councilmembers stand, from recorded votes on this bill and related ones. */
  votingRecord: string[]
  /** How this relates to what the team has already said in its linked documents. */
  teamPositions: string[]
  /** Limits of the analysis, including claims to check against the source. */
  caveats: string[]
}

export interface HearingBrief {
  overview: string
  agenda: { item: string; billNumber?: string; whyItMatters: string }[]
  whatToWatch: string[]
  questionsToAsk: string[]
  testimonyAngles: string[]
  prep: string[]
  /** The committee's members and how they have voted on related bills. */
  whoIsInTheRoom: string[]
  teamPositions: string[]
  caveats: string[]
}

export type DeepKind = 'bill' | 'hearing'
export type DeepContent = BillDeepAnalysis | HearingBrief

const MAX_TEXT = 4000
const MAX_ITEMS = 40

function str(v: unknown, name: string, required = true): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${name} is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new Error(`${name} must be text`)
  const t = v.trim()
  if (t.length > MAX_TEXT) throw new Error(`${name} is longer than ${MAX_TEXT} characters`)
  if (required && !t) throw new Error(`${name} is required`)
  return t
}

function strList(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error(`${name} must be a list`)
  if (v.length > MAX_ITEMS) throw new Error(`${name} has more than ${MAX_ITEMS} items`)
  return v.map((x, i) => str(x, `${name}[${i}]`)!)
}

function objList<T>(v: unknown, name: string, each: (o: Record<string, unknown>, label: string) => T): T[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error(`${name} must be a list`)
  if (v.length > MAX_ITEMS) throw new Error(`${name} has more than ${MAX_ITEMS} items`)
  return v.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${name}[${i}] must be an object`)
    return each(x as Record<string, unknown>, `${name}[${i}]`)
  })
}

/** Validate and clean a worker's result. Throws with a message naming the bad field. */
export function parseDeepContent(kind: DeepKind, input: unknown): DeepContent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('content must be an object')
  const o = input as Record<string, unknown>
  if (kind === 'bill') {
    const t = (o.testimony ?? {}) as Record<string, unknown>
    if (typeof t !== 'object' || Array.isArray(t)) throw new Error('testimony must be an object')
    return {
      bottomLine: str(o.bottomLine, 'bottomLine')!,
      whatChanges: objList(o.whatChanges, 'whatChanges', (x, l) => {
        const quote = str(x.quote, `${l}.quote`, false)
        return { section: str(x.section, `${l}.section`)!, change: str(x.change, `${l}.change`)!, ...(quote ? { quote } : {}) }
      }),
      whoItAffects: strList(o.whoItAffects, 'whoItAffects'),
      howItFits: strList(o.howItFits, 'howItFits'),
      openQuestions: strList(o.openQuestions, 'openQuestions'),
      testimony: { questions: strList(t.questions, 'testimony.questions'), amendments: strList(t.amendments, 'testimony.amendments') },
      votingRecord: strList(o.votingRecord, 'votingRecord'),
      teamPositions: strList(o.teamPositions, 'teamPositions'),
      caveats: strList(o.caveats, 'caveats'),
    }
  }
  return {
    overview: str(o.overview, 'overview')!,
    agenda: objList(o.agenda, 'agenda', (x, l) => {
      const billNumber = str(x.billNumber, `${l}.billNumber`, false)
      return { item: str(x.item, `${l}.item`)!, ...(billNumber ? { billNumber } : {}), whyItMatters: str(x.whyItMatters, `${l}.whyItMatters`)! }
    }),
    whatToWatch: strList(o.whatToWatch, 'whatToWatch'),
    questionsToAsk: strList(o.questionsToAsk, 'questionsToAsk'),
    testimonyAngles: strList(o.testimonyAngles, 'testimonyAngles'),
    prep: strList(o.prep, 'prep'),
    whoIsInTheRoom: strList(o.whoIsInTheRoom, 'whoIsInTheRoom'),
    teamPositions: strList(o.teamPositions, 'teamPositions'),
    caveats: strList(o.caveats, 'caveats'),
  }
}

const SHARED_RULES = `Rules:
- Ground every claim about the bill in its text, and name the section. When a point comes from your general knowledge (other laws, agency history, past Council action), say so and add "(check)" so a reader knows to verify it.
- Write for advocates preparing testimony and meetings: plain language, specific, no filler. Say what the text does, then why it matters to this team.
- Never include information about any individual client or person beyond public officials acting in their roles.
- If the text is missing, partial, or unreadable, say so in caveats and keep to what you can support.
- Use the other inputs:
  - "committees": each Council committee's chair, members, and key staff, as the Council lists them today.
  - "councilmembers": this Council Period's members with their terms, each "current" or "former". Membership changes during a period (resignations, expulsions, appointments, special elections). When a vote or a position comes from a former member, say so and give the dates, and never describe a former member as sitting on a committee or voting now.
  - "votingRecord": each member's recorded votes on the team's related tracked bills.
  - "votes": recorded votes on this item itself.
  - "teamDocuments": the team's own letters, testimony, and redlines. Read them first, and say what the team has already asked for, what has or has not changed since, and which points to press now.

  Name Councilmembers only as the inputs do, and never invent a vote, a position, or a contact.
- Return only a JSON object in the shape below, with no commentary around it.`

/** Instructions for a bill's deep analysis. `teamContext` is the team's AI context. */
export function billInstructions(teamContext: string): string {
  return `You are writing a deep analysis of a bill for an advocacy team. It goes beyond the short summary the team already has: what each section changes, who it affects, how it fits with existing law, and what to raise at a hearing.

About the team:
${teamContext.trim()}

${SHARED_RULES}

Shape:
{
  "bottomLine": "2 to 4 sentences",
  "whatChanges": [{ "section": "Sec. 3(a)", "change": "what it does", "quote": "short exact quote, optional" }],
  "whoItAffects": ["..."],
  "howItFits": ["interactions with existing law and recent acts"],
  "openQuestions": ["gaps, ambiguities, implementation problems"],
  "testimony": { "questions": ["questions for the hearing"], "amendments": ["amendments worth proposing"] },
  "votingRecord": ["where members stand, from recorded votes on this and related bills, naming the votes"],
  "teamPositions": ["how this relates to what the team has already said in its documents; empty if none are linked"],
  "caveats": ["limits of this analysis"]
}`
}

/** Instructions for a hearing brief. */
export function hearingInstructions(teamContext: string): string {
  return `You are writing a brief for an advocacy team preparing for a DC Council hearing or meeting. Use the agenda, the linked bills' summaries and analyses, and what you know about the agencies involved.

About the team:
${teamContext.trim()}

${SHARED_RULES}

Shape:
{
  "overview": "what this event is and why it matters to the team, 2 to 4 sentences",
  "agenda": [{ "item": "agenda topic", "billNumber": "B26-0123, optional", "whyItMatters": "..." }],
  "whatToWatch": ["..."],
  "questionsToAsk": ["questions a Councilmember or witness could raise"],
  "testimonyAngles": ["points the team could make in testimony"],
  "prep": ["concrete preparation steps, such as signing up to testify by the deadline"],
  "whoIsInTheRoom": ["the committee's chair and members, and how each has voted on related bills"],
  "teamPositions": ["how this relates to what the team has already said in its documents; empty if none are linked"],
  "caveats": ["limits of this brief"]
}`
}
