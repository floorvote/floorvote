import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PRODUCT_NAME, SOURCE_URL, LICENSE_NAME, LICENSE_URL } from '../../../shared/brand'
import { LEGISCAN_ATTRIBUTION, type DataAttribution, type ProviderCredit } from '../../../shared/dataAttribution'
import { legalDocsVisible } from '../lib/legalVisibility'
import { useDemo } from '../context/DemoContext'
import { useConfig, type OperatorConfig } from '../context/ConfigContext'
import { HoverTooltip } from './HoverTooltip'
import { SR_ONLY } from '../lib/textStyles'
import { useIsDark } from '../lib/colorMode'
import { color, fontSize } from '../styles/tokens'

// Conventional, generic asset path (not operator-specific). A deployer drops their
// logo at web/public/operator-logo.svg; if the file is absent the <img> errors and
// is hidden (see logoState) — no broken-image icon. A deployer may also drop an
// optional web/public/operator-logo-dark.svg: dark mode asks for it first and falls
// back to the regular logo if it fails to load, so existing deployments are unchanged.
const OPERATOR_LOGO_SRC = '/operator-logo.svg'
const OPERATOR_LOGO_DARK_SRC = '/operator-logo-dark.svg'
const EMPTY_OPERATOR: OperatorConfig = { name: '', url: '', contactEmails: [] }

// One plain sentence per license, hardcoded. Both state a fact about the work and
// the data it serves, identical for every deployment, so neither is operator
// config. They exist because "AGPLv3" and "CC BY 4.0" mean nothing to most
// readers: a link to the license text explains the terms to a lawyer, not the
// entitlement to a member. Deliberately not an ⓘ with contacts and actions —
// telling someone the right exists is the whole job.
const LICENSE_NOTE = `${PRODUCT_NAME} is free software licensed under the ${LICENSE_NAME}, which means that users are entitled to the source code of the version they are being served.`

// The hover bubble in HoverTooltip's default archetype is aria-hidden — the
// child's own name carries the accessible name — so on its own the sentence
// would reach sighted users only. These ids tie an SR_ONLY copy to each link
// via aria-describedby, so a screen reader announces the same explanation.
const LICENSE_NOTE_ID = 'footer-license-note'
// The id comes from central, so it is cut down to what is safe in an id attribute and an aria-describedby list.
const dataNoteId = (providerId: string) => `footer-data-note-${providerId.replace(/[^A-Za-z0-9_-]/g, '-')}`

// What the footer credits until the config says otherwise: LegiScan's, the
// default provider's.
const DEFAULT_CREDITS = [{ id: 'legiscan', ...LEGISCAN_ATTRIBUTION }]

/**
 * Pinned sidebar footer: the operator credit (logo + name, optionally linked) and
 * the data-provider credits. Operator identity comes from GET /config via
 * ConfigContext; `operator` is an optional prop only so tests can drive it.
 *
 * Graceful absence: the logo renders hidden and is revealed only on a successful
 * onLoad; onError leaves it hidden. In dark mode the optional dark file is tried
 * first; if it errors (absent), the regular logo takes its place and the dark file
 * is not asked for again. A missing regular logo hides the image as above in light
 * mode, but never stops dark mode trying the dark file. When there is no name and the logo did not
 * load, the credit block collapses — only the data credits remain (those lines
 * are data-provider credits, some under a license, and always render).
 *
 * The footer shows three muted lines below the operator credit: the license
 * line, one "Data:" line crediting every provider the instance's states come
 * from, comma-separated ("Data: LegiScan (CC BY 4.0)", for LegiScan), and a "Terms · Privacy" line
 * gated on `showTerms`/`showPrivacy` (defaulting to `legalDocsVisible`: the docs
 * were bundled and this is not a demo tenant). `sourceUrl`/`showTerms`/
 * `showPrivacy` are optional props only so tests can drive them.
 *
 * The license line always renders — AGPL §5 asks that legal notices be
 * preserved, so an operator can withhold a source URL they do not have but
 * cannot silently strip the attribution. Only the link is conditional:
 *
 *   url set    → "Source: <product> (AGPLv3)", product name links to it
 *   url empty  → "<product> (AGPLv3)", no link and no "Source:" promise
 *
 * The license name always links to `LICENSE_URL` — a canonical address, not one
 * derived from the source URL, so it cannot go stale with the operator's host.
 *
 * `sourceUrl` resolves prop → operator config → the `SOURCE_URL` constant. The
 * constant is the truthful default for a deployment running unmodified code;
 * an operator running a modified version overrides it via
 * `OPERATOR_SOURCE_URL` to point at their own published source. An explicitly
 * empty config value is suppression, which is why the chain uses `??` and not
 * `||` — see the note in the tenant API's /config handler.
 */
export function OperatorBranding({
  operator: propOperator,
  sourceUrl: propSourceUrl,
  showTerms: propShowTerms,
  showPrivacy: propShowPrivacy,
  dataCredits: propDataCredits,
}: {
  operator?: OperatorConfig
  sourceUrl?: string
  showTerms?: boolean
  showPrivacy?: boolean
  dataCredits?: ProviderCredit[]
} = {}) {
  const { config } = useConfig()
  const { demoMode } = useDemo()
  const operator = propOperator ?? config?.operator ?? EMPTY_OPERATOR
  const sourceUrl = propSourceUrl ?? operator.sourceUrl ?? SOURCE_URL
  // Prop wins so tests can drive it, same as sourceUrl above.
  const visible = legalDocsVisible(demoMode)
  const showTerms = propShowTerms ?? visible.showTerms
  const showPrivacy = propShowPrivacy ?? visible.showPrivacy
  // An empty list never reaches the footer: a data credit always renders.
  const configured = propDataCredits ?? config?.attribution?.providers
  const dataCredits = configured && configured.length > 0 ? configured : DEFAULT_CREDITS
  const dark = useIsDark()
  // Which files have errored, and which src has loaded. An img is shown only once
  // its current src has loaded, so a missing file never paints a broken image and a
  // swap between modes never leaves the other mode's logo up while the new one loads.
  const [darkMissing, setDarkMissing] = useState(false)
  const [regularMissing, setRegularMissing] = useState(false)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const logoSrc = dark && !darkMissing ? OPERATOR_LOGO_DARK_SRC : OPERATOR_LOGO_SRC
  // Only the file in play can fail the logo: a regular logo known to be missing hides it in light mode
  // (or in dark mode once the dark file is missing too), but does not stop the dark file being tried.
  const logoState: 'pending' | 'loaded' | 'failed' =
    logoSrc === OPERATOR_LOGO_SRC && regularMissing ? 'failed' : loadedSrc === logoSrc ? 'loaded' : 'pending'

  const showName = Boolean(operator.name)
  const logoVisible = logoState === 'loaded'
  // Render the credit wrapper while the logo is still loading (so the <img> can fire
  // onLoad/onError) or once there is something to show. Collapse only when the logo
  // has failed AND there is no name.
  const showCredit = showName || logoState !== 'failed'
  const hasVisibleCredit = showName || logoVisible

  const credit = (
    <>
      {logoState !== 'failed' && (
        <img
          key={logoSrc}
          src={logoSrc}
          onLoad={() => setLoadedSrc(logoSrc)}
          onError={() => (logoSrc === OPERATOR_LOGO_DARK_SRC ? setDarkMissing(true) : setRegularMissing(true))}
          alt={operator.name || PRODUCT_NAME}
          style={{
            display: logoVisible ? 'block' : 'none',
            margin: '0 auto', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: 70,
          }}
        />
      )}
      {showName && (
        <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: 2 }}>
          {operator.name}
        </div>
      )}
    </>
  )

  return (
    <div style={{ flexShrink: 0, borderTop: `1px solid ${color.borderDefault}`, padding: '12px 20px', textAlign: 'center' }}>
      {showCredit && (operator.url
        ? (
          <a href={operator.url} target="_blank" rel="noreferrer" style={{ display: 'block', textDecoration: 'none' }}>
            {credit}
          </a>
        )
        : <div>{credit}</div>
      )}
      <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: hasVisibleCredit ? 10 : 0, textAlign: 'left' }}>
        {sourceUrl
          ? <>Source: <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>{PRODUCT_NAME}</a></>
          : PRODUCT_NAME}
        {' ('}
        <HoverTooltip text={LICENSE_NOTE} maxWidth={280} placement="top-start">
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" aria-describedby={LICENSE_NOTE_ID} style={{ color: color.textMuted }}>{LICENSE_NAME}</a>
        </HoverTooltip>
        {')'}
        <span id={LICENSE_NOTE_ID} style={SR_ONLY}>{LICENSE_NOTE}</span>
      </div>
      {/* One credit per provider the instance's states come from (GET /config
          attribution), all on one "Data:" line, each as the provider declares it.
          LegiScan carries its CC BY license, which is linked; a legislature that
          publishes none is credited by name alone. */}
      <DataCredits credits={dataCredits} />
      {/* A legal doc is a reference, not a destination: opening it alongside keeps
          whatever page the footer sits on — a half-filled form, a bill mid-scroll. */}
      {(showTerms || showPrivacy) && (
        <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: 4, textAlign: 'left' }}>
          {showTerms && <Link to="/terms" target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>Terms</Link>}
          {showTerms && showPrivacy && ' · '}
          {showPrivacy && <Link to="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>Privacy</Link>}
        </div>
      )}
    </div>
  )
}

/**
 * The data credits on one line: "Data: LegiScan (CC BY 4.0), DC Council LIMS", wrapping as needed.
 * A credit with a license links the license after the name, and the license's note, when it has one,
 * explains it on hover and for screen readers. A credit with no license is its name link alone.
 */
function DataCredits({ credits }: { credits: ProviderCredit[] }) {
  return (
    <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: 4, textAlign: 'left' }}>
      Data:{' '}
      {credits.map((credit, i) => (
        <span key={credit.id}>
          {i > 0 && ', '}
          <DataCredit id={credit.id} credit={credit} />
        </span>
      ))}
    </div>
  )
}

function DataCredit({ id, credit }: { id: string; credit: DataAttribution }) {
  const noteId = dataNoteId(id)
  const nameLink = <a href={credit.url} target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>{credit.name}</a>
  if (!credit.license) return nameLink
  const note = credit.note
  const licenseLink = (
    <a href={credit.license.url} target="_blank" rel="noopener noreferrer" aria-describedby={note ? noteId : undefined} style={{ color: color.textMuted }}>{credit.license.name}</a>
  )
  return (
    <>
      {nameLink}
      {' ('}
      {note ? <HoverTooltip text={note} maxWidth={280} placement="top-start">{licenseLink}</HoverTooltip> : licenseLink}
      {')'}
      {note && <span id={noteId} style={SR_ONLY}>{note}</span>}
    </>
  )
}
