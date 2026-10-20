// The files on a posted comment (#465): a row each, with a type tile, the name,
// the type and size, and Download.
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import { attachmentKind, attachmentUrl, formatFileSize, type AttachmentSummary } from '../lib/attachments'
import { AttachmentTile } from './ComposerAttachments'

export function CommentAttachments({ attachments }: { attachments?: AttachmentSummary[] }) {
  if (!attachments || attachments.length === 0) return null
  return (
    <ul aria-label="Attachments" style={{ listStyle: 'none', margin: '0 0 8px', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {attachments.map(a => (
        <li key={a.id} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
          border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, background: color.white,
        }}>
          <AttachmentTile contentType={a.contentType} name={a.name} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: 'block', fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: color.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
            <span style={{ display: 'block', fontSize: fontSize.sm, color: color.textMuted }}>{attachmentKind(a.contentType, a.name).label} · {formatFileSize(a.size)}</span>
          </span>
          {/* `download` makes every type save to disk, including a PDF the server
              would let open in the tab: the server's sandbox CSP may stop a browser's
              own PDF viewer, so Download never depends on it (see the #465 notes). */}
          <a
            href={attachmentUrl(a.id)}
            download={a.name}
            aria-label={`Download ${a.name}`}
            style={{ flex: 'none', fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: color.linkBlue, textDecoration: 'none' }}
          >Download</a>
        </li>
      ))}
    </ul>
  )
}
