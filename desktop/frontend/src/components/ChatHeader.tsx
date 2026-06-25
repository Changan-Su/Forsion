/** 顶栏:侧栏开关 + 会话标题 + 模型 + 右上角(语言/深浅模式/右栏开关)。整条可拖拽(Electron hiddenInset)。 */
import React from 'react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { useI18n } from '../i18n'
import { LocaleToggle } from './LocaleToggle'
import { ModeToggle } from './ModeToggle'

export const ChatHeader: React.FC<{
  title: string
  engineName?: string
  connState: 'idle' | 'ok' | 'err'
  connMessage: string
  sidebarCollapsed: boolean
  rightOpen: boolean
  themeMode: 'light' | 'dark'
  onToggleSidebar: () => void
  onToggleRight: () => void
  onToggleMode: () => void
}> = (p) => {
  const { t } = useI18n()
  return (
    <header className="chat-header">
      <button className="icon-btn" onClick={p.onToggleSidebar} title={t('header.sidebar')}>
        <PanelLeft size={16} />
      </button>
      <div className="chat-title">{p.title}</div>
      {p.engineName ? <span className="conn-pill" title={t('header.currentAgent')}>{p.engineName}</span> : null}
      {/* Host/微信/浏览器/在线 等状态胶囊已移除;仅在掉线时保留一个错误提示。 */}
      {p.connState === 'err' && (
        <span className="conn-pill err" title={p.connMessage}>
          <span className="dot" />
          {t('header.offline')}
        </span>
      )}
      {/* 右上角:语言 / 深浅模式 / 右栏开关 */}
      <LocaleToggle compact />
      <ModeToggle mode={p.themeMode} onToggle={p.onToggleMode} />
      <button className={`icon-btn${p.rightOpen ? ' active' : ''}`} onClick={p.onToggleRight} title={t('header.workspacePanel')}>
        <PanelRight size={16} />
      </button>
    </header>
  )
}
