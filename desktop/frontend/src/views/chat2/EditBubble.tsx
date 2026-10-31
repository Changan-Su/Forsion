import { useLayoutEffect, useRef } from 'react'
import { GitBranch } from 'lucide-react'
import { useI18n } from '../../i18n'
import { firstChar } from './EditorialMessage'

/**
 * 编辑重发:那条提问原地变成可改的气泡(方案 docs/ToBeImproved/编辑重发分支与编辑框方案_2026-10-28 A)——
 * 「你」+ 头像 + 同一个气泡底色与圆角,宽度撑到提问最大宽;下面一行:提示「原来这一版会留成一支分支」、取消 / 发送。
 * Enter 换行,⌘↵ / Ctrl↵ 发送(输入法组字时不算),Esc 取消;内容没改或为空时「发送」置灰。
 */
export function EditBubble({ original, value, onChange, userName, userAvatar, onSend, onCancel }: {
  original: string
  value: string
  onChange: (text: string) => void
  userName?: string
  userAvatar?: string
  onSend: (text: string) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const text = value // 草稿放父级:切会话卸载再回来不丢
  const ta = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length) // 光标放到末尾
  }, [])
  const can = !!text.trim() && text.trim() !== original.trim()
  const send = (): void => { if (can) onSend(text.trim()) }
  const name = userName || t('chat.you')
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  return (
    <div className="t2-userwrap t2-userwrap--editing">
      <div className="t2-user-col t2-edit">
        <div className="t2-username">{name}</div>
        <div className="t2-user t2-edit-bubble">
          {/* ponytail: 高度随内容长靠 field-sizing(Chromium / 安卓 WebView 都有),不认的浏览器停在两行、内部滚 */}
          <textarea ref={ta} className="t2-edit-ta" rows={2} value={text}
            aria-label={t('chat.action.edit')}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
              else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            }} />
        </div>
        <div className="t2-edit-foot">
          <span className="t2-edit-hint"><GitBranch size={13} />{t('chat.edit.keepsBranch')}</span>
          <span className="t2-edit-grow" />
          <span className="t2-edit-key">Esc</span>
          <button type="button" className="t2-btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <span className="t2-edit-key">{mac ? '⌘↵' : 'Ctrl↵'}</span>
          <button type="button" className="t2-btn primary" disabled={!can} onClick={send}>{t('chat.edit.send')}</button>
        </div>
      </div>
      <div className="t2-avatar t2-user-avatar" style={!userAvatar ? { background: 'color-mix(in srgb, var(--text-muted) 22%, transparent)' } : undefined}>
        {userAvatar ? <img src={userAvatar} alt="" /> : firstChar(name)}
      </div>
    </div>
  )
}
