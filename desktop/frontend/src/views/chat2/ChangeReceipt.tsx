/**
 * A:回复下面一行回执「改了 N 个文件 +a −b ›」(方案页 docs/ToBeImproved/文件改动记录方案_2026-11-06/,用户选 A + C)。
 * 画法照「记住了 N 件事」那行(.self-receipt):无底色、细线分行。点开按文件列(真增减),再点一个文件就地展开 diff;
 * 停在一行上露「撤销」,最下面「撤销这一轮的改动」。手机上点开是贴底抽屉。
 * 数据见 changeTrail.ts;只在这一轮最后一条助手消息上画,运行中不画(最新一轮还在变)。
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, ExternalLink, FileCode, FileDiff as FileDiffIcon, FileMinus2, FilePlus2, FileText, Undo2 } from 'lucide-react'
import { ConfirmDialog } from '@amadeus/components/Dialogs'
import { registerMessages, useI18n } from '../../i18n'
import { currentPlatform } from '../../services/platform'
import { useApp } from '../../stores/appStore'
import { useSessionCwd } from './WebCards'
import { ChangeNums, FileDiff } from './FileDiff'
import { openChangedFile } from './changeNav'
import { canUndoChanges, isProsePath, splitPath, totals, undoChanges, useFileDiff, useMessageChanges, type FileChange, type TurnWindow } from './changeTrail'
import './changeTrail.css'

registerMessages({
  'changes.rcpt.title': { zh: '改了 {n} 个文件', en: 'Changed {n} file(s)' },
  'changes.tag.created': { zh: '新建', en: 'New' },
  'changes.tag.deleted': { zh: '已删除', en: 'Deleted' },
  'changes.tag.reverted': { zh: '已撤销', en: 'Undone' },
  'changes.tag.editedLater': { zh: '之后你也改过', en: 'You edited it later' },
  'changes.why.binary': { zh: '二进制文件，没法逐行对比', en: 'Binary file — can’t compare line by line' },
  'changes.why.toobig': { zh: '文件太大，没法逐行对比', en: 'Too large to compare line by line' },
  'changes.why.nosnap': { zh: '当时没存下原样（太大或读不了），没法对比，也撤销不了', en: 'No copy was saved at the time (too large or unreadable), so it can’t be compared or undone' },
  'changes.why.deleted': { zh: '这个文件被删掉了（删除会先进 Forsion 回收站）', en: 'This file was deleted (deletions go to the Forsion trash first)' },
  'changes.why.reverted': { zh: '已经回到改之前的样子', en: 'Back to how it was before the change' },
  'changes.loading': { zh: '正在读改动…', en: 'Loading changes…' },
  'changes.loadFailed': { zh: '读不到这份改动', en: 'Couldn’t load this change' },
  'changes.undo': { zh: '撤销', en: 'Undo' },
  'changes.open': { zh: '打开', en: 'Open' },
  'changes.undo.fileTip': { zh: '把这个文件恢复到这一轮开始前的样子', en: 'Restore this file to how it was before this turn' },
  'changes.undo.turn': { zh: '撤销这一轮的改动', en: 'Undo this turn’s changes' },
  'changes.undo.before': { zh: '撤销到这一轮之前', en: 'Undo back to before this turn' },
  'changes.note.scope': { zh: '只记 Tangu 用写文件工具改的；命令里改的（npm、脚本）不在这里', en: 'Only edits made with Tangu’s file tools; changes made by commands (npm, scripts) aren’t listed' },
  'changes.confirm.fileTitle': { zh: '撤销对 {name} 的改动？', en: 'Undo the changes to {name}?' },
  'changes.confirm.turnTitle': { zh: '撤销这一轮的改动？', en: 'Undo this turn’s changes?' },
  'changes.confirm.beforeTitle': { zh: '撤销到这一轮之前？', en: 'Undo back to before this turn?' },
  'changes.confirm.msg': { zh: '会回到这一轮开始前的样子。Tangu 改完之后又被改过的文件不会动。', en: 'It goes back to how it was before this turn. Files changed again after Tangu’s edit are left alone.' },
  'changes.confirm.msgLater': { zh: '会回到这一轮开始前的样子，之后几轮对它们的改动也会一起撤掉。Tangu 改完之后又被改过的文件不会动。', en: 'They go back to how they were before this turn, and later turns’ changes to them are undone too. Files changed again after Tangu’s edit are left alone.' },
})

const PHONE_MQ = '(hover: none) and (pointer: coarse)'
const usePhoneSheet = (): boolean => currentPlatform() === 'mobile' || (typeof matchMedia !== 'undefined' && matchMedia(PHONE_MQ).matches && window.innerWidth < 600)

export function fileIcon(f: FileChange, size = 14) {
  const Icon = f.kind === 'created' ? FilePlus2 : f.kind === 'deleted' ? FileMinus2 : isProsePath(f.path) ? FileText : FileCode
  return <Icon size={size} className="ct-ic" />
}

/** 一个文件可不可以撤:没存原样的、已经回到原样的不给。 */
export const undoable = (f: FileChange): boolean => f.reason !== 'nosnap' && !f.reverted

export function FileTags({ f }: { f: FileChange }) {
  const { t } = useI18n()
  return (
    <>
      {f.kind === 'created' && !f.reverted && <span className="ct-tag">{t('changes.tag.created')}</span>}
      {f.kind === 'deleted' && <span className="ct-tag">{t('changes.tag.deleted')}</span>}
      {f.reverted && <span className="ct-tag">{t('changes.tag.reverted')}</span>}
      {f.editedLater && <span className="ct-tag warn">{t('changes.tag.editedLater')}</span>}
    </>
  )
}

/** 撤销确认:列出会动到的文件。挂 body,不被消息列表的堆叠上下文裁掉(同 RemoveDialog)。 */
export function UndoConfirm({ title, message, files, cwd, onConfirm, onClose }: {
  title: string; message: string; files: FileChange[]; cwd?: string; onConfirm: () => void; onClose: () => void
}) {
  const { t } = useI18n()
  return createPortal(
    <div className="am-app tangu-lovable" style={{ display: 'contents' }} data-change-undo-confirm>
      <ConfirmDialog title={title} message={message} confirmLabel={t('changes.undo')} danger={false} onConfirm={onConfirm} onClose={onClose}>
        <ul className="ct-note" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {files.slice(0, 12).map((f) => { const p = splitPath(f.path, cwd); return <li key={f.path}>{p.dir ? `${p.dir}/` : ''}{p.name}</li> })}
          {files.length > 12 && <li>…</li>}
        </ul>
      </ConfirmDialog>
    </div>,
    document.body,
  )
}

function FileBody({ sid, win, f }: { sid: string; win: TurnWindow; f: FileChange }) {
  const { t } = useI18n()
  const plain = f.reverted ? 'changes.why.reverted' : f.kind === 'deleted' ? 'changes.why.deleted' : f.adds == null ? `changes.why.${f.reason || 'nosnap'}` : null
  const d = useFileDiff(sid, win, f.path, !plain)
  if (plain) return <div className="ct-row-msg ct-note">{t(plain)}</div>
  if (d === 'loading' || d === undefined) return <div className="ct-row-msg ct-note">{t('changes.loading')}</div>
  if (d === 'error' || !d.patch) return <div className="ct-row-msg ct-note">{d === 'error' ? t('changes.loadFailed') : t(`changes.why.${d.reason || 'nosnap'}`)}</div>
  return <div className="ct-row-diff"><FileDiff patch={d.patch} prose={isProsePath(f.path)} truncated={d.truncated} createdHead={f.kind === 'created' ? 7 : undefined} /></div>
}

/** 文件列表(回执展开 / 手机抽屉共用)。 */
export function ChangeList({ sid, win, files, latest, cwd, footerUndo = true }: {
  sid: string; win: TurnWindow; files: FileChange[]; latest: boolean; cwd?: string; footerUndo?: boolean
}) {
  const { t } = useI18n()
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ files: FileChange[]; title: string } | null>(null)
  const running = useApp((s) => !!s.runningBySession[sid])
  const canUndo = canUndoChanges(sid)
  const turnFiles = files.filter(undoable)
  return (
    <div className="ct-rows">
      {files.map((f) => {
        const p = splitPath(f.path, cwd)
        const open = openPath === f.path
        return (
          <div key={f.path} className={`ct-row${open ? ' open' : ''}`} data-change-file={p.name}>
            <div className="ct-row-head" onClick={() => setOpenPath(open ? null : f.path)}>
              <button type="button" className="ct-row-main" aria-expanded={open} title={f.path}>
                {fileIcon(f)}
                <span className="ct-row-name">{p.name}{p.dir && <span className="dir">{p.dir}</span>}<FileTags f={f} /></span>
              </button>
              {f.reverted ? <span /> : <ChangeNums adds={f.adds} dels={f.dels} />}
              <span className="ct-row-ops">
                {f.kind !== 'deleted' && !(f.kind === 'created' && f.reverted) && (
                  <button type="button" className="ct-act" title={f.path}
                    onClick={(e) => { e.stopPropagation(); openChangedFile(sid, f.path) }}>
                    <ExternalLink size={12} />{t('changes.open')}
                  </button>
                )}
                {canUndo && undoable(f) && (
                  <button type="button" className="ct-act" disabled={running} title={t('changes.undo.fileTip')}
                    onClick={(e) => { e.stopPropagation(); setConfirm({ files: [f], title: t('changes.confirm.fileTitle', { name: p.name }) }) }}>
                    <Undo2 size={12} />{t('changes.undo')}
                  </button>
                )}
              </span>
              {open ? <ChevronDown size={12} className="ct-ic" /> : <ChevronRight size={12} className="ct-ic" />}
            </div>
            {open && <FileBody sid={sid} win={win} f={f} />}
          </div>
        )
      })}
      <div className="ct-rcpt-foot">
        <span className="ct-note">{t('changes.note.scope')}</span>
        {footerUndo && canUndo && turnFiles.length > 0 && (
          <button type="button" className="ct-act" disabled={running} data-change-undo-turn
            onClick={() => setConfirm({ files: turnFiles, title: t(latest ? 'changes.confirm.turnTitle' : 'changes.confirm.beforeTitle') })}>
            <Undo2 size={12} />{t(latest ? 'changes.undo.turn' : 'changes.undo.before')}
          </button>
        )}
      </div>
      {confirm && (
        <UndoConfirm title={confirm.title} message={t(latest ? 'changes.confirm.msg' : 'changes.confirm.msgLater')} files={confirm.files} cwd={cwd}
          onClose={() => setConfirm(null)}
          onConfirm={() => { const fs = confirm.files; setConfirm(null); void undoChanges(sid, win.since, fs.map((x) => x.path)) }} />
      )}
    </div>
  )
}

export function ChangeReceipt({ sessionId, msgId }: { sessionId: string; msgId: string }) {
  const { t } = useI18n()
  const data = useMessageChanges(sessionId, msgId)
  const cwd = useSessionCwd(sessionId)
  const [open, setOpen] = useState(false)
  const [sheet, setSheet] = useState(false)
  const running = useApp((s) => !!s.runningBySession[sessionId])
  if (!data || (data.latest && running)) return null
  const { win, files, latest } = data
  const tot = totals(files)
  const head = (
    <>
      <FileDiffIcon size={15} className="ct-ic" />
      <span><span className="ct-rcpt-first">{t('changes.rcpt.title', { n: files.length })}</span>{' '}<ChangeNums adds={tot.adds} dels={tot.dels} /></span>
    </>
  )
  return (
    <div className={`ct-rcpt${open ? ' open' : ''}`} data-change-receipt>
      <button type="button" className="ct-rcpt-head" aria-expanded={open || sheet}
        onClick={() => (usePhoneSheet() ? setSheet(true) : setOpen((o) => !o))}>
        {head}<ChevronRight size={12} className="ct-rcpt-chev" />
      </button>
      {open && <ChangeList sid={sessionId} win={win} files={files} latest={latest} cwd={cwd} />}
      {sheet && createPortal(
        <div className="ct-sheet-scrim" onClick={() => setSheet(false)} data-change-sheet>
          <div className="ct-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('changes.rcpt.title', { n: files.length })}>
            <div className="ct-sheet-grip" />
            <div className="ct-sheet-head">{head}<span className="sp" /></div>
            <div className="ct-sheet-list ct-rcpt"><ChangeList sid={sessionId} win={win} files={files} latest={latest} cwd={cwd} /></div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
