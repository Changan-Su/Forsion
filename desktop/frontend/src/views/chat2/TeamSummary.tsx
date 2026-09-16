import { Markdown } from '../../components/Markdown'
import { registerMessages, useI18n } from '../../i18n'
import type { UiMessage } from '../../types'

registerMessages({
  'team.summary': { zh: 'Historian · 团队总结', en: 'Historian · Team summary' },
})

export function TeamSummary({ message }: { message: UiMessage }) {
  const { t } = useI18n()
  return <details className="t2-team-summary" data-team-summary>
    <summary>{t('team.summary')}</summary>
    <Markdown content={message.content} />
  </details>
}
