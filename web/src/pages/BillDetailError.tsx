import { useRouteError, isRouteErrorResponse, Link } from 'react-router-dom'
import { color, fontSize } from '../styles/tokens'

/**
 * errorElement for the bill-detail routes. Renders the 409 ambiguous-legacy-bill
 * guidance (thrown by billDetailLoader) or a generic load failure, instead of the
 * page crashing. Replaces the old in-component `setError` branch.
 */
export function BillDetailError() {
  const error = useRouteError()
  const message =
    isRouteErrorResponse(error) && error.status === 409
      ? 'This bill number exists in multiple states. Please use a state-prefixed URL (e.g. /RI/2026/HB0209).'
      : 'Failed to load bill.'
  return (
    <div style={{ padding: 32, color: color.textErrorRed }}>
      <div style={{ marginBottom: 12 }}>{message}</div>
      <Link to="/bills" style={{ fontSize: fontSize.sm, color: color.linkBlue, textDecoration: 'none' }}>← Back to bills</Link>
    </div>
  )
}
