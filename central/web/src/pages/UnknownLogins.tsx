import { useEffect, useState } from 'react'
import { api } from '../lib/api'

type Attempt = {
  tenantId: string
  tenantName: string
  email: string
  ipCountry: string | null
  userAgent: string | null
  createdAt: string
}

export default function UnknownLogins() {
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<{ attempts: Attempt[] }>('/admin/dash/unknown-logins')
      .then(d => setAttempts(d.attempts))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 16 }}>Unknown login attempts</h1>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 20 }}>
        Login attempts from email addresses not registered on any tenant. Pulled from each tenant via RPC.
      </p>
      {loading ? (
        <div style={{ color: 'var(--muted)' }}>Loading…</div>
      ) : attempts.length === 0 ? (
        <div style={{ color: 'var(--muted)' }}>No unknown login attempts recorded.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px', color: 'var(--muted)', fontWeight: 600 }}>Tenant</th>
              <th style={{ padding: '8px 12px', color: 'var(--muted)', fontWeight: 600 }}>Email</th>
              <th style={{ padding: '8px 12px', color: 'var(--muted)', fontWeight: 600 }}>Country</th>
              <th style={{ padding: '8px 12px', color: 'var(--muted)', fontWeight: 600 }}>Time</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a, i) => (
              <tr key={`${a.tenantId}-${a.email}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 12px' }}>{a.tenantName}</td>
                <td style={{ padding: '8px 12px' }}>{a.email}</td>
                <td style={{ padding: '8px 12px', color: 'var(--muted)' }}>{a.ipCountry ?? '—'}</td>
                <td style={{ padding: '8px 12px', color: 'var(--muted)' }}>{new Date(a.createdAt + 'Z').toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
