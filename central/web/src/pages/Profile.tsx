import { useEffect, useState } from 'react'
import { api } from '../lib/api'

type ProfileData = { email: string; name: string; title: string }

const inputStyle = {
  width: '100%', maxWidth: 420, padding: '6px 10px', fontSize: 14, borderRadius: 6,
  border: '1px solid var(--border)', boxSizing: 'border-box' as const,
}

export default function Profile() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api<ProfileData>('/admin/dash/profile')
      .then(p => { setEmail(p.email); setName(p.name); setTitle(p.title) })
      .catch(e => setErr(e?.message ?? 'Could not load your profile'))
      .finally(() => setLoaded(true))
  }, [])

  async function save() {
    setSaving(true); setSaved(false); setErr(null)
    try {
      const p = await api<ProfileData>('/admin/dash/profile', { method: 'PUT', body: JSON.stringify({ name, title }) })
      setName(p.name); setTitle(p.title); setSaved(true)
    } catch (e: any) {
      setErr(e?.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <div style={{ color: 'var(--muted)' }}>Loading…</div>

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 16 }}>Your Profile</h1>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 20, maxWidth: 560 }}>
        Your name and title are kept here once. Each time you sign in to an organization's instance, it
        updates its copy, so you appear the same way everywhere. The title also marks you as operator
        staff, for example "Operator support".
      </p>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, padding: 16, maxWidth: 560 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Email</div>
        <div style={{ fontSize: 14, marginBottom: 12 }}>{email}</div>
        <label htmlFor="profile-name" style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>Name</label>
        <input id="profile-name" style={{ ...inputStyle, marginBottom: 12 }} value={name} maxLength={100}
          onChange={e => { setName(e.target.value); setSaved(false) }} />
        <label htmlFor="profile-title" style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>Title</label>
        <input id="profile-title" style={inputStyle} value={title} maxLength={200} placeholder="Operator support"
          onChange={e => { setTitle(e.target.value); setSaved(false) }} />
        {err && <div style={{ marginTop: 10, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
        {saved && <div style={{ marginTop: 10, fontSize: 13 }}>Profile saved.</div>}
        <div style={{ marginTop: 14 }}>
          <button type="button" onClick={save} disabled={saving}
            style={{ padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
              border: 'none', background: 'var(--accent)', color: 'white', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
