import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PRODUCT_NAME, SOURCE_URL } from '../../../shared/brand'
import { hasTerms, hasPrivacy } from '../lib/legalDocs'
import { useConfig, type OperatorConfig } from '../context/ConfigContext'
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
 * The footer shows up to three muted lines below the operator credit, each
 * independently conditional: a "Source: <product> (AGPLv3)" line gated on
 * `SOURCE_URL`, the always-on "Data: LegiScan (CC BY 4.0)" credit, and a
 * "Terms · Privacy" line gated on `showTerms`/`showPrivacy` (defaulting to
 * whether the docs were bundled). `sourceUrl`/`showTerms`/`showPrivacy` are
 * optional props only so tests can drive them.
 */
export function OperatorBranding({
  operator: propOperator,
  sourceUrl = SOURCE_URL,
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
      {sourceUrl && (
        <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: hasVisibleCredit ? 10 : 0, textAlign: 'left' }}>
          Source: <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>{PRODUCT_NAME}</a>
          {' ('}
          <a href={`${sourceUrl.replace(/\/$/, '')}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer" style={{ color: color.textMuted }}>AGPLv3</a>
          {')'}
        </div>
      )}
      <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginTop: sourceUrl ? 4 : (hasVisibleCredit ? 10 : 0), textAlign: 'left' }}>
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
