import { Link } from 'react-router-dom'
import { Wordmark } from '../components/Wordmark'
import { renderLegalMarkdown } from '../lib/legalMarkdown'
import { usePageTitle } from '../hooks/usePageTitle'
import { PRODUCT_NAME } from '../../../shared/brand'
import { color, fontSize, radius, shadow } from '../styles/tokens'

interface Props {
  /** Page + document title, e.g. "Terms of Use". */
  title: string
  /** Raw markdown for the document. */
  content: string
}

/**
 * Standalone legal document page: no sidebar, no app shell, no auth. Rendered by
 * the public /terms and /privacy routes with content supplied by the route.
 */
export function LegalPage({ title, content }: Props) {
  usePageTitle(title)
  const html = renderLegalMarkdown(content)
  return (
    <div style={{ minHeight: '100vh', background: color.bgLoginPage, padding: '40px 20px' }}>
      <div style={{
        maxWidth: 760, margin: '0 auto', background: color.white,
        border: `1px solid ${color.borderDefault}`, borderRadius: radius.xl,
        boxShadow: shadow.sm, padding: '40px 48px',
      }}>
        <div style={{ marginBottom: 24 }}>
          <Link to="/" style={{ textDecoration: 'none' }}><Wordmark /></Link>
        </div>
        <div
          style={{ fontSize: fontSize.base, color: color.textSlate, lineHeight: 1.6 }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div style={{ marginTop: 32, paddingTop: 20, borderTop: `1px solid ${color.borderDefault}` }}>
          <Link to="/" style={{ fontSize: fontSize.sm, color: color.textMuted }}>← Back to {PRODUCT_NAME}</Link>
        </div>
      </div>
    </div>
  )
}
