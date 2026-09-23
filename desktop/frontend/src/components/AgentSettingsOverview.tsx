import { useEffect, useState } from 'react'
import { Bot, ChevronRight, Loader2, UserRound } from 'lucide-react'
import { getAgentsMeta, getUserProfile, listAgents, putUserProfile } from '../services/backendService'
import type { NormalAgentDef, TanguDesktopConfig } from '../types'
import { registerMessages, useI18n } from '../i18n'
import './agentSettingsOverview.css'

registerMessages({
  'agentSettings.rosterTitle': { zh: 'Agent Space', en: 'Agent Space' },
  'agentSettings.rosterDescription': { zh: '在 Agent Space 中创建、排序并编辑智能体。这里保留适用于所有 Agent 的设置。', en: 'Create, reorder and edit agents in Agent Space. Settings here apply across agents.' },
  'agentSettings.open': { zh: '打开 Agent Space', en: 'Open Agent Space' },
  'agentSettings.default': { zh: '当前默认 Agent', en: 'Current default agent' },
  'agentSettings.manage': { zh: '查看档案', en: 'View profile' },
  'agentSettings.noAgents': { zh: '尚无可用 Agent。前往 Agent Space 新建。', en: 'No agents yet. Create one in Agent Space.' },
  'agentSettings.userTitle': { zh: '用户画像', en: 'User profile' },
  'agentSettings.userDescription': { zh: '告诉 Agent 你的称呼、偏好和长期需求；这份资料由所有 Agent 共用。', en: 'Tell agents how to address you, your preferences and long-term needs. All agents share this profile.' },
  'agentSettings.userPlaceholder': { zh: '# 用户画像\n\n## 称呼\n\n## 偏好\n\n## 长期目标', en: '# User profile\n\n## Name\n\n## Preferences\n\n## Long-term goals' },
  'agentSettings.save': { zh: '保存用户画像', en: 'Save user profile' },
  'agentSettings.saved': { zh: '用户画像已保存。', en: 'User profile saved.' },
  'agentSettings.error': { zh: '操作失败：{error}', en: 'Action failed: {error}' },
})

export function AgentSettingsOverview({ cfg, onOpenAgent }: { cfg: TanguDesktopConfig; onOpenAgent: (slug: string) => void }) {
  const { t } = useI18n()
  const [agents, setAgents] = useState<NormalAgentDef[] | null>(null)
  const [defaultSlug, setDefaultSlug] = useState('xyra')
  const [profile, setProfile] = useState('')
  const [savedProfile, setSavedProfile] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    const refreshAgents = (): void => {
      void Promise.allSettled([listAgents(cfg), getAgentsMeta(cfg)]).then(([agentResult, metaResult]) => {
        if (!active) return
        setAgents(agentResult.status === 'fulfilled' ? agentResult.value : [])
        if (metaResult.status === 'fulfilled') setDefaultSlug(metaResult.value.defaultSlug || 'xyra')
      })
    }
    refreshAgents()
    void getUserProfile(cfg).then((value) => {
      if (active) { setProfile(value); setSavedProfile(value) }
    }).catch(() => {})
    window.addEventListener('forsion:agents-changed', refreshAgents)
    return () => { active = false; window.removeEventListener('forsion:agents-changed', refreshAgents) }
  }, [cfg])
  const current = agents?.find((a) => a.slug === defaultSlug) || agents?.[0]
  const save = async (): Promise<void> => {
    setBusy(true); setMessage('')
    try { await putUserProfile(cfg, profile); setSavedProfile(profile); setMessage(t('agentSettings.saved')) }
    catch (error: any) { setMessage(t('agentSettings.error', { error: String(error?.message || error) })) }
    finally { setBusy(false) }
  }
  return <div className="agso-overview">
    <section className="settings-panel agso-panel">
      <div className="settings-panel-head"><span className="settings-panel-icon"><Bot size={16} /></span><div><strong>{t('agentSettings.rosterTitle')}</strong><p>{t('agentSettings.rosterDescription')}</p></div></div>
      <div className="agso-default">
        <span>{t('agentSettings.default')}</span>
        {agents === null ? <Loader2 size={14} className="spin" /> : current ? <button type="button" onClick={() => onOpenAgent(current.slug)}><strong>{current.name}</strong><small>{current.description}</small><ChevronRight size={15} /></button> : <p>{t('agentSettings.noAgents')}</p>}
      </div>
      <div className="agso-actions"><button className="btn ghost sm" type="button" onClick={() => onOpenAgent(current?.slug || 'xyra')}>{t('agentSettings.open')}<ChevronRight size={13} /></button></div>
    </section>
    <section className="settings-panel agso-panel">
      <div className="settings-panel-head"><span className="settings-panel-icon"><UserRound size={16} /></span><div><strong>{t('agentSettings.userTitle')}</strong><p>{t('agentSettings.userDescription')}</p></div></div>
      <div className="agso-profile"><textarea value={profile} onChange={(event) => setProfile(event.target.value)} rows={8} placeholder={t('agentSettings.userPlaceholder')} aria-label={t('agentSettings.userTitle')} /><div><button className="btn primary sm" type="button" disabled={busy || profile === savedProfile} onClick={() => void save()}>{busy && <Loader2 size={13} className="spin" />}{t('agentSettings.save')}</button>{message && <span role="status">{message}</span>}</div></div>
    </section>
  </div>
}
