/**
 * C:任务概览里的「改动」卡(方案页 docs/ToBeImproved/文件改动记录方案_2026-11-06/,用户选 A + C)。
 * 卡头:标题 + 本轮 / 本会话 两档(这台电脑上记住);每行 = 文件 + 真增减,停上去增减换成「撤销」;
 * 底下「共 +a −b · 审阅全部 ›」开 Desk 里的审阅页。点一行 = 审阅页滚到那个文件。
 * 卡本身(SummaryCard、开合、排序)仍在 TaskSummary 里,这里只出卡头的两档和正文。
 */
import { useState } from 'react'
import { Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { ChangeNums } from './FileDiff'
import { UndoConfirm, fileIcon, undoable } from './ChangeReceipt'
import { canUndoChanges, setCardScope, splitPath, totals, undoChanges, type CardScope, type FileChange, type TurnWindow } from './changeTrail'
import { openChangesReview } from './changeNav'
import './changeTrail.css'

registerMessages({
  'changes.title': { zh: '改动', en: 'Changes' },
  'changes.scope.turn': { zh: '本轮', en: 'Turn' },
  'changes.scope.session': { zh: '本会话', en: 'Session' },
  'changes.scope.git': { zh: '未提交', en: 'Uncommitted' },
  'changes.card.sum': { zh: '共', en: 'Total' },
  'changes.review.all': { zh: '审阅全部', en: 'Review all' },
  'changes.card.turnEmpty': { zh: '这一轮没改文件', en: 'No files changed this turn' },
  'changes.card.running': { zh: '这一轮跑完再列出来', en: 'Listed when this turn finishes' },
  'changes.confirm.msgSession': { zh: '会回到这个会话改它之前的样子。Tangu 改完之后又被改过的文件不会动。', en: 'It goes back to how it was before this session changed it. Files changed again after Tangu’s edit are left alone.' },
})

/** 卡头里的两档。在 <summary> 里:不拦事件会顺带折叠卡片 / 起拖。 */
export function ChangeScopeSeg({ scope }: { scope: CardScope }) {
  const { t } = useI18n()
  const stop = (e: React.SyntheticEvent): void => { e.preventDefault(); e.stopPropagation() }
  return (
    <span className="ct-seg" role="group" aria-label={t('changes.title')} onPointerDown={(e) => e.stopPropagation()}>
      {(['turn', 'session'] as const).map((k) => (
        <button key={k} type="button" aria-pressed={scope === k} data-change-scope={k}
          onClick={(e) => { stop(e); setCardScope(k) }}>{t(`changes.scope.${k}`)}</button>
      ))}
    </span>
  )
}

export function ChangesCardBody({ sessionId, scope, win, files, loading, failed, cwd }: {
  sessionId: string; scope: CardScope; win: TurnWindow | null; files: FileChange[]; loading: boolean; failed?: boolean; cwd?: string
}) {
  const { t } = useI18n()
  const running = useApp((s) => !!s.runningBySession[sessionId])
  const [confirm, setConfirm] = useState<FileChange | null>(null)
  const canUndo = canUndoChanges(sessionId)
  const tot = totals(files)
  if (!files.length) {
    return <div className="ct-note" style={{ padding: '4px 0' }}>{loading ? t('changes.loading') : failed ? t('changes.loadFailed') : running && scope === 'turn' ? t('changes.card.running') : t(scope === 'session' ? 'changes.empty.session' : 'changes.card.turnEmpty')}</div>
  }
  return (
    <>
      {files.map((f) => {
        const p = splitPath(f.path, cwd)
        return (
          <div key={f.path} className="t2-tsum-row act ct-crow" title={f.path} data-change-file={p.name}
            onClick={() => openChangesReview(sessionId, scope, f.path, win?.since)}>
            {fileIcon(f)}
            <button type="button" className="ct-crow-main t2-tsum-row-tx" onClick={(e) => { e.stopPropagation(); openChangesReview(sessionId, scope, f.path, win?.since) }}>{p.name}</button>
            {f.reverted ? <span className="ct-tag">{t('changes.tag.reverted')}</span> : <ChangeNums adds={f.adds} dels={f.dels} />}
            {canUndo && win && undoable(f) && (
              <button type="button" className="ct-act ct-crow-undo" disabled={running} title={t('changes.undo.fileTip')}
                onClick={(e) => { e.stopPropagation(); setConfirm(f) }}>
                <Undo2 size={12} />{t('changes.undo')}
              </button>
            )}
          </div>
        )
      })}
      <div className="ct-cfoot">
        <span>{t('changes.card.sum')} <ChangeNums adds={tot.adds} dels={tot.dels} /></span>
        <button type="button" className="ct-act" data-change-review onClick={() => openChangesReview(sessionId, scope, undefined, win?.since)}>{t('changes.review.all')} ›</button>
      </div>
      {confirm && win && (
        <UndoConfirm title={t('changes.confirm.fileTitle', { name: splitPath(confirm.path).name })}
          message={t(scope === 'session' ? 'changes.confirm.msgSession' : 'changes.confirm.msg')} files={[confirm]} cwd={cwd}
          onClose={() => setConfirm(null)}
          onConfirm={() => { const f = confirm; setConfirm(null); void undoChanges(sessionId, win.since, [f.path]) }} />
      )}
    </>
  )
}
