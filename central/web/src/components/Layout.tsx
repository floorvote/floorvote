import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/sync', label: 'Sync' },
  { to: '/adoption', label: 'Adoption' },
  { to: '/tenants', label: 'Tenants' },
  { to: '/settings', label: 'Settings' },
  { to: '/budget', label: 'Budget' },
  { to: '/ops-health', label: 'Ops health' },
  { to: '/unknown-logins', label: 'Unknown logins' },
]

export default function Layout() {
  const { identity, logout } = useAuth()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: '100vh' }}>
      <aside style={{
        background: 'white',
        borderRight: '1px solid var(--border)',
        padding: '20px 12px',
        position: 'sticky',
        top: 0,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{ fontWeight: 800, fontSize: 16, padding: '0 12px 16px', color: 'var(--accent)' }}>
          Central Admin
        </div>
        <nav style={{ flex: 1, overflowY: 'auto' }}>
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              style={({ isActive }) => ({
                display: 'block',
                padding: '8px 12px',
                borderRadius: 6,
                fontSize: 14,
                color: isActive ? 'white' : 'var(--fg)',
                background: isActive ? 'var(--accent)' : 'transparent',
                marginBottom: 2,
              })}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ fontSize: 12, color: 'var(--muted)', paddingTop: 12 }}>
          <div>{identity?.email}</div>
          <button onClick={logout} style={{ marginTop: 6, background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0 }}>
            Sign out
          </button>
        </div>
      </aside>
      <main style={{ padding: 24 }}>
        <Outlet />
      </main>
    </div>
  )
}
