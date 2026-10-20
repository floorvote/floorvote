// Comment attachment storage against the instance quota (#465), for the
// admin's Settings page. Shows nothing while attachments are off, which is
// also what a failed read looks like: there is nothing for an admin to act on.
import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { formatFileSize } from '../../lib/attachments'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE } from '../../lib/textStyles'
import { color, fontSize, radius } from '../../styles/tokens'

type Usage = { enabled: boolean; usedBytes: number; quotaBytes: number }

export function AttachmentStorage() {
  const [usage, setUsage] = useState<Usage | null>(null)
  useEffect(() => {
    let live = true
    apiFetch<Usage>('/attachments/usage')
      .then(u => { if (live && u?.enabled) setUsage(u) })
      .catch(() => {})
    return () => { live = false }
  }, [])
  if (!usage) return null

  const share = usage.quotaBytes > 0 ? Math.min(1, usage.usedBytes / usage.quotaBytes) : 0
  const percent = Math.round(share * 100)
  const full = usage.usedBytes >= usage.quotaBytes
  const near = !full && share >= 0.9
  return (
    <div style={{ ...CARD, padding: 24, marginBottom: 20 }}>
      <h2 style={CARD_TITLE}>File attachments</h2>
      <div style={{ fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.6, marginBottom: 14 }}>
        Members can attach files to comments. Files on deleted comments stop counting 30 days after the comment is deleted.
      </div>
      <div style={{ fontSize: fontSize.sm, color: color.textPrimary, marginBottom: 6 }}>
        {formatFileSize(usage.usedBytes)} of {formatFileSize(usage.quotaBytes)} used
      </div>
      <div
        role="progressbar"
        aria-label="Attachment storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{ height: 8, borderRadius: radius.md, background: color.surfaceMuted, overflow: 'hidden' }}
      >
        <div style={{ width: `${percent}%`, height: '100%', background: full || near ? color.textDanger : color.linkBlue }} />
      </div>
      {(full || near) && (
        <div style={{ fontSize: fontSize.sm, color: color.textDanger, marginTop: 8 }}>
          {full ? 'Storage is full: new uploads are refused until files are removed.' : 'Storage is nearly full.'}
        </div>
      )}
    </div>
  )
}
