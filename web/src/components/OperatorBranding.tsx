import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PRODUCT_NAME, SOURCE_URL } from '../../../shared/brand'
import { hasTerms, hasPrivacy } from '../lib/legalDocs'
import { useConfig, type OperatorConfig } from '../context/ConfigContext'
import { InfoTooltip } from './InfoTooltip'
import { color, fontSize } from '../styles/tokens'

// Conventional, generic asset path (not operator-specific). A deployer drops their
// logo at web/public/operator-logo.svg; if the file is absent the <img> errors and
// is hidden (see logoState) — no broken-image icon.
const OPERATOR_LOGO_SRC = '/operator-logo.svg'
const EMPTY_OPERATOR: OperatorConfig = { name: '', url: '', contactEmails: [] }

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
 *   url set    → "Source: <product> (AGPLv3) ⓘ", product name links to it
 *   url empty  → "<product> (AGPLv3) ⓘ", no link and no "Source:" promise
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

  // Describe the user's right, not the operator's compliance: the product cannot
  // verify that the URL resolves or that it holds the running version, so it must
  // not assert on the operator's behalf that the obligation has been met. Naming
  // a contact gives the user somewhere to go when it has not been — including the
  // suppressed case, which is closer to §13's written-offer route than silence.
  //
  // The contact is the operator's email rather than the in-app feedback button:
  // POST /feedback requires auth and the button is hidden entirely in demo mode,
  // and a demo visitor is exactly the kind of user who asks for source.
  const contact = operator.contactEmails[0]
  const licenseNote = (
    <>
      This service runs {PRODUCT_NAME}, free software licensed under the AGPLv3.
      That license entitles you to the source code of the version running here.
      {contact && ` To request it, write to ${contact}.`}
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
      {/* Flex row, not an inline ⓘ: the icon's font is larger than this line's xs
          text, so inline it sits off the baseline. Text stays one wrappable span
          so a narrow sidebar breaks the label, not the label from its icon. */}
      <div style={{
        fontSize: fontSize.xs, color: color.textMuted, marginTop: hasVisibleCredit ? 10 : 0,
        textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
      }}>
        <span>
          {sourceUrl
            ? <>Source: <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>{PRODUCT_NAME}</a></>
            : PRODUCT_NAME}
          {' (AGPLv3)'}
        </span>
        <InfoTooltip text={licenseNote} maxWidth={280} align="left" label="About the license" />
      </div>
      <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: 4, textAlign: 'left' }}>
        Data: <a href="https://legiscan.com" target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>LegiScan</a>
        {' ('}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>CC BY 4.0</a>
        {')'}
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
