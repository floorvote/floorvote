import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { SYNC_PRESETS, matchPreset } from '../lib/syncPresets'

type SessionRow = {
  sessionId: number
  state: string
  sessionName: string
  yearStart: number
  yearEnd: number
  billCount: number
  lastSyncedAt: string | null
  fullSyncHours: number[]
  fullSyncIsDefault: boolean
  rawSyncHours: number[]
  rawSyncIsDefault: boolean
  syncEnabled: boolean
  sineDie: boolean
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h2>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>{children}</div>
    </div>
  )
}

function HourGrid({ value, onChange }: { value: number[]; onChange: (hrs: number[]) => void }) {
  const set = new Set(value)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 4, maxWidth: 420 }}>
      {Array.from({ length: 24 }, (_, h) => {
        const on = set.has(h)
        return (
          <button
            key={h}
            type="button"
            onClick={() => {
              const next = new Set(set)
              if (on) next.delete(h); else next.add(h)
              onChange(Array.from(next).sort((a, b) => a - b))
            }}
            style={{
              padding: '4px 0', fontSize: 11, borderRadius: 4, cursor: 'pointer',
              border: '1px solid var(--border)',
              background: on ? 'var(--accent)' : 'white',
              color: on ? 'white' : 'var(--fg)',
            }}
          >{h}</button>
        )
      })}
    </div>
  )
}

function SessionEditor({ s, onSaved }: { s: SessionRow; onSaved: () => void }) {
  const [full, setFull] = useState<number[]>(s.fullSyncHours)
  const [raw, setRaw] = useState<number[]>(s.rawSyncHours)
  const [enabled, setEnabled] = useState<boolean>(s.syncEnabled)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const preset = matchPreset(full, raw)

  function applyPreset(id: string) {
    const p = SYNC_PRESETS.find(p => p.id === id)
    if (!p) return
    setFull(p.full); setRaw(p.raw)
  }

  async function save() {
    setSaving(true); setErr(null)
    try {
      await api(`/admin/dash/sync/session/${s.sessionId}`, {
        method: 'PUT',
        body: JSON.stringify({ fullSyncHoursEt: full, rawSyncHoursEt: raw, syncEnabled: enabled }),
      })
      onSaved()
    } catch (e: any) {
      setErr(e?.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 14 }}>{s.state} — <span>{s.sessionName}</span></strong>
        <label style={{ fontSize: 13, color: 'var(--muted)' }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> sync enabled
        </label>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>Preset</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {SYNC_PRESETS.map(p => (
          <button key={p.id} type="button" onClick={() => applyPreset(p.id)}
            style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
              border: '1px solid var(--border)', background: preset === p.id ? 'var(--accent)' : 'white',
              color: preset === p.id ? 'white' : 'var(--fg)' }}>{p.label}</button>
        ))}
        <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--muted)' }}>
          {preset === 'custom' ? '(custom)' : ''}
        </span>
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>Full sync hours (ET)</div>
      <div style={{ marginTop: 4 }}><HourGrid value={full} onChange={setFull} /></div>
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>Raw sync hours (ET)</div>
      <div style={{ marginTop: 4 }}><HourGrid value={raw} onChange={setRaw} /></div>
      {err && <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={save} disabled={saving}
          style={{ padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
            border: 'none', background: 'var(--accent)', color: 'white', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export default function Settings() {
  const [active, setActive] = useState<SessionRow[]>([])
  const [sineDie, setSineDie] = useState<SessionRow[]>([])

  function load() {
    api<{ active: SessionRow[]; sineDie: SessionRow[] }>('/admin/dash/sync/sessions').then(r => {
      setActive(r.active); setSineDie(r.sineDie)
    })
  }
  useEffect(() => { load() }, [])

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Settings</h1>
      <Section title="Sync schedules — active sessions">
        {active.length === 0 && <div style={{ padding: 16, color: 'var(--muted)' }}>No active sessions.</div>}
        {active.map(s => <SessionEditor key={s.sessionId} s={s} onSaved={load} />)}
      </Section>
      <Section title="Sine die sessions">
        {sineDie.length === 0 && <div style={{ padding: 16, color: 'var(--muted)' }}>None.</div>}
        {sineDie.map(s => (
          <div key={s.sessionId} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--muted)' }}>
            {s.state} — <span>{s.sessionName}</span> · concluded — not synced
          </div>
        ))}
      </Section>
    </div>
  )
}
