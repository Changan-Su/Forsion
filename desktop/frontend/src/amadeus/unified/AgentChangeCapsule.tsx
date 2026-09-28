/** 「Tangu 修改了 N 处 · 逐处查看 · 全部撤回 · 保留」胶囊(评审 G3-03)。纯展示:动作全由 UnifiedPage 经回调执行
 *  (agentChanges.ts 的 revert / keep / next)。不阻塞编辑:贴在正文底部 sticky,正文照常可打字。 */
import type { ReactElement } from 'react'
import { Sparkles } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'agentchg.summary': { zh: 'Tangu 修改了 {n} 处', en: 'Tangu changes: {n}' },
  'agentchg.review': { zh: '逐处查看', en: 'Review' },
  'agentchg.next': { zh: '下一处 {i}/{n}', en: 'Next {i}/{n}' },
  'agentchg.revert': { zh: '全部撤回', en: 'Revert all' },
  'agentchg.keep': { zh: '保留', en: 'Keep' },
  'agentchg.label': { zh: 'Tangu 对这篇笔记的改动', en: "Tangu's changes to this note" },
  'agentchg.skipped': { zh: '有 {n} 处你已改过，保留了你的版本，没有撤回', en: 'Skipped {n} you had already edited; your version was kept' },
})

export function AgentChangeCapsule({ count, index, onReview, onRevert, onKeep }: {
  count: number
  /** 「逐处查看」当前第几处(1 起);0 = 还没开始看。 */
  index: number
  onReview: () => void
  onRevert: () => void
  onKeep: () => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <div className="am-agent-capsule" role="status" aria-label={t('agentchg.label')} data-testid="agent-change-capsule">
      <Sparkles size={14} aria-hidden />
      <span className="am-agent-capsule-text">{t('agentchg.summary', { n: String(count) })}</span>
      <span className="am-agent-capsule-sep" aria-hidden />
      <button type="button" className="btn sm" data-act="review" onClick={onReview}>
        {index ? t('agentchg.next', { i: String(index), n: String(count) }) : t('agentchg.review')}
      </button>
      <button type="button" className="btn sm" data-act="revert" onClick={onRevert}>{t('agentchg.revert')}</button>
      <button type="button" className="btn sm primary" data-act="keep" onClick={onKeep}>{t('agentchg.keep')}</button>
    </div>
  )
}
