import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PRODUCT_NAME, SOURCE_URL, LICENSE_NAME, LICENSE_URL } from '../../../shared/brand'
import { hasTerms, hasPrivacy } from '../lib/legalDocs'
import { useConfig, type OperatorConfig } from '../context/ConfigContext'
import { HoverTooltip } from './HoverTooltip'
import { SR_ONLY } from '../lib/textStyles'
import { color, fontSize } from '../styles/tokens'

// Conventional, generic asset path (not operator-specific). A deployer drops their
// logo at web/public/operator-logo.svg; if the file is absent the <img> errors and
// is hidden (see logoState) — no broken-image icon.
const OPERATOR_LOGO_SRC = '/operator-logo.svg'
const EMPTY_OPERATOR: OperatorConfig = { name: '', url: '', contactEmails: [] }

// One plain sentence per license, hardcoded. Both state a fact about the work and
// the data it serves, identical for every deployment, so neither is operator
// config. They exist because "AGPLv3" and "CC BY 4.0" mean nothing to most
// readers: a link to the license text explains the terms to a lawyer, not the
// entitlement to a member. Deliberately not an ⓘ with contacts and actions —
// telling someone the right exists is the whole job.
const LICENSE_NOTE = `${PRODUCT_NAME} is free software licensed under the ${LICENSE_NAME}, which means that users are entitled to the source code of the version they are being served.`
const DATA_NOTE = 'Legislative data comes from LegiScan under the Creative Commons Attribution 4.0 license, which allows anyone to reuse it with credit.'

// The hover bubble in HoverTooltip's default archetype is aria-hidden — the
// child's own name carries the accessible name — so on its own the sentence
// would reach sighted users only. These ids tie an SR_ONLY copy to each link
// via aria-describedby, so a screen reader announces the same explanation.
const LICENSE_NOTE_ID = 'footer-license-note'
const DATA_NOTE_ID = 'footer-data-note'

/**
 * Pinned sidebar footer: the operator credit (logo + name, optionally linked) and
 * the data-provider attribution. Operator identity comes from GET /config via
 * ConfigContext; `operator` is an optional prop only so tests can drive it.
 *
 * Graceful absence: the logo renders hidden and is revealed only on a successful
 * onLoad; onError leaves it hidden. When there is no name and the logo did not
 * load, the credit block collapses — only the LegiScan / CC BY attribution remains
 * (that line is a data-provider license credit and always renders).
 *
 * The footer shows three muted lines below the operator credit: the license
 * line, the "Data: LegiScan (CC BY 4.0)" credit, and a "Terms · Privacy" line
 * gated on `showTerms`/`showPrivacy` (defaulting to whether the docs were
 * bundled). `sourceUrl`/`showTerms`/`showPrivacy` are optional props only so
 * tests can drive them.
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
  showTerms = hasTerms,
  showPrivacy = hasPrivacy,
}: {
  operator?: OperatorConfig
  sourceUrl?: string
  showTerms?: boolean
  showPrivacy?: boolean
} = {}) {
  const { config } = useConfig()
  const operator = propOperator ?? config?.operator ?? EMPTY_OPERATOR
  const sourceUrl = propSourceUrl ?? operator.sourceUrl ?? SOURCE_URL
  const [logoState, setLogoState] = useState<'pending' | 'loaded' | 'failed'>('pending')

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
          src={OPERATOR_LOGO_SRC}
          onLoad={() => setLogoState('loaded')}
          onError={() => setLogoState('failed')}
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
      <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: 4, textAlign: 'left' }}>
        Data: <a href="https://legiscan.com" target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>LegiScan</a>
        {' ('}
        <HoverTooltip text={DATA_NOTE} maxWidth={280} placement="top-start">
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer" aria-describedby={DATA_NOTE_ID} style={{ color: color.textMuted }}>CC BY 4.0</a>
        </HoverTooltip>
        {')'}
        <span id={DATA_NOTE_ID} style={SR_ONLY}>{DATA_NOTE}</span>
      </div>
      {(showTerms || showPrivacy) && (
        <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: 4, textAlign: 'left' }}>
          {showTerms && <Link to="/terms" style={{ color: color.textMuted }}>Terms</Link>}
          {showTerms && showPrivacy && ' · '}
          {showPrivacy && <Link to="/privacy" style={{ color: color.textMuted }}>Privacy</Link>}
        </div>
      )}
    </div>
  )
}
