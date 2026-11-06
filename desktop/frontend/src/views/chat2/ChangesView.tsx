/**
 * C:改动审阅页(Desk 宽格;Desk 不收文件时开标签页)。方案页 docs/ToBeImproved/文件改动记录方案_2026-11-06/。
 * 三档:本轮 / 本会话(引擎检查点对比,能撤)、未提交(Git 工作区对 HEAD,命令改的也在,只看不撤)。
 * 左边按文件夹分组的文件表,右边逐个文件的 diff;每个文件「打开 / 撤销」,底下一句说明命令改的不在前两档里。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Terminal, Undo2 } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useSessionCwd } from './WebCards'
import { ChangeNums, FileDiff } from './FileDiff'
import { FileTags, UndoConfirm, fileIcon, undoable, whyKey } from './ChangeReceipt'
import {
  canUndoChanges, isProsePath, loadGitChanges, loadWindowDiffs, splitPath, totals, undoChanges, useChangeTrail,
  type FileChange, type GitChangesInfo, type ReviewScope,
} from './changeTrail'
import { openChangedFile } from './changeNav'
import './ChangesCard' // 「改动 / 本轮 / 本会话 / 未提交」几个词条在那边登记
import './changeTrail.css'

registerMessages({
  'changes.review.head.turn': { zh: '这一轮改了 {n} 个文件', en: 'This turn changed {n} file(s)' },
  'changes.review.head.session': { zh: '这个会话改了 {n} 个文件', en: 'This session changed {n} file(s)' },
  'changes.review.head.git': { zh: '{n} 个文件没提交', en: '{n} uncommitted file(s)' },
  'changes.review.sessionNote': { zh: '几轮里改过同一个文件的，合成一份看；单看某一轮切到「本轮」，或点那条回复下面的回执', en: 'A file changed in several turns shows as one combined diff; to see a single turn, switch to “Turn” or open the receipt under that reply' },
  'changes.review.root': { zh: '工作目录', en: 'Working folder' },
  'changes.undo.session': { zh: '撤销本会话的改动', en: 'Undo this session’s changes' },
  'changes.confirm.sessionTitle': { zh: '撤销本会话的改动？', en: 'Undo this session’s changes?' },
  'changes.empty.turn': { zh: '这一轮没改文件', en: 'No files changed this turn' },
  'changes.empty.session': { zh: '这个会话还没改文件', en: 'No files changed in this session yet' },
  'changes.empty.git': { zh: '没有未提交的改动', en: 'No uncommitted changes' },
  'changes.git.nogit': { zh: '这台电脑上没有 Git', en: 'Git isn’t available on this computer' },
  'changes.git.notrepo': { zh: '工作目录不在 Git 仓库里', en: 'The working folder isn’t in a Git repository' },
  'changes.git.nocwd': { zh: '这个会话没有工作目录', en: 'This session has no working folder' },
  'changes.git.untrusted': { zh: '这个仓库的 Git 配置里带了过滤器，为安全起见不在这里跑 git diff', en: 'This repository’s Git config defines filters, so git diff isn’t run here for safety' },
  'changes.git.note': { zh: '未提交 = Git 里还没提交的全部改动，命令改的也在。这里只能看，撤销请用 Git。', en: 'Uncommitted = everything Git hasn’t committed yet, including changes made by commands. View only here — use Git to undo.' },
  'changes.git.truncated': { zh: '文件太多，只列了前 300 个', en: 'Too many files — showing the first 300' },
  'changes.cmd.hint': { zh: '想看命令改的，切到「未提交」（会话目录在 Git 仓库里时）。', en: 'To see changes made by commands, switch to “Uncommitted” (when the session folder is in a Git repository).' },
})

type Loaded =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; files: FileChange[]; git?: GitChangesInfo; scope: ReviewScope; since?: number }

export function ChangesView({ params }: ViewProps) {
  const { t } = useI18n()
  const sid = String(params?.sessionId ?? '')
  const req = useChangeTrail((s) => s.review[sid])
  const [scope, setScope] = useState<ReviewScope>(() => (params?.scope === 'session' || params?.scope === 'git' ? params.scope : 'turn'))
  const [focus, setFocus] = useState<string | undefined>(() => (typeof params?.focus === 'string' ? params.focus : undefined))
  // 已开着时再点卡里的行:就地切档、滚过去(n 每次加一,同一个文件再点也滚)
  const reqN = useRef(req?.n ?? 0)
  useEffect(() => {
    if (!req || req.n === reqN.current) return
    reqN.current = req.n
    setScope(req.scope)
    setFocus(req.focus)
  }, [req])

  const cwd = useSessionCwd(sid)
  const trailKey = useChangeTrail((s) => s.by[sid]?.key ?? '')
  const rev = useChangeTrail((s) => s.rev[sid] ?? 0)
  const latestSince = useChangeTrail((s) => { const b = s.by[sid]?.bounds; return b?.length ? b[b.length - 1] : undefined })
  const since = scope === 'session' ? 0 : latestSince ?? (typeof params?.since === 'number' ? params.since : undefined)
  const running = useApp((s) => !!s.runningBySession[sid])

  const [data, setData] = useState<Loaded>({ kind: 'loading' })
  useEffect(() => {
    if (!sid) return
    let alive = true
    // 同一档重拉(撤销 / 新一轮跑完)时先留着旧的,不闪;换了档就当场清掉 —— 别让上一档的文件配着这一档的「撤销」
    setData((d) => (d.kind === 'ok' && d.scope === scope && d.since === since ? d : { kind: 'loading' }))
    const p: Promise<Loaded> = scope === 'git'
      ? loadGitChanges(sid).then((g) => ({ kind: 'ok', files: g.files, git: g, scope }))
      : since == null
        ? Promise.resolve({ kind: 'ok', files: [], scope, since })
        : loadWindowDiffs(sid, { since, until: null }).then((files) => ({ kind: 'ok', files, scope, since }))
    p.then((r) => { if (alive) setData(r) }, (e) => { if (alive) setData({ kind: 'error', message: (e as Error)?.message || String(e) }) })
    return () => { alive = false }
  }, [sid, scope, since, trailKey, rev])

  const files = data.kind === 'ok' && data.scope === scope && (scope === 'git' || data.since === since) ? data.files : []
  const groups = useMemo(() => {
    const m = new Map<string, Array<FileChange & { name: string }>>()
    for (const f of files) {
      const p = splitPath(f.path, cwd)
      const arr = m.get(p.dir) ?? []
      arr.push({ ...f, name: p.name })
      m.set(p.dir, arr)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [files, cwd])

  // 滚到点名的文件(数据到了才滚得到)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focus || data.kind !== 'ok') return
    const el = bodyRef.current?.querySelector(`[data-rv-file="${CSS.escape(focus)}"]`)
    el?.scrollIntoView({ block: 'start' })
  }, [focus, data, req?.n])

  const [confirm, setConfirm] = useState<{ files: FileChange[]; title: string } | null>(null)
  const canUndo = scope !== 'git' && since != null && canUndoChanges(sid)
  const undoAll = files.filter(undoable)
  const tot = totals(files)
  const git = data.kind === 'ok' ? data.git : undefined

  const emptyText = data.kind === 'error' ? t('changes.loadFailed')
    : scope === 'git' && git && !git.available ? t(`changes.git.${git.reason || 'notrepo'}`)
    : t(`changes.empty.${scope}`)

  return (
    <div className="ct-review" data-change-review-page data-scope={scope}>
      <div className="ct-rv-bar">
        {/* 方案 C2:一句话标题(这一轮 / 这个会话改了几个文件)+ 合计在左,档位与整体撤销在右 */}
        <span className="ttl">{files.length ? t(`changes.review.head.${scope}`, { n: files.length }) : t('changes.title')}</span>
        {files.length > 0 && <ChangeNums adds={tot.adds} dels={tot.dels} />}
        <span className="sp" />
        <span className="ct-seg" role="group" aria-label={t('changes.title')}>
          {(['turn', 'session', 'git'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={scope === k} data-change-scope={k} onClick={() => { setScope(k); setFocus(undefined) }}>{t(`changes.scope.${k}`)}</button>
          ))}
        </span>
        {canUndo && undoAll.length > 0 && (
          <button type="button" className="ct-act" disabled={running} data-change-undo-all
            onClick={() => setConfirm({ files: undoAll, title: t(scope === 'session' ? 'changes.confirm.sessionTitle' : 'changes.confirm.turnTitle') })}>
            <Undo2 size={13} />{t(scope === 'session' ? 'changes.undo.session' : 'changes.undo.turn')}
          </button>
        )}
      </div>

      {data.kind === 'loading' && !files.length ? <div className="ct-rv-empty">{t('changes.loading')}</div>
        : !files.length ? (
          <div className="ct-rv-empty">
            {emptyText}
            {scope !== 'git' && <div className="ct-rv-cmd"><Terminal size={14} className="ct-ic" /><span>{t('changes.note.scope')} {t('changes.cmd.hint')}</span></div>}
          </div>
        ) : (
          <div className="ct-rv-body" ref={bodyRef}>
            <nav className="ct-rv-list">
              {groups.map(([dir, fs]) => (
                <div key={dir}>
                  <div className="ct-rv-grp" title={dir}>{dir || t('changes.review.root')}</div>
                  {fs.map((f) => (
                    <button key={f.path} type="button" className={`ct-rv-li${focus === f.path ? ' on' : ''}`} title={f.path} onClick={() => setFocus(f.path)}>
                      {fileIcon(f, 13)}<span className="nm">{f.name}</span>{f.reverted ? <span className="ct-tag">{t('changes.tag.reverted')}</span> : <ChangeNums adds={f.adds} dels={f.dels} />}
                    </button>
                  ))}
                </div>
              ))}
              {scope === 'session' && <div className="ct-note ct-rv-listnote">{t('changes.review.sessionNote')}</div>}
            </nav>
            <div>
              {groups.flatMap(([dir, fs]) => fs.map((f) => (
                <section key={f.path} className="ct-rv-file" data-rv-file={f.path}>
                  <div className="ct-rv-fh">
                    {fileIcon(f)}<b>{f.name}</b>{dir && <span className="dir">{dir}</span>}<FileTags f={f} />
                    {!f.reverted && <ChangeNums adds={f.adds} dels={f.dels} />}
                    <span className="sp" />
                    {f.kind !== 'deleted' && (
                      <button type="button" className="ct-act" onClick={() => openChangedFile(sid, f.path)}><ExternalLink size={12} />{t('changes.open')}</button>
                    )}
                    {canUndo && undoable(f) && (
                      <button type="button" className="ct-act" disabled={running}
                        onClick={() => setConfirm({ files: [f], title: t('changes.confirm.fileTitle', { name: f.name }) })}>
                        <Undo2 size={12} />{t('changes.undo')}
                      </button>
                    )}
                  </div>
                  {f.patch
                    ? <FileDiff patch={f.patch} prose={isProsePath(f.path)} truncated={f.truncated} createdHead={f.kind === 'created' ? 7 : undefined} />
                    : <div className="ct-note">{t(whyKey(f))}</div>}
                </section>
              )))}
              <div className="ct-rv-cmd">
                <Terminal size={14} className="ct-ic" />
                <span>
                  {scope === 'git' ? t('changes.git.note') : `${t('changes.note.scope')} ${t('changes.cmd.hint')}`}
                  {scope === 'git' && git?.truncatedFiles && <> {t('changes.git.truncated')}</>}
                </span>
              </div>
            </div>
          </div>
        )}

      {confirm && since != null && (
        <UndoConfirm title={confirm.title} message={t(scope === 'session' ? 'changes.confirm.msgSession' : 'changes.confirm.msg')} files={confirm.files} cwd={cwd}
          onClose={() => setConfirm(null)}
          onConfirm={() => { const fs = confirm.files; setConfirm(null); void undoChanges(sid, since, fs.map((x) => x.path)) }} />
      )}
    </div>
  )
}
