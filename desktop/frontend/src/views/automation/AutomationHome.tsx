import React, { useState } from 'react'
import { ArrowRight, Bell, Bot, Database, MousePointerClick, Plus, Workflow } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAutomation } from '../../stores/automationStore'
import { homeSlots } from './experience'
import { MuseSuggestionSection } from './MuseSuggestions'
import './messages'

const icons = { reminder: Bell, briefing: Bot, table: Database, button: MousePointerClick }

export const AutomationHome: React.FC = () => {
  const { t } = useI18n()
  const openBuilder = useAutomation((s) => s.openBuilder)
  const suggestions = useAutomation((s) => s.suggestions)
  const [expanded, setExpanded] = useState(false)
  // Muse 建议在前;不满 HOME_SLOTS 格时用模板补位,一条建议都没有就是原来的四个模板
  const { shown, extra, starters } = homeSlots(suggestions, expanded)
  const blank = <button className="btn ghost sm" onClick={() => openBuilder()}><Plus size={13} />{t('automation.ux.blank')}</button>
  return (
    <div className="auto-home">
      <div className="auto-home-kicker"><Workflow size={16} /> {t('automation.ux.workspace')}</div>
      <h1>{t('automation.ux.welcome')}</h1>
      <p className="auto-home-lead">{t('automation.ux.intro')}</p>
      <details className="auto-home-help"><summary>{t('automation.ux.help')}</summary><ol className="auto-guide">
        {['trigger', 'actions', 'test'].map((key, i) => (
          <li key={key}><span>{i + 1}</span><div><strong>{t(`automation.ux.guide.${key}`)}</strong><p>{t(`automation.ux.guide.${key}Hint`)}</p></div></li>
        ))}
      </ol></details>
      {shown.length > 0 && <MuseSuggestionSection shown={shown} extra={extra} onMore={() => setExpanded(true)} action={starters.length ? undefined : blank} />}
      {starters.length > 0 && <div className="auto-home-section">{shown.length > 0 ? <h2>{t('automation.ux.orTemplate')}</h2> : <h2>{t('automation.ux.startWith')}</h2>}{blank}</div>}
      <div className="auto-starters">
        {starters.map((starter) => {
          const Icon = icons[starter]
          return <button key={starter} className="auto-starter" onClick={() => openBuilder(undefined, starter)}>
            <Icon size={20} /><strong>{t(`automation.ux.${starter}.name`)}</strong>
            <span>{t(`automation.ux.${starter}.hint`)}</span>
            <small>{t(`automation.ux.${starter}.flow`)}<ArrowRight size={13} /></small>
          </button>
        })}
      </div>
      <p className="auto-home-note">{t('automation.ux.draftHint')}</p>
    </div>
  )
}
