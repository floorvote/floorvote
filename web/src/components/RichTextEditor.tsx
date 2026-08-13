import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, EditorContext, ReactRenderer, useEditor } from '@tiptap/react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { StarterKit } from '@tiptap/starter-kit'
import { Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extension-placeholder'
import { Mention } from '@tiptap/extension-mention'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import { MentionSuggestions, type MentionSuggestionsRef } from './MentionSuggestions'
import { apiFetch } from '../lib/api'
import { isMac } from '../lib/tiptap-utils'
import { TOOLTIP_STYLE, ROLE_CHIP, tooltipPositionBelow, displayName, sortRoles } from '../lib/chipStyles'
import { MENTION_STYLE } from '../../../shared/mentionStyle'
import { useUnsavedRegistration } from '../lib/unsavedText'
import { useAuth } from '../hooks/useAuth'

import { Toolbar, ToolbarGroup, ToolbarSeparator } from '@/components/tiptap-ui-primitive/toolbar'
import { MarkButton } from '@/components/tiptap-ui/mark-button'
import { ListDropdownMenu } from '@/components/tiptap-ui/list-dropdown-menu'
import { BlockquoteButton } from '@/components/tiptap-ui/blockquote-button'
import { LinkPopover } from '@/components/tiptap-ui/link-popover'
import { UndoRedoButton } from '@/components/tiptap-ui/undo-redo-button'

import '@/styles/_variables.scss'
import '@/styles/_keyframe-animations.scss'
import '@/components/tiptap-node/blockquote-node/blockquote-node.scss'
import '@/components/tiptap-node/list-node/list-node.scss'

// Strips leading/trailing empty paragraphs (<p></p>, <p><br></p>, whitespace-only)
// from TipTap HTML output before saving.
function trimEdgeParagraphs(html: string): string {
  return html
    .replace(/^(\s*<p>\s*(<br[^>]*>)?\s*<\/p>\s*)+/, '')
    .replace(/(\s*<p>\s*(<br[^>]*>)?\s*<\/p>\s*)+$/, '')
    .trim()
}

// Defined at module level so it isn't recreated on every render.
// Intercepts Tab when the mention suggestion popup is NOT showing (popup handles Tab first).
// In a list: indents the list item. Otherwise: inserts two spaces.
const TabHandler = Extension.create({
  name: 'tabHandler',
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.commands.sinkListItem('listItem')) return true
        return this.editor.commands.insertContent('  ')
      },
    }
  },
})

interface UserData {
  id: string
  name: string
  email: string
  subtitle: string | null
  roles?: { id: string; name: string }[]
}

interface RoleData {
  id: string
  name: string
  members: Array<{ id: string; name: string; subtitle: string | null }>
}

function useMentionData(enabled: boolean) {
  const [users, setUsers] = useState<UserData[]>([])
  const [roles, setRoles] = useState<RoleData[]>([])

  useEffect(() => {
    if (!enabled) return
    apiFetch<UserData[]>('/users').then(setUsers).catch(() => {})
    apiFetch<RoleData[]>('/roles').then(setRoles).catch(() => {})
  }, [enabled])

  return { users, roles }
}

interface RichTextEditorProps {
  onSubmit?: (html: string) => void
  onChange?: (html: string) => void
  placeholder?: string
  initialContent?: string
  submitLabel?: string
  onCancel?: () => void
  autoFocus?: boolean
  enableMentions?: boolean
  allowEmpty?: boolean
  disabled?: boolean
}

interface MentionTooltipData {
  anchorRect: DOMRect
  type: 'user' | 'role'
  userName?: string
  userSubtitle?: string | null
  userRoles?: { id: string; name: string }[]
  roleMembers?: Array<{ name: string; subtitle: string | null }>
}

export function RichTextEditor({ onSubmit, onChange, placeholder = 'Add a comment…', initialContent, submitLabel = 'Post', onCancel, autoFocus, enableMentions = true, allowEmpty = false, disabled = false }: RichTextEditorProps) {
  const [hasContent, setHasContent] = useState(false)
  const initialTextRef = useRef('')
  const [editorTooltip, setEditorTooltip] = useState<MentionTooltipData | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { users, roles } = useMentionData(enableMentions)
  const usersRef = useRef(users)
  const rolesRef = useRef(roles)
  usersRef.current = users
  rolesRef.current = roles

  const { user } = useAuth()
  const canMentionEveryone = user?.role === 'admin' || user?.role === 'owner'
  const currentUserId = user?.id
  const canMentionEveryoneRef = useRef(canMentionEveryone)
  const currentUserIdRef = useRef(currentUserId)
  canMentionEveryoneRef.current = canMentionEveryone
  currentUserIdRef.current = currentUserId

  const editor = useEditor({
    immediatelyRender: true,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          enableClickSelection: true,
        },
      }),
      Placeholder.configure({ placeholder }),
      TabHandler,
      ...(enableMentions ? [Mention.configure({
        HTMLAttributes: { class: 'mention' },
        renderHTML({ node }) {
          return [
            'span',
            {
              class: 'mention',
              'data-type': 'mention',
              'data-id': node.attrs.id,
              'data-label': node.attrs.label ?? node.attrs.id,
            },
            `@${node.attrs.label ?? node.attrs.id}`,
          ]
        },
        suggestion: {
          items: ({ query }: { query: string }) => {
            const q = query.toLowerCase()
            const filteredUsers = usersRef.current
              .filter(u => displayName(u).toLowerCase().includes(q) || (u.subtitle && u.subtitle.toLowerCase().includes(q)))
            const matchedUsers = filteredUsers
              .slice(0, 4)
              .map(u => ({ ...u, type: 'user' as const }))
            if (filteredUsers.length > 4) matchedUsers.push({ id: '__more_users__', name: '', email: '', subtitle: `${filteredUsers.length - 4} more`, type: 'user' as const })
            const filteredRoles = rolesRef.current
              .filter(r => r.name.toLowerCase().includes(q))
            const matchedRoles = filteredRoles
              .slice(0, 3)
              .map(r => ({ id: r.id, name: r.name, memberCount: r.members.length, type: 'role' as const }))
            if (filteredRoles.length > 3) matchedRoles.push({ id: '__more_roles__', name: `${filteredRoles.length - 3} more`, memberCount: 0, type: 'role' as const })
            const everyoneItems =
              canMentionEveryoneRef.current && 'everyone'.includes(q)
                ? [{
                    id: 'all' as const,
                    memberCount: usersRef.current.filter(u => u.id !== currentUserIdRef.current).length,
                    type: 'everyone' as const,
                  }]
                : []
            return [...everyoneItems, ...matchedUsers, ...matchedRoles]
          },
          render: () => {
            let component: ReactRenderer<MentionSuggestionsRef> | null = null
            let popup: TippyInstance[] | null = null

            return {
              onStart: (props: any) => {
                component = new ReactRenderer(MentionSuggestions, {
                  props,
                  editor: props.editor,
                })
                if (!props.clientRect) return
                popup = tippy('body', {
                  getReferenceClientRect: props.clientRect,
                  appendTo: () => document.body,
                  content: component.element,
                  showOnCreate: true,
                  interactive: true,
                  trigger: 'manual',
                  placement: 'bottom-start',
                })
              },
              onUpdate: (props: any) => {
                component?.updateProps(props)
                if (popup && props.clientRect) {
                  popup[0].setProps({ getReferenceClientRect: props.clientRect })
                }
              },
              onKeyDown: (props: any) => {
                if (props.event.key === 'Escape') {
                  popup?.[0]?.hide()
                  return true
                }
                return component?.ref?.onKeyDown(props) ?? false
              },
              onExit: () => {
                popup?.[0]?.destroy()
                component?.destroy()
              },
            }
          },
        },
      })] : []),
    ],
    content: initialContent || '',
    editable: !disabled,
    autofocus: autoFocus ? 'end' : false,
    onUpdate: ({ editor: e }) => {
      setHasContent(!!e.getText().trim())
      onChange?.(e.getHTML())
    },
    onCreate: ({ editor: e }) => {
      setHasContent(!!e.getText().trim())
    },
    editorProps: {
      attributes: {
        class: 'comment-editor',
      },
    },
  })

  // Capture the dirty baseline from the editor once it exists, using the same
  // getText() the dirty check uses (block-joined with "\n\n"), so multi-paragraph
  // initial content isn't falsely flagged as unsaved. An effect (not onCreate) so
  // it fires reliably across environments.
  useEffect(() => {
    if (editor) initialTextRef.current = editor.getText().trim()
  }, [editor])

  // `editable` above only applies to the initial useEditor() call — later
  // disabled changes (e.g. demoLocked flipping) need this to keep the editor
  // and the read-only surface in sync.
  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  useUnsavedRegistration({
    isDirty: () => !!editor && editor.getText().trim() !== initialTextRef.current,
    reset: () => {
      if (onCancel) { onCancel(); return }
      editor?.commands.clearContent()
      setHasContent(false)
    },
  })

  const handleSubmit = useCallback(() => {
    if (!editor || !onSubmit || disabled) return
    const text = editor.getText().trim()
    if (!text && !allowEmpty) return
    onSubmit(trimEdgeParagraphs(editor.getHTML()))
    editor.commands.clearContent()
    setHasContent(false)
  }, [editor, onSubmit, allowEmpty, disabled])

  function handleEditorMouseOver(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    if (!target.dataset.type || target.dataset.type !== 'mention') return
    const dataId = target.dataset.id || ''
    const [type, id] = dataId.split(':')
    const anchorRect = target.getBoundingClientRect()

    if (type === 'role') {
      const role = rolesRef.current.find(r => r.id === id)
      const roleMembers = role && role.members.length > 0
        ? role.members.map(m => ({ name: displayName(m) || m.id, subtitle: m.subtitle }))
        : []
      setEditorTooltip({ anchorRect, type: 'role', roleMembers })
    } else {
      const user = usersRef.current.find(u => u.id === id)
      if (user) {
        setEditorTooltip({ anchorRect, type: 'user', userName: displayName(user), userSubtitle: user.subtitle, userRoles: user.roles ?? [] })
      } else {
        setEditorTooltip({ anchorRect, type: 'user', userName: target.dataset.label || id, userSubtitle: null, userRoles: [] })
      }
    }
  }

  function handleEditorMouseOut(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    if (target.dataset.type === 'mention') setEditorTooltip(null)
  }

  if (!editor) return null

  return (
    <div
      ref={wrapperRef}
      className="comment-editor-wrapper"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          handleSubmit()
        }
      }}
      onMouseOver={handleEditorMouseOver}
      onMouseOut={handleEditorMouseOut}
    >
      <EditorContext.Provider value={{ editor }}>
        <Toolbar>
          <ToolbarGroup>
            <MarkButton type="bold" />
            <MarkButton type="italic" />
            <MarkButton type="strike" />
          </ToolbarGroup>

          <ToolbarSeparator />

          <ToolbarGroup>
            <ListDropdownMenu modal={false} types={['bulletList', 'orderedList']} />
            <BlockquoteButton />
          </ToolbarGroup>

          <ToolbarSeparator />

          <ToolbarGroup>
            <LinkPopover />
          </ToolbarGroup>

          <ToolbarSeparator />

          <ToolbarGroup>
            <UndoRedoButton action="undo" />
            <UndoRedoButton action="redo" />
          </ToolbarGroup>
        </Toolbar>

        <EditorContent editor={editor} role="presentation" />
      </EditorContext.Provider>

      {onSubmit && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '6px 10px',
          borderTop: `1px solid ${color.surfaceMuted}`,
        }}>
          <span style={{ fontSize: fontSize.sm, color: color.textMuted, marginRight: 'auto' }}>
            {enableMentions && 'Type @ to mention · '}{isMac() ? '⌘↵' : 'Ctrl+Enter'} to {submitLabel.toLowerCase()}
          </span>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              style={{
                fontSize: fontSize.sm,
                padding: '6px 14px',
                background: 'transparent',
                color: color.textSecondary,
                border: `1px solid ${color.borderDefault}`,
                borderRadius: radius.md,
                cursor: 'pointer',
                fontWeight: fontWeight.medium,
              }}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={(!hasContent && !allowEmpty) || disabled}
            style={{
              fontSize: fontSize.sm,
              padding: '6px 18px',
              background: color.linkBlue,
              color: color.white,
              border: 'none',
              borderRadius: radius.md,
              cursor: ((hasContent || allowEmpty) && !disabled) ? 'pointer' : 'not-allowed',
              opacity: ((hasContent || allowEmpty) && !disabled) ? 1 : 0.5,
              fontWeight: fontWeight.medium,
            }}
          >
            {submitLabel}
          </button>
        </div>
      )}

      {editorTooltip && (() => {
        const containerRect = wrapperRef.current?.getBoundingClientRect()
        if (!containerRect) return null
        return createPortal(
          <div style={{
            ...TOOLTIP_STYLE,
            ...tooltipPositionBelow(editorTooltip.anchorRect, containerRect),
            whiteSpace: 'normal',
            maxWidth: Math.min(360, containerRect.right - containerRect.left),
            padding: '6px 12px',
          }}>
            {editorTooltip.type === 'user' ? (
              <>
                <div style={{ whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: fontWeight.semibold, color: color.tooltipBg }}>{editorTooltip.userName}</span>
                  {editorTooltip.userSubtitle && (
                    <span style={{ color: color.textMuted, marginLeft: 4 }}>{editorTooltip.userSubtitle}</span>
                  )}
                </div>
                {editorTooltip.userRoles && editorTooltip.userRoles.length > 0 && (
                  <>
                    <div style={{ fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginTop: 6, marginBottom: 4 }}>Roles</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {sortRoles(editorTooltip.userRoles).map(r => (
                        <span key={r.id} style={ROLE_CHIP}>{r.name}</span>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {editorTooltip.roleMembers && editorTooltip.roleMembers.length > 0 ? (
                  <>
                    <div style={{ fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginBottom: 4 }}>Members with this role</div>
                    {editorTooltip.roleMembers.map((m, i) => (
                      <div key={i}>
                        <span style={{ fontWeight: fontWeight.semibold, color: color.tooltipBg }}>{m.name}</span>
                        {m.subtitle && (
                          <span style={{ color: color.textMuted, marginLeft: 4 }}>{m.subtitle}</span>
                        )}
                      </div>
                    ))}
                  </>
                ) : (
                  <div style={{ color: color.textMuted, fontStyle: 'italic' }}>No members with this role</div>
                )}
              </>
            )}
          </div>,
          document.body,
        )
      })()}

      <style>{`
        .comment-editor-wrapper {
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          background: #fff;
          overflow: hidden;
        }
        /* The shared "fixed"-variant Toolbar switches to position:absolute at
           <=480px so it can pin above the keyboard in the standalone full-screen
           editor. Our inline comment composer reuses that Toolbar, where that rule
           pops the toolbar out of flow (breaking the editor layout and pushing page
           width). Keep it in-flow here: a sticky, horizontally-scrollable row. */
        @media (max-width: 480px) {
          .comment-editor-wrapper .tiptap-toolbar[data-variant="fixed"] {
            position: sticky;
            top: 0;
            height: auto;
            border-top: none;
            border-bottom: 1px solid var(--tt-toolbar-border-color);
            padding: 0 0.5rem;
          }
        }
        .comment-editor-wrapper .tiptap.ProseMirror {
          outline: none;
          min-height: 48px;
          padding: 10px;
          font-size: 13px;
          line-height: 1.5;
          font-family: inherit;
        }
        .comment-editor-wrapper .tiptap.ProseMirror p {
          margin: 0 0 2px;
          font-size: inherit;
          line-height: inherit;
        }
        .comment-editor-wrapper .tiptap.ProseMirror p:not(:first-child) {
          margin-top: 6px;
        }
        .comment-editor-wrapper .tiptap.ProseMirror ul,
        .comment-editor-wrapper .tiptap.ProseMirror ol {
          margin: 4px 0;
          padding-left: 20px;
        }
        .comment-editor-wrapper .tiptap.ProseMirror blockquote {
          border-left: 3px solid #e2e8f0;
          margin: 4px 0;
          padding-left: 12px;
          color: #64748b;
        }
        .comment-editor-wrapper .tiptap.ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: #94a3b8;
          pointer-events: none;
          height: 0;
        }
        .comment-editor-wrapper .tiptap.ProseMirror .mention {
          font-weight: ${MENTION_STYLE.weight};
        }
        /* Mention pills come from the shared MENTION_STYLE (role = indigo,
           user = gray) — in lockstep with CommentContent.tsx, ROLE_CHIP, and
           the emails. */
        .comment-editor-wrapper .tiptap.ProseMirror .mention[data-id^="role:"],
        .comment-editor-wrapper .tiptap.ProseMirror .mention[data-id^="everyone:"] {
          background: ${MENTION_STYLE.role.bg};
          color: ${MENTION_STYLE.role.text};
          border-radius: 99px;
          padding: 2px 8px;
        }
        .comment-editor-wrapper .tiptap.ProseMirror .mention[data-id^="user:"] {
          background: ${MENTION_STYLE.user.bg};
          color: ${MENTION_STYLE.user.text};
          border-radius: 4px;
          padding: 1px 6px;
        }
      `}</style>
    </div>
  )
}
