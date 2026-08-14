import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react'
import { useParams, Link, useNavigate, useNavigation, useLocation, useLoaderData, redirect, type LoaderFunctionArgs } from 'react-router-dom'
import { apiFetch, ApiError } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { MarkdownSummary } from '../components/MarkdownSummary'
import { BillBadge } from '../components/BillBadge'
import { PositionBadge } from '../components/PositionBadge'
import { PriorityBadge } from '../components/PriorityBadge'
import { CompactPrioritySelect } from '../components/CompactPrioritySelect'
import { NewMatchTriageControl } from '../components/NewMatchTriageControl'
import { CompactPositionSelect } from '../components/CompactPositionSelect'
import { StatusChip } from '../components/StatusChip'
import { decodeStatus } from '../lib/legislativeStatus'
import { getNoAnalysisMessage } from '../lib/billDetailCopy'
import { orgPositionLabel, orgRelevanceLabel, DEFAULT_ORG_NOUN } from '../lib/orgNoun'
import { RelevanceChip } from '../components/RelevanceChip'
import { SessionChip } from '../components/SessionChip'
import { SentimentBars } from '../components/SentimentBars'
import { LegislativeHistory, syntheticLatestAction } from '../components/LegislativeHistory'
import { TabularRow } from '../components/TabularRow'
import { BillTextPanel } from '../components/BillTextPanel'
import { BillTextChip } from '../components/BillTextChip'
import { PersonalNote } from '../components/PersonalNote'
import { InfoTooltip } from '../components/InfoTooltip'
import { ReactionPicker } from '../components/ReactionPicker'
import { usePolling } from '../hooks/usePolling'
import { useSidebarRefresh } from '../context/SidebarRefreshContext'
import { usePageTitle } from '../hooks/usePageTitle'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { TAG_CHIP, TAG_CHIP_HOVERED } from '../lib/tagChipStyle'
import { CARD } from '../lib/cardStyle'
import { COUNT_BADGE, displayName, ROLE_CHIP, TOOLTIP_STYLE, sortRoles } from '../lib/chipStyles'
import { SECTION_LABEL, CHROME_TEXT } from '../lib/textStyles'
import { HoverTooltip } from '../components/HoverTooltip'
import { ChangeHistoryTooltip, type ChangeRecord } from '../components/ChangeHistoryTooltip'
import { RichTextEditor } from '../components/RichTextEditor'
import { CommentContent } from '../components/CommentContent'
import { CustomFieldsSection, type CustomFieldDef } from '../components/CustomFieldsSection'
import { useDemo } from '../context/DemoContext'
import { useNotifications } from '../context/NotificationsContext'
import { markMentionsRead } from '../lib/demoReadState'
import { relativeTime, absoluteTime } from '../lib/time'
import { COMMENT_STYLE } from '../../../shared/commentStyle'
import { getScrollContainer } from '../lib/scrollUtils'
import { billUrl } from '../lib/sessionSlug'
import { todayIso } from '../lib/calendarGrid'
import { safeDate, safeTime } from '../lib/dates'
import { ExternalLinkIcon } from '../components/ExternalLinkIcon'
import { isEditableTarget } from '../lib/isEditableTarget'
import { BillPicker, type BillOption } from '../components/BillPicker'
import { editableFieldBox } from '../lib/editableFieldStyle'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { useMultiState } from '../context/ConfigContext'

function PartyBadge({ party }: { party: string }) {
  const bg = party === 'D' ? color.bgBlueChip : party === 'R' ? color.bgRedPriority : color.surfaceMuted
  const partyColor = party === 'D' ? color.linkBlue : party === 'R' ? color.textDanger : color.textSlate500
  // display:inline-block prevents text-decoration from the parent <a> punching through the chip background
  return <span style={{ marginLeft: 3, fontSize: fontSize.xs, padding: '1px 4px', borderRadius: radius.sm, background: bg, color: partyColor, fontWeight: fontWeight.bold, display: 'inline-block', textDecoration: 'none' }}>{party}</span>
}

function SponsorLink({ name, url, party, bold }: { name: string; url: string | null; party: string | null; bold?: boolean }) {
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="blue-link"
        style={{ whiteSpace: 'nowrap', fontWeight: bold ? 600 : undefined }}>
        {name}{party && <PartyBadge party={party} />}<ExternalLinkIcon />
      </a>
    )
  }
  return (
    <span style={{ whiteSpace: 'nowrap', fontWeight: bold ? 600 : undefined }}>
      {name}{party && <PartyBadge party={party} />}
    </span>
  )
}

// How many sponsor "chips" are clipped off the collapsed single line — i.e. those
// whose right edge falls past the row's right edge. Drives the "+N more" count.
// Pure and layout-agnostic (the caller supplies rects measured from the DOM) so it
// is unit-testable; sub-pixel overhang at the boundary is tolerated.
export function countClippedSponsors(itemRights: number[], boundaryRight: number): number {
  return itemRights.filter(right => right > boundaryRight + 0.5).length
}

// The bill-detail sponsors row. Collapsed, it clamps sponsors + co-sponsors to a
// single line and offers a "+N more" toggle *only when that line actually
// overflows* (measured, not gated on a co-sponsor count — so primary-heavy bills
// get one too). Expanded, the whole run wraps in place as one continuous inline
// flow: each name stays whole, and a label never dangles or splits at its hyphen.
function SponsorsRow({ sponsor, sponsorUrl, sponsorParty, coSponsors, flashed }: {
  sponsor: string | null
  sponsorUrl: string | null
  sponsorParty: string | null
  coSponsors: CoSponsor[]
  flashed: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const [hiddenCount, setHiddenCount] = useState(0)
  const flowRef = useRef<HTMLSpanElement>(null)

  const primaryCoSponsors = coSponsors.filter(s => s.primary)
  const regularCoSponsors = coSponsors.filter(s => !s.primary)
  const label = (primaryCoSponsors.length > 0 || regularCoSponsors.length > 0) ? 'Sponsors:' : 'Sponsor:'

  // While collapsed, keep the "+N more" count in sync with how many chips are
  // clipped, re-measuring as the column resizes. jsdom has neither layout nor a
  // ResizeObserver, so the guarded initial measure simply yields 0 there.
  useLayoutEffect(() => {
    if (showAll) return
    const flow = flowRef.current
    if (!flow) return
    const measure = () => {
      const boundary = flow.getBoundingClientRect().right
      const rights = Array.from(flow.querySelectorAll<HTMLElement>('[data-sponsor-item]'))
        .map(el => el.getBoundingClientRect().right)
      setHiddenCount(countClippedSponsors(rights, boundary))
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(flow)
    return () => ro?.disconnect()
  }, [showAll, sponsor, coSponsors])

  const labelStyle = { color: color.textMuted, whiteSpace: 'nowrap' as const }

  return (
    <div
      id="section-sponsors"
      style={{
        fontSize: fontSize.sm, color: color.textSecondary,
        display: showAll ? 'block' : 'flex', alignItems: 'baseline',
        minWidth: 0, marginBottom: 0,
        boxShadow: flashed ? '0 0 0 3px #fde68a' : 'none',
        transition: 'box-shadow 0.6s ease', borderRadius: radius.sm,
      }}
    >
      <span
        ref={flowRef}
        style={showAll
          ? { display: 'inline', whiteSpace: 'normal' }
          : { display: 'block', flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {/* Primary group. The inter-group gap rides on its right edge so the
            "Co-sponsors:" label sits flush left whenever it wraps to a new line. */}
        <span style={regularCoSponsors.length > 0 ? { marginRight: 16 } : undefined}>
          <span style={labelStyle}>{label}&nbsp;</span>
          {sponsor && (
            <span data-sponsor-item>
              <SponsorLink name={sponsor} url={sponsorUrl} party={sponsorParty} />
            </span>
          )}
          {primaryCoSponsors.map((s, i) => (
            <span key={`p-${i}`}>, <span data-sponsor-item><SponsorLink name={s.name} url={s.url} party={s.party ?? null} /></span></span>
          ))}
        </span>
        {regularCoSponsors.length > 0 && (
          <>
            {' '}
            <span style={labelStyle}>Co-sponsors:&nbsp;</span>
            {regularCoSponsors.map((s, i) => (
              <span key={`r-${i}`}>{i > 0 ? ', ' : ''}<span data-sponsor-item><SponsorLink name={s.name} url={s.url} party={s.party ?? null} /></span></span>
            ))}
          </>
        )}
      </span>
      {(showAll || hiddenCount > 0) && (
        <button
          onClick={() => setShowAll(v => !v)}
          style={{ marginLeft: 6, fontSize: fontSize.sm, color: color.linkBlue, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {showAll ? 'show less' : `+${hiddenCount} more`}
        </button>
      )}
    </div>
  )
}

// Effective date for a document/amendment row: the central-resolved date
// (real or recovered) falls back to the structured date, then nothing.
function effectiveItemDate(item: { date: string | null; dateResolved?: string | null }): string | null {
  return item.dateResolved ?? safeDate(item.date)
}

// Renders the date cell, marking a recovered (inferred) date with a tooltip.
function ItemDateText({ item }: { item: { date: string | null; dateResolved?: string | null; dateInferred?: boolean } }) {
  const d = effectiveItemDate(item)
  if (!d) return <>—</>
  if (item.dateInferred) {
    return (
      <HoverTooltip text="Date parsed from title">
        <span style={{ borderBottom: `1px dotted ${color.textMuted}`, cursor: 'default' }}>{d}</span>
      </HoverTooltip>
    )
  }
  return <>{d}</>
}

type Comment = {
  id: string
  userId: string
  userName: string
  userSubtitle: string | null
  content: string
  createdAt: string
  reactions: { emoji: string; count: number; userReacted: boolean; reactors: { name: string; subtitle: string | null }[] }[]
}

type CoSponsor = { name: string; party: string | null; role?: string; district?: string; url: string | null; primary?: boolean }
type VoteSummaryEntry = { date: string; chamber: string; desc: string; yea: number; nay: number; nv: number; absent: number; passed: number }
type RelatedBill = { billId: number; billNumber: string; type: string; route: { id: string; billNumber: string; sessionSlug: string; state: string } | null }

type BillDetailData = {
  id: string
  externalId: string | null
  billNumber: string
  sessionSlug?: string | null
  title: string
  state: string
  status: string
  statusDate?: string | null
  session: string
  sessionId?: string | null
  yearStart?: number | null
  yearEnd?: number | null
  description?: string
  billType?: string | null
  body?: string | null
  currentBody?: string | null
  abstract?: string | null
  stateLink: string | null
  stateUrl?: string | null
  url?: string | null
  legiscanUrl?: string | null
  committee: string | null
  referrals?: { date: string; committee_id: number; chamber: string; name: string }[]
  tenantSummary: string | null
  tags: string[]
  relevanceScore: number | null
  priority: 'high' | 'medium' | 'low' | null
  textR2Key: string | null
  sponsor: string | null
  sponsorParty: string | null
  sponsorUrl: string | null
  coSponsors: CoSponsor[]
  lastAction: string | null
  lastActionDate: string | null
  history: { date: string; action: string; chamber: string; importance?: number }[]
  voteSummary?: VoteSummaryEntry[]
  subjects?: string[]
  relatedBillIds: RelatedBill[]
  companionBillIds: string[]
  texts: {
    docId: string
    type: string
    date: string
    mime: string
    stateLink: string | null
    altStateLink: string | null
  }[]
  calendar: {
    eventHash: string
    typeId: number
    type: string
    date: string
    time: string | null
    location: string | null
    description: string | null
  }[]
  supplements: {
    supplementId: number
    typeId: number
    type: string
    date: string | null
    dateResolved: string | null
    dateInferred: boolean
    title: string | null
    description: string | null
    mime: string | null
    url: string | null
    stateLink: string | null
  }[]
  amendments: {
    amendmentId: number
    adopted: boolean
    chamber: string | null
    date: string | null
    dateResolved: string | null
    dateInferred: boolean
    title: string | null
    description: string | null
    mime: string | null
    url: string | null
    stateLink: string | null
  }[]
  customFieldValues: Record<string, { value: string; setBy: string | null; updatedAt: string }>
  matchType: 'keyword' | 'manual' | null
  newMatchAt?: string | null
  triagedAt?: string | null
  isDraft?: boolean
  draftText?: string | null
  createdAt: string
  updatedAt: string
  centralSyncedAt: string | null
  aiProcessedAt: string | null
  aiSkipReason: 'pdf_too_large' | null
  lastAiTextDocId: string | null
  textStatus: 'not_checked' | 'no_texts' | 'available' | 'in_r2' | null
  myVote: 'support' | 'oppose' | 'neutral' | null
  myNote: string | null
  priorityMeta: { setByName: string; updatedAt: string } | null
  position: { position: string; setByName: string; updatedAt: string } | null
  voteCounts: { support: number; oppose: number; neutral: number; total: number }
  memberVotes?: { userName: string; userEmail: string; position: string; votedAt: string; roles: { id: string; name: string }[] }[]
  comments: Comment[]
  commentsTotal: number
}

/**
 * Route loader: fetch the bill before the page renders (RR7 data router). Replaces
 * the old prefetch-via-router-state + fetch-on-mount path. Normalizes legacy /
 * /bills/:id URLs to the canonical /STATE/SESSION/BILL form and surfaces the 409
 * ambiguous-legacy-bill case to BillDetailError.
 */
export async function billDetailLoader({ params, request }: LoaderFunctionArgs) {
  const { billId, state, sessionSlug, billNumber } = params
  const apiPath = billId
    ? `/bills/${billId}`
    : state
      ? `/bills/resolve/${state.toUpperCase()}/${sessionSlug}/${billNumber}`
      : `/bills/resolve/${sessionSlug}/${billNumber}`
  let bill: BillDetailData
  try {
    bill = await apiFetch<BillDetailData>(apiPath)
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      throw new Response('This bill number exists in multiple states. Please use a state-prefixed URL (e.g. /RI/2026/HB0209).', { status: 409 })
    }
    if (err instanceof ApiError && err.status === 401) {
      throw redirect('/login')
    }
    throw new Response('Failed to load bill.', { status: 500 })
  }
  // Normalize /bills/:id and legacy /:session/:billNumber to the canonical
  // /STATE/SESSION/BILL URL. The (billId || !state) guard means we never redirect
  // when already on the canonical route — so there is no redirect loop despite the
  // unencoded space in billUrl's output vs. the encoded request pathname.
  const canonical = billUrl({ state: bill.state, session: bill.session, billNumber: bill.billNumber, id: bill.id })
  if ((billId || !state) && canonical !== new URL(request.url).pathname) {
    return redirect(canonical)
  }
  return bill
}

export function BillDetail() {
  const { billId, state: stateParam, sessionSlug: slugParam, billNumber: billNumberParam } = useParams<{ billId?: string; state?: string; sessionSlug?: string; billNumber?: string }>()
  const navigate = useNavigate()
  const navigation = useNavigation()
  const location = useLocation()
  const { user } = useAuth()
  const { demoLocked, demoMode } = useDemo()
  // billPaths/currentIndex are only present when arriving from the Bills list or
  // prev/next; deferred-nav entry points (Feed, sidebar, calendar, notifications)
  // pass prefetchedBill alone. Guard billPaths so a prefetched-only state can't
  // dereference `.length` on undefined.
  const navState = location.state as { billPaths?: string[]; currentIndex?: number; prefetchedBill?: BillDetailData } | null
  const prevPath = navState?.billPaths && navState.currentIndex != null && navState.currentIndex > 0 ? navState.billPaths[navState.currentIndex - 1] : null
  const nextPath = navState?.billPaths && navState.currentIndex != null && navState.currentIndex < navState.billPaths.length - 1 ? navState.billPaths[navState.currentIndex + 1] : null
  // The bill is loaded by billDetailLoader before this renders (RR7 data router),
  // so the first frame is already complete — no null-bill flash, no spinner. Named
  // `prefetchedBill` for continuity with the seeding/effect logic below, which was
  // already built around an always-present bill. (The bill arrives via the loader;
  // the old custom-nav prefetch that used to seed it through router state is gone.)
  const prefetchedBill = useLoaderData() as BillDetailData
  // Build the API path based on which route we're on
  const apiPath = billId
    ? `/bills/${billId}`
    : stateParam
      ? `/bills/resolve/${stateParam.toUpperCase()}/${slugParam}/${billNumberParam}`
      : `/bills/resolve/${slugParam}/${billNumberParam}`
  // Stable key for effects — changes when the target bill changes
  const billKey = billId ?? `${stateParam ?? ''}/${slugParam}/${billNumberParam}`
  // Seed all bill-derived state from the prefetched bill so the FIRST render is
  // already complete — no null-bill frame (which flashed "Bill not found.") and
  // no spinner. Mirrors applyBillData; the effect re-applies it as the source of truth.
  const [bill, setBill] = useState<BillDetailData | null>(prefetchedBill)
  const [triageDismissed, setTriageDismissed] = useState(false)
  const [loading, setLoading] = useState(() => prefetchedBill ? false : true)
  const [error, setError] = useState<string | null>(null)
  usePageTitle(bill ? `${bill.state} ${bill.billNumber} — ${bill.title ?? bill.abstract}` : null)
  const [myVote, setMyVote] = useState<'support' | 'oppose' | 'neutral' | null>(prefetchedBill?.myVote ?? null)
  const [priority, setPriority] = useState<'high' | 'medium' | 'low' | null>(prefetchedBill?.priority ?? null)
  const [position, setPosition] = useState<string | null>(prefetchedBill?.position?.position ?? null)
  const [priorityMeta, setPriorityMeta] = useState<{ setByName: string; updatedAt: string } | null>(prefetchedBill?.priorityMeta ?? null)
  const [positionMeta, setPositionMeta] = useState<{ setByName: string; updatedAt: string } | null>(prefetchedBill?.position ? { setByName: prefetchedBill.position.setByName, updatedAt: prefetchedBill.position.updatedAt } : null)
  const [voteCounts, setVoteCounts] = useState(prefetchedBill?.voteCounts ?? { support: 0, oppose: 0, neutral: 0, total: 0 })
  const [comments, setComments] = useState<Comment[]>(prefetchedBill?.comments ?? [])
  const [openPickerFor, setOpenPickerFor] = useState<string | null>(null)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [config, setConfig] = useState<{ positionVocabulary: string[]; instanceDomains: Record<string, string>; orgNoun: string } | null>(null)
  const multiState = useMultiState()
  const [promoting, setPromoting] = useState(false)
  const [promoteError, setPromoteError] = useState<string | null>(null)
  const [pendingPromote, setPendingPromote] = useState(false)
  const [promoteTimeoutMsg, setPromoteTimeoutMsg] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [regenerateError, setRegenerateError] = useState<string | null>(null)
  const [showAmendments, setShowAmendments] = useState(false)
  const [showDocuments, setShowDocuments] = useState(false)
  const [showActions, setShowActions] = useState(false)

  const [hoveredTag, setHoveredTag] = useState<string | null>(null)
  const [showBillText, setShowBillText] = useState(false)
  const [requestedDocId, setRequestedDocId] = useState<string | null>(null)
  const [showHearings, setShowHearings] = useState(false)
  const [changeLog, setChangeLog] = useState<ChangeRecord[]>([])
  // Prev/next bill nav is "pending" while the data router runs the next bill's
  // loader — disable the arrows until it settles (was a local flag the old
  // deferredNavigate toggled).
  const billNavPending = navigation.state !== 'idle'
  const [newCommentIds, setNewCommentIds] = useState<Set<string>>(new Set())
  const [hoveredCommentUser, setHoveredCommentUser] = useState<string | null>(null)
  const [flashedCommentId, setFlashedCommentId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handledCommentHashRef = useRef<string | null>(null)
  const [flashedSectionId, setFlashedSectionId] = useState<string | null>(null)
  const flashSectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handledSectionHashRef = useRef<string | null>(null)
  const [rolesData, setRolesData] = useState<Array<{ id: string; name: string; members: Array<{ id: string; name: string; subtitle: string | null }> }>>([])
  const [usersData, setUsersData] = useState<Array<{ id: string; name: string; email: string; subtitle: string | null; roles: { id: string; name: string }[] }>>([])
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDef[]>([])
  const [editingPinnedFieldId, setEditingPinnedFieldId] = useState<string | null>(null)
  const [hoveredPinnedFieldId, setHoveredPinnedFieldId] = useState<string | null>(null)
  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const [deletingDraft, setDeletingDraft] = useState(false)
  const [filedOptions, setFiledOptions] = useState<BillOption[]>([])
  const [editingDraftField, setEditingDraftField] = useState<'summary' | 'text' | 'title' | 'sponsor' | null>(null)
  const [hoveredDraftField, setHoveredDraftField] = useState<'summary' | 'text' | 'title' | 'sponsor' | null>(null)

  const refreshSidebar = useSidebarRefresh()
  const { refresh: refreshNotifications, mentions } = useNotifications()
  const billRef = useRef<BillDetailData | null>(null)

  const applyBillData = useCallback((data: BillDetailData) => {
    setBill(data)
    setMyVote(data.myVote)
    setPriority(data.priority)
    setPriorityMeta(data.priorityMeta ?? null)
    setPosition(data.position?.position ?? null)
    setPositionMeta(data.position ? { setByName: data.position.setByName, updatedAt: data.position.updatedAt } : null)
    setVoteCounts(data.voteCounts)
    setComments(data.comments)
  }, [])

  useEffect(() => {
    billRef.current = bill
  }, [bill])

  useEffect(() => {
    if (location.hash) return // hash handlers manage their own scroll
    getScrollContainer().scrollTo(0, 0)
  }, [billKey, location.hash])

  // Clean up flash timer on unmount
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current) }, [])
  useEffect(() => () => { if (flashSectionTimerRef.current) clearTimeout(flashSectionTimerRef.current) }, [])

  // Scroll to and flash a comment when the URL hash is #comment-{id}
  useEffect(() => {
    if (!location.hash.startsWith('#comment-')) return
    if (handledCommentHashRef.current === location.hash) return
    const commentId = location.hash.slice('#comment-'.length)
    const el = document.getElementById(`comment-${commentId}`)
    if (!el) return // comments not yet rendered — will retry when comments.length changes
    handledCommentHashRef.current = location.hash
    const rafId = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect()
      const container = getScrollContainer()
      const isInView = rect.top >= 64 && rect.bottom <= window.innerHeight
      if (!isInView) container.scrollTo({ top: container.scrollTop + rect.top - 80, behavior: 'smooth' })
      setFlashedCommentId(commentId)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => { setFlashedCommentId(null); flashTimerRef.current = null }, 1500)
    })
    return () => cancelAnimationFrame(rafId)
  }, [location.hash, comments.length])

  // Scroll to and flash a section when the URL hash is #section-{name} or open text panel for #text-{docId}
  useEffect(() => {
    const hash = location.hash
    if (!hash.startsWith('#section-') && !hash.startsWith('#text-')) return
    if (handledSectionHashRef.current === hash) return

    if (hash.startsWith('#text-')) {
      const docId = hash.slice('#text-'.length)
      if (docId) {
        setRequestedDocId(docId)
        setShowBillText(true)
        handledSectionHashRef.current = hash
      }
      return
    }

    // #section-{name} — expand the collapsible if needed, then scroll + flash
    const sectionId = hash.slice(1) // e.g. 'section-actions'
    if (sectionId === 'section-actions') setShowActions(true)
    if (sectionId === 'section-amendments') setShowAmendments(true)
    if (sectionId === 'section-documents') setShowDocuments(true)
    if (sectionId === 'section-hearings') setShowHearings(true)

    // setTimeout gives React one extra tick to flush collapsible expansion before measuring
    const timerId = setTimeout(() => {
      const el = document.getElementById(sectionId)
      if (!el) return
      handledSectionHashRef.current = hash
      const rect = el.getBoundingClientRect()
      const container = getScrollContainer()
      const isInView = rect.top >= 64 && rect.bottom <= window.innerHeight
      if (!isInView) container.scrollTo({ top: container.scrollTop + rect.top - 80, behavior: 'smooth' })
      setFlashedSectionId(sectionId)
      if (flashSectionTimerRef.current) clearTimeout(flashSectionTimerRef.current)
      flashSectionTimerRef.current = setTimeout(() => {
        setFlashedSectionId(null)
        flashSectionTimerRef.current = null
      }, 1500)
    }, 0)
    return () => clearTimeout(timerId)
  }, [location.hash, bill?.id])

  // Value-stable key: refresh() hands back a new array every time (a fresh parse
  // of the response, NotificationsContext.tsx), so depending on `mentions` itself
  // would make the effect below retrigger its own refresh in a loop — POST →
  // refresh() → new array identity → effect fires again → POST → ... forever,
  // for as long as the page stays open. Joining the ids means the effect only
  // reruns when this bill's mention set actually changes.
  const billMentionIds = useMemo(
    () => mentions.filter(m => m.billId === bill?.id).map(m => m.id).sort().join(','),
    [mentions, bill?.id],
  )

  // Mark all mention notifications for this bill as read when the page loads.
  // On a demo this is browser-local — the shared demo-user row and the reset cron
  // make the server's read_at useless there. See lib/demoReadState.ts.
  useEffect(() => {
    if (!bill?.id) return
    if (demoMode) {
      markMentionsRead(mentions.filter(m => m.billId === bill.id).map(m => m.id))
      void refreshNotifications()
      return
    }
    apiFetch(`/notifications/mark-read-by-bill/${bill.id}`, { method: 'POST' })
      .then(() => refreshNotifications())
      .catch(() => {})
  }, [bill?.id, refreshNotifications, demoMode, billMentionIds])

  useEffect(() => {
    apiFetch<CustomFieldDef[]>('/config/custom-fields')
      .then(setCustomFieldDefs)
      .catch(() => {})
  }, [])

  const navigateToBill = useCallback((path: string, state: { billPaths: string[]; currentIndex: number }) => {
    // Unsaved-text confirmation is handled globally by UnsavedNavGuard (useBlocker
    // in AppLayout), which intercepts this programmatic navigate() too — so no
    // local hasUnsaved() check here (it would double-prompt). The bill route's
    // loader fetches the destination bill; the router holds this page until it
    // resolves. `state` carries prev/next list context, not prefetched data.
    navigate(path, { state })
  }, [navigate])

  const fetchBillData = useCallback(async () => {
    const data = await apiFetch<BillDetailData>(apiPath)
    setVoteCounts(data.voteCounts)
    setMyVote(data.myVote)
    setComments(prev => {
      const apiIds = new Set(data.comments.map(c => c.id))
      const localOnly = prev.filter(c => !apiIds.has(c.id))
      return [...data.comments, ...localOnly]
    })
    setPriority(data.priority)
    setPosition(data.position?.position ?? null)
    setPositionMeta(data.position ? { setByName: data.position.setByName, updatedAt: data.position.updatedAt } : null)
    if (data.memberVotes !== undefined) setBill(b => b ? { ...b, memberVotes: data.memberVotes } : b)
  }, [apiPath])

  const refetchBill = useCallback(async () => {
    try {
      const startExternalId = billRef.current?.externalId
      const data = await apiFetch<BillDetailData>(apiPath)
      // Guard: if the user navigated to a different bill while we were fetching,
      // discard this response.
      if (data.externalId !== startExternalId) return
      applyBillData(data)
    } catch {
      // ignore — polling will retry
    }
  }, [apiPath, applyBillData])

  usePolling(fetchBillData, 15_000)

  useEffect(() => {
    setError(null)
    // billDetailLoader has already fetched the bill and handled the canonical-URL
    // redirect + 409 case, so just seed bill-derived state from it. Config is still
    // fetched here (it isn't part of the bill loader). Re-runs on bill change
    // (billKey), at which point useLoaderData has the new bill.
    setLoading(false)
    applyBillData(prefetchedBill)
    const today = todayIso()
    if ((prefetchedBill.calendar ?? []).some(e => e.date >= today)) setShowHearings(true)
    apiFetch<{ associationName: string; positionVocabulary: string[]; instanceDomains: Record<string, string>; orgNoun: string }>('/config')
      .then(cfg => setConfig({ positionVocabulary: cfg.positionVocabulary, instanceDomains: cfg.instanceDomains ?? {}, orgNoun: cfg.orgNoun }))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billKey])

  useEffect(() => {
    apiFetch<Array<{ id: string; name: string; members: Array<{ id: string; name: string; subtitle: string | null }> }>>('/roles')
      .then(setRolesData)
      .catch(() => {})
    apiFetch<Array<{ id: string; name: string; email: string; subtitle: string | null; roles: { id: string; name: string }[] }>>('/users')
      .then(setUsersData)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!bill?.id) return
    let cancelled = false
    setChangeLog([])
    apiFetch<{ changes: ChangeRecord[] }>(`/bills/${bill.id}/changes`)
      .then(data => { if (!cancelled) setChangeLog(data.changes ?? []) })
      .catch(() => { if (!cancelled) setChangeLog([]) })
    return () => { cancelled = true }
  }, [bill?.id])

  // Load filed bills for the link-to-filed picker (drafts only, admin only)
  const isAdminUser = user?.role === 'admin' || user?.role === 'owner'
  useEffect(() => {
    if (!bill?.isDraft || !isAdminUser) return
    let cancelled = false
    apiFetch<Array<BillOption & { isDraft?: boolean }>>('/calendar/bill-options')
      .then(data => {
        if (cancelled) return
        setFiledOptions(
          data
            .filter(o => !o.isDraft && o.id !== bill.id)
            .map(({ id, billNumber, title, state }) => ({ id, billNumber, title, state }))
        )
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [bill?.id, bill?.isDraft, isAdminUser])

  // Keyboard arrow navigation between bills
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return
      if (e.key === 'ArrowLeft' && prevPath) {
        navigateToBill(prevPath, { billPaths: navState!.billPaths!, currentIndex: navState!.currentIndex! - 1 })
      } else if (e.key === 'ArrowRight' && nextPath) {
        navigateToBill(nextPath, { billPaths: navState!.billPaths!, currentIndex: navState!.currentIndex! + 1 })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [prevPath, nextPath, navState, navigateToBill])

  // Reflect votes from other pages immediately
  useEffect(() => {
    function handleVoteChanged(e: Event) {
      const { billId: votedId, newVote, prevVote } = (e as CustomEvent).detail
      if (votedId !== billRef.current?.id) return
      setMyVote(newVote ?? null)
      setVoteCounts(prev => {
        const vc = { ...prev }
        if (prevVote) vc[prevVote as keyof typeof vc] = Math.max(0, vc[prevVote as keyof typeof vc] - 1)
        if (newVote) vc[newVote as keyof typeof vc] = vc[newVote as keyof typeof vc] + 1
        vc.total = vc.support + vc.oppose + vc.neutral
        return vc
      })
    }
    window.addEventListener('bill-vote-changed', handleVoteChanged)
    return () => window.removeEventListener('bill-vote-changed', handleVoteChanged)
  }, [billId])

  async function handleVote(pos: 'support' | 'oppose' | 'neutral') {
    if (!bill) return
    const prevVote = myVote
    const prevCounts = voteCounts
    const isToggle = prevVote === pos
    // Apply the optimistic update up front, then revert to this snapshot if the
    // request fails — so a failed vote never leaves the count and selection
    // desynced (matches the Sidebar vote handler).
    if (isToggle) {
      setVoteCounts((prev) => ({ ...prev, [pos]: prev[pos] - 1, total: prev.total - 1 }))
      setMyVote(null)
    } else {
      setVoteCounts((prev) => {
        const next = { ...prev, [pos]: prev[pos] + 1 }
        if (prevVote) next[prevVote] -= 1
        else next.total = prev.total + 1
        return next
      })
      setMyVote(pos)
    }
    try {
      await apiFetch(`/bills/${bill.id}/votes`, {
        method: isToggle ? 'DELETE' : 'POST',
        ...(isToggle ? {} : { body: JSON.stringify({ position: pos }) }),
      })
    } catch {
      setVoteCounts(prevCounts)
      setMyVote(prevVote)
      return
    }
    refreshSidebar()
  }

  async function handlePostComment(content: string) {
    if (!bill || !content.trim()) return
    const result = await apiFetch<{ id: string; content: string; createdAt: string }>(`/bills/${bill.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
    setComments((prev) => [...prev, {
      id: result.id,
      userId: user!.id,
      userName: displayName(user!),
      userSubtitle: user!.subtitle,
      content: result.content,
      createdAt: result.createdAt,
      reactions: [],
    }])
    setNewCommentIds((prev) => new Set([...prev, result.id]))
  }

  // Toggle: clicking an emoji pill DELETEs the reaction if userReacted, otherwise POSTs it
  async function handleReaction(commentId: string, emoji: string) {
    const comment = comments.find((c) => c.id === commentId)
    if (!comment) return
    const existing = comment.reactions.find((r) => r.emoji === emoji)
    // The optimistic update must keep `reactors` (the hover name list) in step with
    // `count`/`userReacted`, or the current user's name would be missing (on add) or
    // linger (on remove) in the tooltip until the next poll. Match the server shape.
    const me = { name: displayName(user!) || 'You', subtitle: user?.subtitle ?? null }
    if (existing?.userReacted) {
      try {
        await apiFetch(`/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' })
        setComments((prev) => prev.map((c) =>
          c.id === commentId
            ? { ...c, reactions: c.reactions.map((r) => r.emoji === emoji ? { ...r, count: r.count - 1, userReacted: false, reactors: r.reactors.filter((x) => !(x.name === me.name && x.subtitle === me.subtitle)) } : r).filter((r) => r.count > 0) }
            : c,
        ))
      } catch (err) {
        console.error('Failed to delete reaction:', err)
      }
    } else {
      try {
        await apiFetch(`/comments/${commentId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) })
        setComments((prev) => prev.map((c) =>
          c.id === commentId
            ? {
              ...c,
              reactions: existing
                ? c.reactions.map((r) => r.emoji === emoji ? { ...r, count: r.count + 1, userReacted: true, reactors: [...r.reactors, me] } : r)
                : [...c.reactions, { emoji, count: 1, userReacted: true, reactors: [me] }],
            }
            : c,
        ))
      } catch (err) {
        console.error('Failed to add reaction:', err)
      }
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (!confirm('Remove this comment? It will no longer be visible, but may be retained for administrative data exports.')) return
    await apiFetch(`/comments/${commentId}`, { method: 'DELETE' })
    setComments((prev) => prev.filter((c) => c.id !== commentId))
  }

  async function handleSaveEdit(commentId: string, content: string) {
    if (!content.trim()) return
    const newContent = content
    await apiFetch(`/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: newContent }),
    })
    setComments((prev) => prev.map((c) => c.id === commentId ? { ...c, content: newContent } : c))
    setEditingCommentId(null)
  }

  function startAnalyzingPoll() {
    if (!bill) return
    setPendingPromote(true)
    setPromoteTimeoutMsg(null)
    const startedAt = Date.now()
    const POLL_MS = 5000
    const TIMEOUT_MS = 3 * 60 * 1000
    const poll = async () => {
      try {
        const r = await fetch(`/api/bills/${bill.id}`, { credentials: 'include' })
        if (r.ok) {
          const fresh = await r.json()
          if (fresh.aiProcessedAt) { setPendingPromote(false); refetchBill(); return }
          if (fresh.textStatus === 'no_texts') { setPendingPromote(false); refetchBill(); return }
          if (fresh.aiSkipReason) { setPendingPromote(false); refetchBill(); return }
        }
      } catch { /* swallow polling errors; retry */ }
      if (Date.now() - startedAt > TIMEOUT_MS) {
        setPendingPromote(false)
        setPromoteTimeoutMsg('AI did not complete within 3 minutes. Try refreshing the page in a few minutes.')
        return
      }
      setTimeout(poll, POLL_MS)
    }
    setTimeout(poll, POLL_MS)  // first check after 5s
  }

  async function handlePromote() {
    if (!bill) return
    setPromoting(true)
    setPromoteError(null)
    setPromoteTimeoutMsg(null)
    try {
      const res = await fetch(`/api/admin/promote-bill/${bill.id}`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(data.error ?? `Promote failed (${res.status})`)
      }
      startAnalyzingPoll()
    } catch (e) {
      setPromoteError(e instanceof Error ? e.message : String(e))
    } finally {
      setPromoting(false)
    }
  }

  async function handleLinkDraft() {
    if (!bill || !linkTarget || demoLocked) return
    if (!window.confirm('Link this draft to the filed bill? The draft will be retired and all votes, positions, comments, and notes will be moved to the filed bill. This cannot be undone.')) return
    setLinking(true)
    try {
      const result = await apiFetch<{ ok: boolean; filedBillId: string }>(`/bills/${bill.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ filedBillId: linkTarget }),
      })
      navigate('/bills/' + result.filedBillId)
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to link bill.')
    } finally {
      setLinking(false)
    }
  }

  async function handleRegenerate() {
    if (regenerating || demoLocked || !bill) return
    setRegenerateError(null)
    const prevProcessedAt = bill.aiProcessedAt
    setRegenerating(true)
    try {
      const res = await fetch(`/api/admin/reprocess-bill/${encodeURIComponent(bill.externalId ?? bill.id)}`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(data.error ?? `Regenerate failed (${res.status})`)
      }
      const startedAt = Date.now()
      const POLL_MS = 5000
      const TIMEOUT_MS = 3 * 60 * 1000
      const poll = async () => {
        try {
          const r = await fetch(`/api/bills/${bill.id}`, { credentials: 'include' })
          if (r.ok) {
            const fresh = await r.json()
            if (fresh.aiProcessedAt && fresh.aiProcessedAt !== prevProcessedAt) {
              setRegenerating(false)
              refetchBill()
              return
            }
            if (fresh.aiSkipReason) {
              setRegenerating(false)
              refetchBill()
              return
            }
          }
        } catch { /* swallow polling errors; retry */ }
        if (Date.now() - startedAt > TIMEOUT_MS) {
          setRegenerating(false)
          setRegenerateError('AI did not finish within 3 minutes. Try refreshing in a few minutes.')
          return
        }
        setTimeout(poll, POLL_MS)
      }
      setTimeout(poll, POLL_MS)
    } catch (e) {
      setRegenerating(false)
      setRegenerateError(e instanceof Error ? e.message : String(e))
    }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '50vh' }}>
      <span style={{ display: 'inline-block', width: 20, height: 20, border: `2.5px solid ${color.borderStrong}`, borderTopColor: color.accentBlue, borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
    </div>
  )
  if (error || !bill) return <div style={{ padding: 32, color: color.textErrorRed }}>{error ?? 'Bill not found.'}</div>

  const isAdmin = user?.role === 'admin' || user?.role === 'owner'

  // Separators between collapsible sections — no border above the first one
  const hasBillText = bill.texts.length > 0 && !!bill.textR2Key
  const hasAmendments = (bill.amendments ?? []).filter(a => a.url || a.stateLink).length > 0
  const hasActions = !!bill.lastAction
  const hasHearings = (bill.calendar ?? []).length > 0
  return (
    <div className="bill-detail-outer" style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <style>{`
        @keyframes slideInComment {
          from { opacity: 0; transform: translateY(18px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .comment-new { animation: slideInComment 0.38s cubic-bezier(0.16, 1, 0.3, 1) both; }
      `}</style>


      {/* Static info block */}
      <div style={{ ...CARD, padding: '20px 24px' }}>

        {/* Chip strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <BillBadge
            billNumber={bill.billNumber}
            state={bill.state}
            stateUrl={(() => {
              if (!config || !multiState) return undefined
              const isHub = window.location.hostname === 'staging.example.com' || window.location.hostname === 'staging.example.org' || window.location.hostname === 'localhost'
              const instanceDomain = config.instanceDomains[bill.state]
              if (!isHub || !instanceDomain) return undefined
              return `https://${instanceDomain}${window.location.pathname}`
            })()}
          />
          <StatusChip status={decodeStatus(bill.status)} onClick={() => navigate(`/bills?status=${encodeURIComponent(bill.status)}`)} />
          {bill.session && (
            <SessionChip
              session={bill.session}
              onClick={() => {
                if (bill.yearStart) {
                  navigate(`/bills?year=${bill.yearStart}${bill.state ? `&state=${bill.state}` : ''}`)
                } else {
                  navigate(`/bills?session=${encodeURIComponent(bill.session)}`)
                }
              }}
            />
          )}
          <ChangeHistoryTooltip
            changes={changeLog}
            lastActionDate={bill.lastActionDate}
            relativeTime={relativeTime}
          />
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {isAdmin
              ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  {bill.matchType === 'keyword' && !!bill.newMatchAt && !priority && !bill.triagedAt && !triageDismissed
                    ? (
                      <HoverTooltip text="New keyword match — set a priority or dismiss">
                        <NewMatchTriageControl
                          billId={bill.id}
                          current={priority}
                          onChange={(p, result) => {
                            setPriority(p)
                            setPriorityMeta(p ? { setByName: user!.name, updatedAt: new Date().toISOString() } : null)
                            refreshSidebar()
                            if (result?.promoted) startAnalyzingPoll()
                          }}
                          onDismiss={() => { setTriageDismissed(true); refreshSidebar() }}
                        />
                      </HoverTooltip>
                    )
                    : (
                  <HoverTooltip text="This bill's priority level">
                    <CompactPrioritySelect billId={bill.id} current={priority} onChange={(p, result) => {
                      setPriority(p)
                      setPriorityMeta(p ? { setByName: user!.name, updatedAt: new Date().toISOString() } : null)
                      refreshSidebar()
                      if (result?.promoted) startAnalyzingPoll()
                    }} placeholder="Priority not set" />
                  </HoverTooltip>
                    )}
                  {priorityMeta && (
                    <div title={absoluteTime(priorityMeta.updatedAt)} style={{ ...CHROME_TEXT, marginTop: 3, cursor: 'default' }}>
                      Set by {priorityMeta.setByName} · {relativeTime(priorityMeta.updatedAt)}
                    </div>
                  )}
                </div>
              )
              : priority
                ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <HoverTooltip text="This bill's priority level">
                      <PriorityBadge priority={priority} onClick={() => navigate(`/bills?priority=${priority}`)} />
                    </HoverTooltip>
                    {priorityMeta && (
                      <div title={absoluteTime(priorityMeta.updatedAt)} style={{ ...CHROME_TEXT, marginTop: 3, cursor: 'default' }}>
                        Set by {priorityMeta.setByName} · {relativeTime(priorityMeta.updatedAt)}
                      </div>
                    )}
                  </div>
                )
                : null
            }
            {(prevPath || nextPath) && (
              <>
                <button
                  onClick={() => prevPath && navigateToBill(prevPath, { billPaths: navState!.billPaths!, currentIndex: navState!.currentIndex! - 1 })}
                  disabled={!prevPath || billNavPending}
                  style={{ fontSize: fontSize.sm, color: prevPath ? color.linkBlue : color.borderStrong, background: 'none', border: 'none', cursor: prevPath && !billNavPending ? 'pointer' : 'default', padding: '2px 4px' }}
                  title="Previous bill (←)"
                >←</button>
                <button
                  onClick={() => nextPath && navigateToBill(nextPath, { billPaths: navState!.billPaths!, currentIndex: navState!.currentIndex! + 1 })}
                  disabled={!nextPath || billNavPending}
                  style={{ fontSize: fontSize.sm, color: nextPath ? color.linkBlue : color.borderStrong, background: 'none', border: 'none', cursor: nextPath && !billNavPending ? 'pointer' : 'default', padding: '2px 4px' }}
                  title="Next bill (→)"
                >→</button>
              </>
            )}
          </span>
        </div>

        {bill.isDraft && (
          <div style={{ background: color.bgAmberPriority, border: `1px solid ${color.borderAmber}`, borderRadius: radius.md, padding: '10px 14px', marginBottom: 10, fontSize: fontSize.sm, color: color.textAmberWarning }}>
            <p style={{ margin: '0 0 10px', fontWeight: fontWeight.medium, lineHeight: 1.5 }}>
              An admin added this draft pre-filed bill. When the associated bill is filed, link it here to transfer all votes, positions, comments, and notes to the filed bill:
            </p>
            {isAdmin ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Picker + link button on one row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <BillPicker
                      options={filedOptions}
                      value={linkTarget ? [linkTarget] : []}
                      onChange={ids => setLinkTarget(ids[0] ?? null)}
                      multiState={filedOptions.some(o => o.state !== filedOptions[0]?.state)}
                      single
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleLinkDraft}
                    disabled={!linkTarget || linking || demoLocked}
                    style={{
                      background: (!linkTarget || linking || demoLocked) ? color.accentBlueMuted : color.accentBlue,
                      color: color.white, border: 'none', borderRadius: radius.md,
                      padding: '8px 14px', cursor: (!linkTarget || linking || demoLocked) ? 'not-allowed' : 'pointer',
                      fontSize: fontSize.sm, fontWeight: fontWeight.medium, lineHeight: 1.4, whiteSpace: 'nowrap',
                      opacity: demoLocked ? 0.5 : 1,
                    }}
                  >
                    {linking ? 'Linking…' : 'Link & merge into filed bill'}
                  </button>
                </div>
                {/* Delete draft — right-aligned; red button matching the Re-generate button */}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={async () => {
                      if (deletingDraft || demoLocked) return
                      if (!window.confirm('Delete this draft bill? This permanently removes it and its votes, positions, comments, and notes.')) return
                      setDeletingDraft(true)
                      try {
                        await apiFetch(`/bills/${bill.id}`, { method: 'DELETE' })
                        navigate('/bills')
                      } catch {
                        setDeletingDraft(false)
                      }
                    }}
                    disabled={deletingDraft || demoLocked}
                    style={{
                      flexShrink: 0,
                      background: (deletingDraft || demoLocked) ? color.bgRedDisabled : color.textErrorRed,
                      color: color.white, border: 'none', borderRadius: radius.md,
                      padding: '6px 12px', cursor: (deletingDraft || demoLocked) ? 'not-allowed' : 'pointer',
                      fontSize: fontSize.sm, fontWeight: fontWeight.medium, lineHeight: 1.4, whiteSpace: 'nowrap',
                    }}
                  >
                    {deletingDraft ? 'Deleting…' : 'Delete this draft bill'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {bill.isDraft && isAdmin && editingDraftField === 'title' ? (
          <div style={{ marginBottom: 4 }}>
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                if (demoLocked) return
                const form = e.currentTarget
                const val = (form.elements.namedItem('draftTitle') as HTMLInputElement).value.trim()
                if (!val) return
                await apiFetch(`/bills/${bill.id}/draft`, { method: 'PATCH', body: JSON.stringify({ title: val }) })
                setBill(prev => prev ? { ...prev, title: val } : prev)
                setEditingDraftField(null)
              }}
              style={{ display: 'flex', gap: 8, alignItems: 'center' }}
            >
              <input
                name="draftTitle"
                defaultValue={bill.title ?? ''}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- pre-existing: focus follows the user's own click/Enter into edit mode, out of scope for this task's focus-management redesign
                autoFocus
                onKeyDown={e => { if (e.key === 'Escape') setEditingDraftField(null) }}
                style={{
                  flex: 1,
                  fontSize: fontSize.xxxl,
                  fontWeight: fontWeight.bold,
                  fontFamily: "'Source Serif 4', serif",
                  border: `1px solid ${color.borderStrong}`,
                  borderRadius: radius.md,
                  padding: '4px 8px',
                  color: color.textPrimary,
                  background: color.white,
                  outline: 'none',
                }}
              />
              <button type="submit" style={{ fontSize: fontSize.sm, fontWeight: fontWeight.medium, background: color.accentBlue, color: color.white, border: 'none', borderRadius: radius.md, padding: '6px 12px', cursor: 'pointer' }}>Save</button>
              <button type="button" onClick={() => setEditingDraftField(null)} style={{ fontSize: fontSize.sm, color: color.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: '6px 8px' }}>Cancel</button>
            </form>
          </div>
        ) : bill.isDraft && isAdmin ? (
          <h1
            style={{
              fontSize: fontSize.xxxl, fontWeight: fontWeight.bold, color: color.textPrimary, margin: '0 0 4px', fontFamily: "'Source Serif 4', serif",
            }}
          >
            <button
              type="button"
              aria-label="Edit title"
              onClick={() => { if (!demoLocked) setEditingDraftField('title') }}
              onMouseEnter={() => setHoveredDraftField('title')}
              onMouseLeave={() => setHoveredDraftField(null)}
              disabled={demoLocked}
              style={{
                display: 'block',
                width: '100%',
                margin: 0,
                background: 'none',
                border: 'none',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'inherit',
                ...editableFieldBox(hoveredDraftField === 'title'),
                padding: '4px 8px',
                cursor: demoLocked ? 'not-allowed' : 'text',
                opacity: demoLocked ? 0.5 : 1,
              }}
            >
              {bill.title || bill.abstract}
            </button>
          </h1>
        ) : (
          <h1
            style={{
              fontSize: fontSize.xxxl, fontWeight: fontWeight.bold, color: color.textPrimary, margin: '0 0 4px', fontFamily: "'Source Serif 4', serif",
            }}
          >
            {bill.title || bill.abstract}
          </h1>
        )}
        {bill.abstract && bill.title && bill.abstract.trim().toLowerCase() !== bill.title.trim().toLowerCase() && (
          <p style={{ fontSize: fontSize.sm, color: color.textMuted, margin: '0 0 10px', fontStyle: 'italic', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, fontFamily: "'Source Serif 4', serif" }}>{bill.abstract}</p>
        )}

        {/* Meta row 1: body · type · related bills · external link */}
        {(() => {
          const derivedBody = bill.body || (/^(HB?|AB?)\s/i.test(bill.billNumber) ? 'H' : /^SB?\s/i.test(bill.billNumber) ? 'S' : null)
          const chamberLabel = derivedBody === 'A' ? 'Assembly' : derivedBody === 'H' ? 'House' : derivedBody === 'S' ? 'Senate' : derivedBody === 'C' ? 'Council' : derivedBody
          const typeNoun = bill.billType === 'R' ? 'resolution'
            : bill.billType === 'CR' ? 'concurrent resolution'
            : bill.billType === 'JR' ? 'joint resolution'
            : (!bill.billType || bill.billType === 'B') ? 'bill'
            : bill.billType
          const bodyLabel = chamberLabel ? `${chamberLabel} ${typeNoun}` : null
          const typeLabel = null
          const grouped = new Map<string, RelatedBill[]>()
          for (const r of bill.relatedBillIds) {
            const key = r.type || 'related'
            if (!grouped.has(key)) grouped.set(key, [])
            grouped.get(key)!.push(r)
          }
          const hasAny = bodyLabel || typeLabel || bill.relatedBillIds.length > 0 || bill.companionBillIds.length > 0 || bill.stateUrl || bill.stateLink || bill.legiscanUrl
          if (!hasAny) return null

          // Collect all display items, then render with · separators only between items
          const metaItems: React.ReactNode[] = []
          if (bodyLabel) metaItems.push(<span key="body" style={{ whiteSpace: 'nowrap' }}>{bodyLabel}</span>)
          if (typeLabel) metaItems.push(<span key="type" style={{ whiteSpace: 'nowrap' }}>{typeLabel}</span>)
          grouped.forEach((related, type) => {
            const label = type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
            metaItems.push(
              <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <span style={{ color: color.textMuted }}>{label}:</span>
                {related.map((r, i) => {
                  const isLast = i === related.length - 1
                  const billEl = r.route
                    ? (() => {
                        const to = billUrl({ state: r.route.state, sessionSlug: r.route.sessionSlug, billNumber: r.route.billNumber, id: r.route.id })
                        return <Link key={r.billId || i} to={to} className="blue-link">{r.billNumber}</Link>
                      })()
                    : <span key={r.billId || i}>{r.billNumber}</span>
                  return isLast ? billEl : (
                    <span key={r.billId || i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                      {billEl}<span style={{ marginRight: 2 }}>,</span>
                    </span>
                  )
                })}
              </span>
            )
          })
          bill.companionBillIds.forEach((cid, i) => metaItems.push(
            <span key={`comp-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: color.textMuted }}>Companion:</span>
              <span>{String(cid)}</span>
            </span>
          ))
          if (bill.stateUrl || bill.stateLink || bill.legiscanUrl) metaItems.push(
            <span key="external-links" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {(bill.stateUrl || bill.stateLink) && (
                <a href={bill.stateUrl ?? bill.stateLink!} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>
                  Legislature <ExternalLinkIcon size={12} />
                </a>
              )}
              {(bill.stateUrl || bill.stateLink) && bill.legiscanUrl && (
                <span style={{ color: color.borderStrong }}>·</span>
              )}
              {bill.legiscanUrl && (
                <a href={bill.legiscanUrl} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>
                  LegiScan <ExternalLinkIcon size={12} />
                </a>
              )}
            </span>
          )

          const separated: React.ReactNode[] = []
          for (let i = 0; i < metaItems.length; i++) {
            if (i > 0) separated.push(<span key={`sep-${i}`} style={{ color: color.borderStrong, fontSize: fontSize.base }}>·</span>)
            separated.push(metaItems[i])
          }
          return (
            <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {separated}
            </div>
          )
        })()}

        {/* Meta row 2: committee / referrals */}
        {(bill.committee || (bill.referrals?.length ?? 0) > 0) && (
          <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 6 }}>
            {bill.committee ? (
              <>
                <span style={{ color: color.textMuted, marginRight: 4 }}>Committee:</span>
                {bill.committee}
              </>
            ) : (
              <>
                <span style={{ color: color.textMuted, marginRight: 4 }}>Referrals:</span>
                {(bill.referrals ?? []).map((r, i) => (
                  <span key={r.committee_id}>
                    {i > 0 && <span style={{ color: color.borderStrong, margin: '0 6px' }}>·</span>}
                    {r.name}
                    <span style={{ color: color.textMuted, marginLeft: 4 }}>{r.date.slice(0, 7)}</span>
                  </span>
                ))}
              </>
            )}
          </div>
        )}

        {/* Meta row 3: sponsors */}
        {!bill.isDraft && (bill.sponsor || bill.coSponsors.length > 0) && (
          <SponsorsRow
            sponsor={bill.sponsor}
            sponsorUrl={bill.sponsorUrl ?? null}
            sponsorParty={bill.sponsorParty ?? null}
            coSponsors={bill.coSponsors}
            flashed={flashedSectionId === 'section-sponsors'}
          />
        )}

        {/* Draft: sponsor inline row for admins (shown even when bill.sponsor is null) */}
        {bill.isDraft && isAdmin && (
          <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginTop: 4, marginBottom: 0 }}>
            <span style={{ color: color.textMuted, marginRight: 4 }}>Sponsor(s):</span>
            {editingDraftField === 'sponsor' ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault()
                  if (demoLocked) return
                  const val = (e.currentTarget.elements.namedItem('draftSponsor') as HTMLInputElement).value.trim()
                  await apiFetch(`/bills/${bill.id}/draft`, { method: 'PATCH', body: JSON.stringify({ sponsor: val || null }) })
                  setBill(prev => prev ? { ...prev, sponsor: val || null } : prev)
                  setEditingDraftField(null)
                }}
                style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
              >
                <input
                  name="draftSponsor"
                  defaultValue={bill.sponsor ?? ''}
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- pre-existing: focus follows the user's own click/Enter into edit mode, out of scope for this task's focus-management redesign
                  autoFocus
                  placeholder="e.g. Rep. Jane Smith"
                  onKeyDown={e => { if (e.key === 'Escape') setEditingDraftField(null) }}
                  style={{
                    fontSize: fontSize.sm, border: `1px solid ${color.borderStrong}`, borderRadius: radius.md,
                    padding: '3px 7px', color: color.textPrimary, background: color.white, outline: 'none', minWidth: 220,
                  }}
                />
                <button type="submit" style={{ fontSize: fontSize.sm, fontWeight: fontWeight.medium, background: color.accentBlue, color: color.white, border: 'none', borderRadius: radius.md, padding: '4px 10px', cursor: 'pointer' }}>Save</button>
                <button type="button" onClick={() => setEditingDraftField(null)} style={{ fontSize: fontSize.sm, color: color.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px' }}>Cancel</button>
              </form>
            ) : (
              <button
                type="button"
                aria-label="Edit sponsor"
                onClick={() => { if (!demoLocked) setEditingDraftField('sponsor') }}
                onMouseEnter={() => setHoveredDraftField('sponsor')}
                onMouseLeave={() => setHoveredDraftField(null)}
                disabled={demoLocked}
                style={{
                  display: 'inline-block',
                  margin: 0,
                  background: 'none',
                  border: 'none',
                  font: 'inherit',
                  textAlign: 'left',
                  ...editableFieldBox(hoveredDraftField === 'sponsor'),
                  padding: '1px 6px',
                  cursor: demoLocked ? 'not-allowed' : 'text',
                  opacity: demoLocked ? 0.5 : 1,
                }}
              >
                {bill.sponsor ?? <span style={{ color: color.textMuted, fontStyle: 'italic' }}>None — click to add</span>}
              </button>
            )}
          </div>
        )}

        {/* No-AI section: shown for stubs (not tracked), tracked bills with no text,
            and tracked bills where AI permanently failed (e.g. PDF too long).
            Drafts skip this section entirely — they have their own summary/text blocks below. */}
        {!bill.isDraft && !bill.aiProcessedAt && (() => {
          const isLightweight = bill.matchType === null

          const textConfirmed = bill.textStatus === 'in_r2' || bill.textStatus === 'available'
          // Stuck state: a tracked bill (keyword/manual) with text present but no AI and no
          // permanent skip. Normally transient (AI runs automatically just after text arrives),
          // persistent only when a path set match_type without queueing AI. Surface a repair
          // affordance to admins; members keep seeing nothing (unchanged behavior).
          const isStuck = !isLightweight && textConfirmed && !bill.aiSkipReason
          if (isStuck && !isAdmin) return null

          const message = getNoAnalysisMessage({ matchType: bill.matchType, textStatus: bill.textStatus, aiSkipReason: bill.aiSkipReason })

          // Admins can kick off AI for an unanalyzed bill — either promoting a lightweight stub
          // or repairing a stuck tracked bill. Both go through handlePromote → promote-bill
          // (idempotent on match_type, re-runs AI via forceAI).
          const canRunAnalysis = isAdmin && (isLightweight || isStuck)
          const promoteLabel = isLightweight ? 'Enable full analysis' : 'Run analysis'
          const generateDisabled = promoting || pendingPromote || demoLocked
          const hasAdminContent = canRunAnalysis && (pendingPromote || !generateDisabled || !!promoteError || !!promoteTimeoutMsg)

          const inner = (
            <>
              <p style={{ fontSize: fontSize.base, color: color.textSlate, margin: (isAdmin && hasAdminContent) ? '0 0 10px 0' : 0, lineHeight: 1.5 }}>
                {message}
              </p>
              {canRunAnalysis && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={handlePromote}
                      disabled={generateDisabled}
                      style={{
                        background: generateDisabled ? color.accentBlueMuted : color.accentBlue,
                        color: color.white,
                        border: 'none',
                        borderRadius: radius.md,
                        padding: '8px 14px',
                        cursor: generateDisabled ? 'not-allowed' : 'pointer',
                        fontSize: fontSize.sm,
                        fontWeight: fontWeight.medium,
                        lineHeight: 1.4,
                      }}
                    >
                      {pendingPromote ? 'AI is running…' : promoting ? 'Queueing…' : promoteLabel}
                    </button>
                    {isLightweight && (
                      <>
                        <span style={{ color: color.textMuted, fontSize: fontSize.sm }}>OR</span>
                        <Link
                          to="/admin/config"
                          className="blue-link"
                          style={{ fontSize: fontSize.sm }}
                        >
                          Adjust keywords to capture bills like this.
                        </Link>
                      </>
                    )}
                  </div>
                  {pendingPromote && (
                    <span style={{ fontSize: fontSize.sm, color: color.textSecondary }}>
                      AI is running. This usually takes 10–60 seconds.
                    </span>
                  )}
                  {promoteError && (
                    <span style={{ fontSize: fontSize.sm, color: color.textDanger }} role="alert">{promoteError}</span>
                  )}
                  {promoteTimeoutMsg && (
                    <span style={{ fontSize: fontSize.sm, color: color.textDanger }} role="alert">{promoteTimeoutMsg}</span>
                  )}
                </div>
              )}
            </>
          )

          if (isLightweight || isStuck) {
            return (
              <div className="analyzing-box">
                <div className={`analyzing-box__stripes${pendingPromote ? ' analyzing-box__stripes--animated' : ''}`} />
                <div className="analyzing-box__content">{inner}</div>
              </div>
            )
          }

          return (
            <div style={{
              background: color.surfaceSubtle,
              border: `1px solid ${color.borderDefault}`,
              borderRadius: radius.md,
              padding: '12px 16px',
              marginTop: 14,
              marginBottom: 0,
            }}>
              {inner}
            </div>
          )
        })()}

        {/* Pinned custom fields — rendered above AI summary when any pinned field has a value */}
        {(() => {
          const pinnedWithValues = customFieldDefs
            .filter(f => f.pinned && f.type === 'text' && bill.customFieldValues[f.id])
            .sort((a, b) => a.displayOrder - b.displayOrder)
          if (pinnedWithValues.length === 0) return null
          return (
            <div style={{
              background: color.white,
              borderTop: `3px solid ${color.accentBlue}`,
              borderLeft: `1px solid ${color.borderDefault}`,
              borderRight: `1px solid ${color.borderDefault}`,
              borderBottom: `1px solid ${color.borderDefault}`,
              borderRadius: '0 0 6px 6px',
              padding: '12px 16px',
              marginTop: 14,
            }}>
              {pinnedWithValues.map((field, i) => {
                const entry = bill.customFieldValues[field.id]
                const isEditing = isAdmin && editingPinnedFieldId === field.id
                return (
                  <div key={field.id}>
                    {i > 0 && <hr style={{ border: 'none', borderTop: `1px solid ${color.borderDefault}`, margin: '12px 0' }} />}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={SECTION_LABEL}>
                          {field.name}
                        </span>
                        <span
                          className="material-symbols-outlined"
                          style={{ fontSize: fontSize.sm, color: color.accentBlue, fontVariationSettings: "'FILL' 1", lineHeight: 1, transform: 'rotate(45deg)', display: 'inline-block' }}
                        >
                          keep
                        </span>
                      </div>
                    </div>
                    {isEditing ? (
                      <RichTextEditor
                        enableMentions={false}
                        allowEmpty
                        initialContent={entry.value}
                        submitLabel="Save"
                        // eslint-disable-next-line jsx-a11y/no-autofocus -- pre-existing: focus follows the user's own click/Enter into edit mode, out of scope for this task's focus-management redesign
                        autoFocus
                        onSubmit={async (html) => {
                          const value = html.replace(/<[^>]*>/g, '').trim() ? html : null
                          await apiFetch(`/bills/${bill.id}/custom-fields`, {
                            method: 'PUT',
                            body: JSON.stringify({ [field.id]: value }),
                          })
                          setBill(prev => {
                            if (!prev) return prev
                            const newValues = { ...prev.customFieldValues }
                            if (value === null) {
                              delete newValues[field.id]
                            } else {
                              newValues[field.id] = { value, setBy: 'You', updatedAt: new Date().toISOString() }
                            }
                            return { ...prev, customFieldValues: newValues }
                          })
                          setEditingPinnedFieldId(null)
                        }}
                        onCancel={() => setEditingPinnedFieldId(null)}
                      />
                    ) : (
                      <>
                        {isAdmin ? (
                          <button
                            type="button"
                            aria-label={`Edit ${field.name}`}
                            onClick={() => setEditingPinnedFieldId(field.id)}
                            onMouseEnter={() => setHoveredPinnedFieldId(field.id)}
                            onMouseLeave={() => setHoveredPinnedFieldId(null)}
                            style={{
                              display: 'block',
                              width: '100%',
                              margin: 0,
                              font: 'inherit',
                              textAlign: 'left',
                              border: `1px solid ${hoveredPinnedFieldId === field.id ? color.borderStrong : color.borderDefault}`,
                              borderRadius: radius.md,
                              padding: '6px 8px',
                              background: hoveredPinnedFieldId === field.id ? color.surfaceMuted : color.white,
                              transition: 'border-color 0.15s, background 0.15s',
                              cursor: 'text',
                            }}
                          >
                            <CommentContent content={entry.value} fontSize={14} />
                          </button>
                        ) : (
                          <div>
                            <CommentContent content={entry.value} fontSize={14} />
                          </div>
                        )}
                        <div
                          title={absoluteTime(entry.updatedAt)}
                          style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: 4, cursor: 'default' }}
                        >
                          Set by {entry.setBy ?? 'Unknown'} · {relativeTime(entry.updatedAt)}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })()}

        {/* AI summary / tags / relevance — shown when there is content to display (not for drafts) */}
        {!bill.isDraft && (bill.tenantSummary || bill.tags.length > 0 || bill.relevanceScore != null || (isAdmin && regenerating)) && (
          <div
            className={regenerating ? 'analyzing-box' : undefined}
            style={regenerating
              ? { marginBottom: 0 }
              : { background: color.surfaceSubtle, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, padding: '12px 16px', marginTop: 14, marginBottom: 0 }}
          >
            {regenerating && <div className="analyzing-box__stripes analyzing-box__stripes--animated" />}
            <div className={regenerating ? 'analyzing-box__content' : undefined}>
            {bill.tenantSummary && (
              <div style={{ marginBottom: bill.tags.length > 0 ? 10 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={SECTION_LABEL}>
                      AI Summary
                    </span>
                    {bill.tenantSummary && bill.lastAiTextDocId && (() => {
                      const text = bill.texts.find(t => t.docId === bill.lastAiTextDocId)
                      if (!text) return null
                      return (
                        <>
                          <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
                            <span style={{ marginRight: 6, marginLeft: 2 }}>·</span>based on text
                          </span>
                          <BillTextChip
                            type={text.type}
                            date={text.date}
                            onClick={() => {
                              setShowBillText(true)
                              setRequestedDocId(text.docId)
                              setTimeout(() => setRequestedDocId(null), 100)
                            }}
                            title="Show this bill text version"
                          />
                        </>
                      )
                    })()}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {bill.relevanceScore != null && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={SECTION_LABEL}>
                          {orgRelevanceLabel(config?.orgNoun ?? DEFAULT_ORG_NOUN)}
                        </span>
                        <RelevanceChip score={bill.relevanceScore} onClick={() => navigate(`/bills?minRelevance=${bill.relevanceScore}`)} />
                      </div>
                    )}
                    <InfoTooltip
                      text="Summary, tags, and relevance score are generated by AI based on instructions provided by admins. AI can make mistakes."
                      maxWidth={260}
                    />
                  </div>
                </div>
                <MarkdownSummary fontSize={fontSize.base} color={color.textSlate} lineHeight={1.5}>
                  {bill.tenantSummary}
                </MarkdownSummary>
              </div>
            )}
            {!bill.tenantSummary && bill.relevanceScore != null && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <RelevanceChip score={bill.relevanceScore} showLabel onClick={() => navigate(`/bills?minRelevance=${bill.relevanceScore}`)} />
              </div>
            )}
            {(bill.tags.length > 0 || isAdmin) && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: bill.tenantSummary || bill.abstract ? 10 : 0 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                  {bill.tags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => navigate(`/bills?tag=${encodeURIComponent(tag)}`)}
                      onMouseEnter={() => setHoveredTag(tag)}
                      onMouseLeave={() => setHoveredTag(null)}
                      style={hoveredTag === tag ? TAG_CHIP_HOVERED : TAG_CHIP}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={handleRegenerate}
                    disabled={regenerating || demoLocked}
                    title="Re-run AI summary, tags, and relevance for this bill"
                    style={{
                      flexShrink: 0, marginLeft: 'auto',
                      background: (regenerating || demoLocked) ? color.bgRedDisabled : color.textErrorRed,
                      color: color.white, border: 'none', borderRadius: radius.md,
                      padding: '6px 12px', cursor: (regenerating || demoLocked) ? 'not-allowed' : 'pointer',
                      fontSize: fontSize.sm, fontWeight: fontWeight.medium, lineHeight: 1.4, whiteSpace: 'nowrap',
                    }}
                  >
                    {regenerating ? 'Regenerating…' : 'Re-generate'}
                  </button>
                )}
              </div>
            )}
            {regenerateError && (
              <div style={{ fontSize: fontSize.sm, color: color.textDanger, marginTop: 8 }} role="alert">{regenerateError}</div>
            )}
            </div>{/* end analyzing-box__content wrapper */}
          </div>
        )}

        {/* Draft summary + bill text — draft-only blocks replacing AI section */}
        {bill.isDraft && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>

            {/* Draft summary */}
            <div style={{ background: color.surfaceSubtle, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={SECTION_LABEL}>Summary</span>
              </div>
              {isAdmin && editingDraftField === 'summary' ? (
                <RichTextEditor
                  enableMentions={false}
                  allowEmpty
                  initialContent={bill.tenantSummary ?? ''}
                  submitLabel="Save"
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- pre-existing: focus follows the user's own click/Enter into edit mode, out of scope for this task's focus-management redesign
                  autoFocus
                  disabled={demoLocked}
                  onSubmit={async (html) => {
                    const value = html.replace(/<[^>]*>/g, '').trim() ? html : null
                    await apiFetch(`/bills/${bill.id}/draft`, { method: 'PATCH', body: JSON.stringify({ summary: value }) })
                    setBill(prev => prev ? { ...prev, tenantSummary: value } : prev)
                    setEditingDraftField(null)
                  }}
                  onCancel={() => setEditingDraftField(null)}
                />
              ) : isAdmin ? (
                <button
                  type="button"
                  aria-label="Edit summary"
                  onClick={() => { if (!demoLocked) setEditingDraftField('summary') }}
                  onMouseEnter={() => setHoveredDraftField('summary')}
                  onMouseLeave={() => setHoveredDraftField(null)}
                  disabled={demoLocked}
                  style={{
                    display: 'block',
                    width: '100%',
                    margin: 0,
                    background: 'none',
                    border: 'none',
                    font: 'inherit',
                    textAlign: 'left',
                    ...editableFieldBox(hoveredDraftField === 'summary'),
                    padding: '6px 8px',
                    minHeight: 40,
                    cursor: demoLocked ? 'not-allowed' : 'text',
                    opacity: demoLocked ? 0.5 : 1,
                  }}
                >
                  {bill.tenantSummary
                    ? <CommentContent content={bill.tenantSummary} fontSize={14} />
                    : <span style={{ color: color.textMuted, fontStyle: 'italic', fontSize: fontSize.base }}>No summary — click to add</span>
                  }
                </button>
              ) : (
                <div>
                  {bill.tenantSummary
                    ? <CommentContent content={bill.tenantSummary} fontSize={14} />
                    : <span style={{ color: color.textMuted, fontStyle: 'italic', fontSize: fontSize.base }}>No summary.</span>
                  }
                </div>
              )}
            </div>

            {/* Draft bill text */}
            <div style={{ background: color.surfaceSubtle, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={SECTION_LABEL}>Bill Text</span>
              </div>
              {isAdmin && editingDraftField === 'text' ? (
                <RichTextEditor
                  enableMentions={false}
                  allowEmpty
                  initialContent={bill.draftText ?? ''}
                  submitLabel="Save"
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- pre-existing: focus follows the user's own click/Enter into edit mode, out of scope for this task's focus-management redesign
                  autoFocus
                  disabled={demoLocked}
                  onSubmit={async (html) => {
                    const value = html.replace(/<[^>]*>/g, '').trim() ? html : null
                    await apiFetch(`/bills/${bill.id}/draft`, { method: 'PATCH', body: JSON.stringify({ text: value }) })
                    setBill(prev => prev ? { ...prev, draftText: value } : prev)
                    setEditingDraftField(null)
                  }}
                  onCancel={() => setEditingDraftField(null)}
                />
              ) : isAdmin ? (
                <button
                  type="button"
                  aria-label="Edit bill text"
                  onClick={() => { if (!demoLocked) setEditingDraftField('text') }}
                  onMouseEnter={() => setHoveredDraftField('text')}
                  onMouseLeave={() => setHoveredDraftField(null)}
                  disabled={demoLocked}
                  style={{
                    display: 'block',
                    width: '100%',
                    margin: 0,
                    background: 'none',
                    border: 'none',
                    font: 'inherit',
                    textAlign: 'left',
                    ...editableFieldBox(hoveredDraftField === 'text'),
                    padding: '6px 8px',
                    minHeight: 40,
                    cursor: demoLocked ? 'not-allowed' : 'text',
                    opacity: demoLocked ? 0.5 : 1,
                  }}
                >
                  {bill.draftText
                    ? <CommentContent content={bill.draftText} fontSize={14} />
                    : <span style={{ color: color.textMuted, fontStyle: 'italic', fontSize: fontSize.base }}>No bill text — click to add</span>
                  }
                </button>
              ) : (
                <div>
                  {bill.draftText
                    ? <CommentContent content={bill.draftText} fontSize={14} />
                    : <span style={{ color: color.textMuted, fontStyle: 'italic', fontSize: fontSize.base }}>No bill text.</span>
                  }
                </div>
              )}
            </div>

          </div>
        )}

        {/* Bill text collapsible */}
        {!bill.isDraft && bill.texts.length > 0 && bill.textR2Key && (
          <CollapsibleSection
            label="Bill texts"
            count={bill.texts.length}
            open={showBillText}
            onToggle={() => setShowBillText(v => !v)}
          >
            <BillTextPanel key={bill.id} billId={bill.id} texts={bill.texts ?? []} externalOpen={showBillText} requestedDocId={requestedDocId} />
          </CollapsibleSection>
        )}

        {/* Amendments collapsible */}
        {hasAmendments && (() => {
          const amendments = (bill.amendments ?? []).filter(a => a.url || a.stateLink)
            .sort((a, b) => (effectiveItemDate(b) ?? '').localeCompare(effectiveItemDate(a) ?? ''))
          return (
            <CollapsibleSection
              id="section-amendments"
              label="Amendments"
              count={amendments.length}
              open={showAmendments}
              onToggle={() => setShowAmendments(v => !v)}
              hasPrev={hasBillText}
              flashed={flashedSectionId === 'section-amendments'}
              openHint={<span style={{ fontSize: fontSize.xs, color: color.textMuted, fontWeight: fontWeight.normal, letterSpacing: 0, textTransform: 'none' as const }}>most recent first</span>}
            >
              {amendments.map((a, i) => (
                <div key={`a-${a.amendmentId}`} style={{ display: 'flex', gap: 12, fontSize: fontSize.sm, padding: '6px 0 6px 8px', borderTop: i > 0 ? `1px solid ${color.surfaceMuted}` : undefined, alignItems: 'flex-start' }}>
                  <div style={{ color: color.textMuted, whiteSpace: 'nowrap', minWidth: 80 }}>
                    <ItemDateText item={a} />
                  </div>
                  <span style={{ fontSize: fontSize.xs, fontWeight: fontWeight.bold, padding: '1px 5px', borderRadius: radius.sm, alignSelf: 'flex-start', whiteSpace: 'nowrap', flexShrink: 0, ...(a.adopted ? { color: color.textSuccessDark, background: color.bgSuccessChip } : { color: color.textSlate500, background: color.surfaceMuted }) }}>
                    AMENDMENT{a.adopted ? ' ✓' : ''}
                  </span>
                  <a href={a.stateLink ?? a.url ?? '#'} target="_blank" rel="noreferrer" style={{ color: color.linkBlue, textDecoration: 'none', fontWeight: fontWeight.normal }}>
                    {a.description || a.title}<ExternalLinkIcon />
                  </a>
                </div>
              ))}
            </CollapsibleSection>
          )
        })()}

        {/* Actions collapsible */}
        {bill.lastAction && (() => {
          const actionCount = bill.history.length + (bill.voteSummary?.length ?? 0)
            + (syntheticLatestAction(bill.history, bill.lastAction, bill.lastActionDate) ? 1 : 0)
          return (
            <CollapsibleSection
              id="section-actions"
              label="Actions"
              count={actionCount > 0 ? actionCount : undefined}
              open={showActions}
              onToggle={() => setShowActions(v => !v)}
              hasPrev={hasBillText || hasAmendments}
              flashed={flashedSectionId === 'section-actions'}
              openHint={<span style={{ fontSize: fontSize.xs, color: color.textMuted, fontWeight: fontWeight.normal, letterSpacing: 0, textTransform: 'none' as const }}>most recent first</span>}
              closedSummary={
                <span style={{ fontSize: fontSize.sm, color: color.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                  <span style={{ color: color.textMuted, marginRight: 6 }}>Last action:</span>
                  {bill.lastActionDate && <>{bill.lastActionDate}<span style={{ color: color.borderStrong, margin: '0 5px', fontSize: fontSize.base }}>·</span></>}
                  {/^\d{2}\/\d{2}\/\d{4} /.test(bill.lastAction) ? bill.lastAction.slice(11) : bill.lastAction}
                </span>
              }
            >
              <LegislativeHistory entries={bill.history} votes={bill.voteSummary ?? []} lastAction={bill.lastAction} lastActionDate={bill.lastActionDate} defaultOpen hideHeader />
            </CollapsibleSection>
          )
        })()}

        {/* Hearings collapsible */}
        {(bill.calendar ?? []).length > 0 && (() => {
          const today = todayIso()
          return (
            <CollapsibleSection
              id="section-hearings"
              label="Hearings"
              count={bill.calendar.length}
              open={showHearings}
              onToggle={() => setShowHearings(v => !v)}
              hasPrev={hasBillText || hasAmendments || hasActions}
              flashed={flashedSectionId === 'section-hearings'}
              openHint={<span style={{ fontSize: fontSize.xs, color: color.textMuted, fontWeight: fontWeight.normal, letterSpacing: 0, textTransform: 'none' as const }}>most recent first</span>}
            >
              {[...bill.calendar].sort((a, b) => b.date.localeCompare(a.date)).map((entry, i) => {
                const isPast = entry.date < today
                // All hearings share the navy identity — the same navy as the
                // bill-number badge and the calendar/feed gavel — so a hearing
                // reads the same everywhere. Chamber (Senate / House) is carried
                // by the label text, not colour.
                const chipColor = { color: color.billBadgeNavy, background: color.bgInfo }
                return (
                  <TabularRow
                    key={entry.eventHash || `hearing-${i}`}
                    showTopBorder={i > 0}
                    opacity={isPast ? 0.5 : 1}
                    date={
                      <>
                        <div style={{ whiteSpace: 'nowrap' }}>{safeDate(entry.date) ?? '—'}</div>
                        {safeTime(entry.time) && <div style={{ fontSize: fontSize.xs, marginTop: 1 }}>{entry.time}</div>}
                      </>
                    }
                    chip={
                      <span style={{ fontSize: fontSize.xs, fontWeight: fontWeight.bold, padding: '1px 5px', borderRadius: radius.sm, whiteSpace: 'nowrap', ...chipColor }}>
                        {entry.type.toUpperCase()}
                      </span>
                    }
                    content={
                      <div style={{ color: color.textSlate }}>
                        <div style={{ fontWeight: fontWeight.medium }}>{entry.description || entry.type}</div>
                        {entry.location && <div style={{ color: color.textSecondary, fontSize: fontSize.xs, marginTop: 1 }}>{entry.location}</div>}
                      </div>
                    }
                  />
                )
              })}
            </CollapsibleSection>
          )
        })()}

        {/* Documents collapsible (supplements only) */}
        {(bill.supplements ?? []).filter(s => s.stateLink || s.url).length > 0 && (() => {
          const suppChipStyle = (typeId: number): React.CSSProperties => {
            switch (typeId) {
              case 1: case 3: return { color: color.textSuccessDark, background: color.bgSuccessChip }  // Fiscal Note
              case 2: return { color: color.tagTextBlue, background: color.bgBlueChip }                 // Analysis
              case 4: return { color: color.brandViolet, background: color.bgVioletSoft }                // Vote Image
              case 5: return { color: color.textAmberDark, background: color.bgAmberPriority }           // Local Mandate
              case 6: return { color: color.textDanger, background: color.bgRedPriority }            // Corrections Impact
              case 8: return { color: color.textDanger, background: color.bgRedPriority }            // Veto Letter
              default: return { color: color.textSlate500, background: color.surfaceMuted }              // Misc
            }
          }
          const supps = (bill.supplements ?? []).filter(s => s.stateLink || s.url)
            .sort((a, b) => (effectiveItemDate(b) ?? '').localeCompare(effectiveItemDate(a) ?? ''))
          return (
            <CollapsibleSection
              id="section-documents"
              label="Documents"
              count={supps.length}
              open={showDocuments}
              onToggle={() => setShowDocuments(v => !v)}
              hasPrev={hasBillText || hasAmendments || hasActions || hasHearings}
              flashed={flashedSectionId === 'section-documents'}
              openHint={<span style={{ fontSize: fontSize.xs, color: color.textMuted, fontWeight: fontWeight.normal, letterSpacing: 0, textTransform: 'none' as const }}>most recent first</span>}
            >
              {supps.map((s, i) => (
                <TabularRow
                  key={`s-${s.supplementId}`}
                  showTopBorder={i > 0}
                  date={<span style={{ whiteSpace: 'nowrap' }}><ItemDateText item={s} /></span>}
                  chip={
                    <span style={{ fontSize: fontSize.xs, fontWeight: fontWeight.bold, padding: '1px 5px', borderRadius: radius.sm, whiteSpace: 'nowrap', ...suppChipStyle(s.typeId) }}>
                      {s.type.toUpperCase()}
                    </span>
                  }
                  content={
                    <a href={s.stateLink ?? s.url ?? '#'} target="_blank" rel="noreferrer" style={{ color: color.linkBlue, textDecoration: 'none', fontWeight: fontWeight.normal }}>
                      {s.description || s.title}<ExternalLinkIcon />
                    </a>
                  }
                />
              ))}
            </CollapsibleSection>
          )
        })()}
      </div>

      {/* Two-column layout */}
      <div className="bill-detail-columns" style={{ display: 'flex', gap: 24, padding: '24px 0' }}>

        {/* Left column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Comments */}
          <div id="section-comments" style={{ ...CARD, padding: 16, boxShadow: flashedSectionId === 'section-comments' ? '0 0 0 3px #fde68a' : (CARD.boxShadow as string | undefined), transition: 'box-shadow 0.6s ease' }}>
            <div style={{ ...SECTION_LABEL, marginBottom: 14 }}>
              Comments{comments.length > 0 && <span style={{ ...COUNT_BADGE, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>{comments.length}</span>}
            </div>
            {comments.map((comment, idx) => (
              <div key={comment.id} id={`comment-${comment.id}`} className={newCommentIds.has(comment.id) ? 'comment-new' : ''} style={{ paddingBottom: 14, marginBottom: 14, borderBottom: idx < comments.length - 1 ? `1px solid ${color.surfaceMuted}` : 'none', borderRadius: radius.md, boxShadow: flashedCommentId === comment.id ? '0 0 0 3px #fde68a' : 'none', transition: 'box-shadow 0.6s ease' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  {/* Comment header (name / subtitle / date) — shared with the
                      @-mention email's card row via COMMENT_STYLE; keep both in sync there. */}
                  <span
                    style={{ fontSize: COMMENT_STYLE.nameSize, fontWeight: COMMENT_STYLE.nameWeight, color: COMMENT_STYLE.nameColor, position: 'relative', cursor: 'default' }}
                    onMouseEnter={() => setHoveredCommentUser(comment.id)}
                    onMouseLeave={() => setHoveredCommentUser(null)}
                  >
                    {comment.userName}
                    {comment.userSubtitle && (
                      <span style={{ fontSize: COMMENT_STYLE.subtitleSize, fontWeight: COMMENT_STYLE.subtitleWeight, color: COMMENT_STYLE.subtitleColor, marginLeft: 4 }}>{comment.userSubtitle}</span>
                    )}
                    {hoveredCommentUser === comment.id && (() => {
                      const commenter = usersData.find(u => u.id === comment.userId)
                      const userRoles = commenter?.roles ?? []
                      if (userRoles.length === 0) return null
                      return (
                        <div style={{
                          ...TOOLTIP_STYLE,
                          position: 'absolute',
                          left: 0,
                          top: 'calc(100% + 4px)',
                          transform: 'none',
                          padding: '6px 12px',
                        }}>
                          <div style={{ ...SECTION_LABEL, marginBottom: 4 }}>Roles</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {sortRoles(userRoles).map(r => (
                              <span key={r.id} style={ROLE_CHIP}>{r.name}</span>
                            ))}
                          </div>
                        </div>
                      )
                    })()}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span title={absoluteTime(comment.createdAt)} style={{ fontSize: COMMENT_STYLE.dateSize, color: COMMENT_STYLE.dateColor, cursor: 'default' }}>{relativeTime(comment.createdAt)}</span>
                    {(comment.userId === user?.id || user?.role === 'admin' || user?.role === 'owner') && editingCommentId !== comment.id && (
                      <>
                        {comment.userId === user?.id && (
                          <button onClick={() => setEditingCommentId(comment.id)}
                            style={{ fontSize: fontSize.sm, color: color.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                            Edit
                          </button>
                        )}
                        <button onClick={() => handleDeleteComment(comment.id)}
                          disabled={demoLocked}
                          style={{ fontSize: fontSize.sm, color: color.textErrorRed, background: 'none', border: 'none', cursor: demoLocked ? 'not-allowed' : 'pointer', opacity: demoLocked ? 0.5 : 1, padding: 0 }}>
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                </div>
                {editingCommentId === comment.id
                  ? (
                    <div style={{ marginBottom: 8 }}>
                      <RichTextEditor
                        initialContent={comment.content}
                        onSubmit={(html) => handleSaveEdit(comment.id, html)}
                        onCancel={() => setEditingCommentId(null)}
                        submitLabel="Save"
                        placeholder="Edit comment…"
                        // eslint-disable-next-line jsx-a11y/no-autofocus -- pre-existing: focus follows the user's own click/Enter into edit mode, out of scope for this task's focus-management redesign
                        autoFocus
                      />
                    </div>
                  )
                  : <div style={{ margin: '0 0 8px' }}><CommentContent content={comment.content} users={usersData} roles={rolesData} fontSize={COMMENT_STYLE.bodySize} /></div>
                }
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', position: 'relative' }}>
                  {comment.reactions.map((r) => (
                    <span key={r.emoji} style={{ position: 'relative', display: 'inline-block' }}
                      onMouseEnter={(e) => {
                        if (r.reactors.length === 0) return
                        const tip = e.currentTarget.querySelector<HTMLElement>('.reaction-tip')
                        if (tip) tip.style.display = 'block'
                      }}
                      onMouseLeave={(e) => {
                        const tip = e.currentTarget.querySelector<HTMLElement>('.reaction-tip')
                        if (tip) tip.style.display = 'none'
                      }}
                    >
                      <button
                        onClick={() => handleReaction(comment.id, r.emoji)}
                        style={{
                          fontSize: fontSize.sm, padding: '2px 8px', borderRadius: radius.xl, border: '1px solid',
                          borderColor: r.userReacted ? color.accentBlueMuted : color.borderDefault,
                          background: r.userReacted ? color.bgInfo : color.white,
                          cursor: 'pointer',
                        }}
                      >
                        {r.emoji} {r.count}
                      </button>
                      <span className="reaction-tip" style={{
                        display: 'none',
                        position: 'absolute',
                        bottom: 'calc(100% + 6px)',
                        left: 0,
                        background: color.tooltipBg,
                        color: color.white,
                        fontSize: fontSize.sm,
                        borderRadius: radius.sm,
                        padding: '6px 10px',
                        whiteSpace: 'nowrap',
                        zIndex: 10,
                        pointerEvents: 'none',
                        lineHeight: 1.6,
                      }}>
                        {r.reactors.map((reactor) => (
                          <div key={reactor.name}>
                            <span style={{ fontWeight: fontWeight.semibold }}>{reactor.name}</span>
                            {reactor.subtitle && <span style={{ color: color.borderStrong, marginLeft: 4 }}>{reactor.subtitle}</span>}
                          </div>
                        ))}
                        <span style={{
                          position: 'absolute',
                          top: '100%',
                          left: 12,
                          width: 0, height: 0,
                          borderLeft: '5px solid transparent',
                          borderRight: '5px solid transparent',
                          borderTop: `6px solid ${color.tooltipBg}`,
                        }} />
                      </span>
                    </span>
                  ))}
                  <button
                    aria-label="Add reaction"
                    onClick={() => setOpenPickerFor(openPickerFor === comment.id ? null : comment.id)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 1,
                      background: 'none',
                      border: `1px solid ${color.borderDefault}`,
                      borderRadius: radius.xl,
                      padding: '2px 8px',
                      cursor: 'pointer',
                      color: color.textMuted,
                      fontSize: fontSize.sm,
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: fontSize.lg }}>add_reaction</span>
                  </button>
                  {openPickerFor === comment.id && (
                    <div style={{ position: 'absolute', bottom: '100%', left: 0, zIndex: 20, marginBottom: 4 }}>
                      <ReactionPicker
                        onSelect={(emoji) => { handleReaction(comment.id, emoji); setOpenPickerFor(null) }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 12 }}>
              {/* Key on the bill so navigating to another bill remounts a fresh,
                  empty composer. Without this, the unkeyed editor keeps the prior
                  bill's draft text across the spinner-less prefetch navigation
                  (BillDetail stays mounted and just swaps data). */}
              <RichTextEditor
                key={bill.id}
                onSubmit={handlePostComment}
                placeholder="Add a comment…"
                submitLabel="Post"
              />
            </div>
          </div>

          {/* Custom fields */}
          <CustomFieldsSection
            fields={customFieldDefs}
            billId={bill.id}
            values={bill.customFieldValues}
            isAdmin={isAdmin}
            onUpdate={(fieldId, value, setBy) => {
              setBill(prev => {
                if (!prev) return prev
                const newValues = { ...prev.customFieldValues }
                if (value === null) {
                  delete newValues[fieldId]
                } else {
                  newValues[fieldId] = { value, setBy, updatedAt: new Date().toISOString() }
                }
                return { ...prev, customFieldValues: newValues }
              })
            }}
          />

        </div>

        {/* Right column */}
        <div className="bill-detail-right-col" style={{ width: 272, display: 'flex', flexDirection: 'column', gap: 16, flexShrink: 0 }}>

          {/* Association position */}
          <div style={{ ...CARD, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={SECTION_LABEL}>{orgPositionLabel(config?.orgNoun ?? DEFAULT_ORG_NOUN)}</span>
              <InfoTooltip text="Only admins can set this position." />
            </div>
            {isAdmin
              ? (
                <>
                  <CompactPositionSelect
                    billId={bill.id}
                    current={position}
                    options={config?.positionVocabulary ?? ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position']}
                    size="lg"
                    onChange={(p) => {
                      setPosition(p)
                      if (p) {
                        setPositionMeta({ setByName: user!.name, updatedAt: new Date().toISOString() })
                      } else {
                        setPositionMeta(null)
                      }
                    }}
                  />
                  {positionMeta && (
                    <div title={absoluteTime(positionMeta.updatedAt)} style={{ ...CHROME_TEXT, marginTop: 6, cursor: 'default' }}>
                      Set by {positionMeta.setByName} · {relativeTime(positionMeta.updatedAt)}
                    </div>
                  )}
                </>
              )
              : position
                ? (
                  <div>
                    <PositionBadge position={position} tooltip={`Your ${config?.orgNoun ?? DEFAULT_ORG_NOUN}'s official position on this bill`} />
                    {positionMeta && (
                      <div title={absoluteTime(positionMeta.updatedAt)} style={{ ...CHROME_TEXT, marginTop: 4, cursor: 'default' }}>
                        Set by {positionMeta.setByName} · {relativeTime(positionMeta.updatedAt)}
                      </div>
                    )}
                  </div>
                )
                : <span style={{ fontSize: fontSize.sm, color: color.textMuted }}>No position set</span>
            }
          </div>

          <SentimentBars voteCounts={voteCounts} memberVotes={bill.memberVotes} isAdmin={isAdmin} myVote={myVote} onVote={user?.canVote === true ? handleVote : undefined} canVote={user?.canVote} />

          <div id="section-note" style={{ borderRadius: radius.lg, boxShadow: flashedSectionId === 'section-note' ? '0 0 0 3px #fde68a' : 'none', transition: 'box-shadow 0.6s ease' }}>
            <PersonalNote key={bill.id} billId={bill.id} initialContent={bill.myNote} />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '12px 0', borderTop: `1px solid ${color.borderDefault}` }}>
        <Link to={sessionStorage.getItem('lastBillsUrl') ?? '/bills'} style={{ fontSize: fontSize.sm, color: color.linkBlue, textDecoration: 'none' }}>← Back to bills</Link>
      </div>
      </div>
  )
}
