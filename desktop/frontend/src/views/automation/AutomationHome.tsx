import React from 'react'
import { ArrowRight, Bell, Bot, Database, MousePointerClick, Plus, Workflow } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAutomation } from '../../stores/automationStore'
import { STARTERS } from './experience'
import './messages'

const icons = { reminder: Bell, briefing: Bot, table: Database, button: MousePointerClick }

export const AutomationHome: React.FC = () => {
  const { t } = useI18n()
  const openBuilder = useAutomation((s) => s.openBuilder)
  return (
    <div className="auto-home">
      <div className="auto-home-kicker"><Workflow size={16} /> {t('automation.ux.workspace')}</div>
      <h1>{t('automation.ux.welcome')}</h1>
      <p className="auto-home-lead">{t('automation.ux.intro')}</p>
      <ol className="auto-guide">
        {['trigger', 'actions', 'test'].map((key, i) => (
          <li key={key}><span>{i + 1}</span><div><strong>{t(`automation.ux.guide.${key}`)}</strong><p>{t(`automation.ux.guide.${key}Hint`)}</p></div></li>
        ))}
      </ol>
      <div className="auto-home-section"><h2>{t('automation.ux.startWith')}</h2><button className="btn ghost sm" onClick={() => openBuilder()}><Plus size={13} />{t('automation.ux.blank')}</button></div>
      <div className="auto-starters">
        {STARTERS.map((starter) => {
          const Icon = icons[starter]
          return <button key={starter} className="auto-starter" onClick={() => openBuilder(undefined, starter)}>
            <Icon size={20} /><strong>{t(`automation.ux.${starter}.name`)}</strong>
            <span>{t(`automation.ux.${starter}.hint`)}</span>
            <small>{t(`automation.ux.${starter}.flow`)}<ArrowRight size={13} /></small>
          </button>
        })}
      </div>
      <p className="auto-home-note">{t('automation.ux.draftHint')}</p>
      <div className="auto-home-ecosystem"><strong>{t('automation.ux.native')}</strong><p>{t('automation.ux.nativeHint')}</p></div>
    </div>
  )
}
