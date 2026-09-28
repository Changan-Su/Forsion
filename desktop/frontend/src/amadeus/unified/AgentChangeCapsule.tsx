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
  'agentchg.live': { zh: 'Tangu 正在修改这篇笔记', en: 'Tangu is editing this note' },
  'agentchg.liveHint': {
    zh: '可以接着写；改动撞上时保留你的版本，Tangu 的另存为副本',
    en: 'Keep writing — if edits overlap, yours are kept and Tangu’s are saved as a copy',
  },
})

/** 「Tangu 正在修改这篇笔记」(评审 G3-05):写类工具的参数在流式生成 / 工具已发出还没回结果时挂着。只是告知,不拦编辑 ——
 *  撞上了按既定策略(本地胜 + 冲突副本 + 点名 Tangu 的提示)处理。外形复用改动胶囊。 */
export function AgentLiveCapsule(): ReactElement {
  const { t } = useI18n()
  return (
    <div className="am-agent-capsule" role="status" aria-live="polite" data-testid="agent-live-capsule">
      <span className="amx-pending-insert-spin" aria-hidden />
      <span className="am-agent-capsule-text">{t('agentchg.live')}</span>
      <span className="am-agent-capsule-hint">{t('agentchg.liveHint')}</span>
    </div>
  )
}

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
