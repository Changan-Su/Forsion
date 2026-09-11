/** 收件箱正文 = 真 Amadeus 只读页(2026-09-11,用户拍板「消息阅读」接入工作区形式):
 *  `<UnifiedPage readOnly compact initial={text}>` 吃字符串,不经 pageStore / vault 桥(与 MuseLibraryView 同一条路);
 *  于是笔记里有的它都有 —— 表格 / callout / 数学 / `![[…]]` 嵌入(图片、PDF、音视频、数据库、画板、跨笔记)/「按钮」块。
 *  compact 去掉封面与属性面板;页面标题(=合成路径的 basename)由 inbox.css 隐掉,标题仍是阅读面板自己的 <h1>。
 *  路径是合成的 `inbox/<id>.md`:库里不存在,挂载补读经桥返回 null 被忽略;readOnly 挡住所有写(与分享页同两道闸)。
 *  旧版按块切分、`![[…]]` 走自家嵌入卡、其余走 react-markdown 的那套(含「网址一律书签卡、导图只给打开卡」的刻意分道)
 *  整份退役 —— 阅读面板一次只显示一封,不再是流。已知缺口:思维导图 / 插件文件嵌入现在经 PluginEmbed 渲染在库外页上,未实测。
 *
 *  消息末尾的两种围栏摘出来单独渲染成卡(与聊天同一套解析 splitSuggestions,`kinds` 只认这两种):
 *    ```forsion-task     任务卡(TaskCards;落点:新会话执行 / 交给 Muse / 忽略 —— 收件箱没有当前会话,不给「在此执行」)
 *    ```forsion-approval 审批卡:只带 pending_approvals 行 id,工具 / 预览 / 理由按 id 从引擎读,**正文里的字一个不信**
 *  **信任闸**:卡只对「本地引擎发来的 agent 消息」渲染;服务端广播 / 系统消息里的同名围栏一律按普通代码块显示 ——
 *  防远端往用户面前放一个「执行」按钮。suggest 芯片不认(没处发),原样留在正文。
 *  「按钮」块(forsion-button)无需闸:它只能引用本机已保存的手动自动化规则(见 ButtonBlock 头注),外来消息里的按钮找不到规则就是废按钮。 */
import { Suspense, useEffect, useMemo, useState } from 'react'
import { ShieldCheck, ShieldX } from 'lucide-react'
import { lazyRetry } from '../../lazyRetry'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { setActiveSpace } from '@lcl/engine'
import { getMuseApproval, decideMuseApproval, type InboxMessage } from '../../services/backendService'
import type { PendingApprovalInfo } from '../../types'
import { splitSuggestions } from '../chat2/suggest'
import { TaskCards } from '../chat2/TaskCards'
import { runTaskCard } from '../chat2/taskLanding'

const UnifiedPageLazy = lazyRetry(() => import('@amadeus/unified/UnifiedPage').then((m) => ({ default: m.UnifiedPage })))

/** 卡片只信本地引擎发来的 agent 消息(与聊天任务卡的 museOk 同一道闸:Web / 移动端没有 /agent/special 端点)。 */
export function inboxCardsAllowed(msg: Pick<InboxMessage, 'sender_kind'>): boolean {
  return msg.sender_kind === 'agent' && !!window.tangu?.backendStatus
}

export function InboxBody({ msg }: { msg: InboxMessage }) {
  const body = msg.body || ''
  const cardsOk = inboxCardsAllowed(msg)
  const parsed = useMemo(() => (cardsOk ? splitSuggestions(body, { kinds: ['task', 'approval'] }) : null), [body, cardsOk])
  const text = parsed ? parsed.text : body
  const hasCards = !!parsed && (parsed.tasks.length > 0 || parsed.approvals.length > 0)
  return (
    <>
      {text.trim() && (
        <div className="am-app tangu-lovable amx-pane amx-editor ibx-amadeus" data-inbox-body="amadeus">
          <Suspense fallback={<div className="ibx-body-plain">{text}</div>}>
            <UnifiedPageLazy key={msg.id} path={`inbox/${msg.id}.md`} initial={text} readOnly compact />
          </Suspense>
        </div>
      )}
      {hasCards && (
        <div className="ibx-cards" data-inbox-cards>
          {parsed!.approvals.map((id) => <ApprovalCard key={id} id={id} />)}
          <TaskCards
            tasks={parsed!.tasks}
            ownerId={msg.id}
            noHere
            onTask={(card, landing) => {
              // 收件箱在自己的 Space 里:新会话必须先切到 Tangu Space,否则聊天开在收件箱布局里(同 InboxReaderView.chatWithSender)。
              if (landing === 'new') setActiveSpace('tangu')
              return runTaskCard(card, landing, null)
            }}
          />
        </div>
      )}
    </>
  )
}

/** 审批卡:按 id 读 pending_approvals 行渲染(消息正文只是信封);批准 / 拒绝直接调引擎,决定后定格显示结果。
 *  状态:loading → row(pending / executing / 终态)| missing(引擎 404)| error(读失败,可重试);executing 每 3s 重拉直到终态;
 *  决定失败(409 = 别处已裁决 / 网络)→ 按 id 重拉,不把陈腐的 pending 按钮留在屏上(Codex 09-11 P1)。 */
function ApprovalCard({ id }: { id: string }) {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const [row, setRow] = useState<PendingApprovalInfo | null | 'loading' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    getMuseApproval(cfg, id)
      .then((r) => { if (alive) setRow(r ?? null) })
      // 只把本端点自己的 404 文案当「不存在」;别的 404(老引擎还没重启、没有这条路由)/ 网络错都是「读失败」,给重试而不是谎报记录没了。
      .catch((e: any) => { if (alive) setRow(/approval not found/i.test(String(e?.message || e)) ? null : 'error') })
    return () => { alive = false }
  }, [cfg, id, tick])
  const refresh = (): void => setTick((n) => n + 1)
  // 执行中(别处批准了、工具还在跑):轮询到终态为止。
  const executing = row !== 'loading' && row !== 'error' && row?.status === 'executing'
  useEffect(() => {
    if (!executing) return
    const h = setTimeout(refresh, 3000)
    return () => clearTimeout(h)
  }, [executing, tick])

  const decide = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (row === 'loading' || row === 'error' || !row || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await decideMuseApproval(cfg, row.id, decision)
      // 200 也可能是「批准了但工具执行失败」(status=failed,result=错误文本):不能静默当成功。
      setRow({ ...row, status: r.status as PendingApprovalInfo['status'], result: r.result ?? row.result, decided_by: 'user' })
      if (r.status === 'failed') setErr(t('special.muse.execFailed', { e: String(r.result || '').slice(0, 200) }))
    } catch (e: any) {
      setErr(t('special.muse.approveFail', { e: e?.message || String(e) }))
      refresh() // 409(别处已裁决)/ 网络错:以引擎里的真状态为准
    } finally {
      setBusy(false)
    }
  }

  // 理由(escalate / mode / custom-ask 的规则串)是引擎写的 JSON;坏了不影响卡。
  let reason = ''
  if (row && row !== 'loading' && row !== 'error' && row.reason) {
    try { const o = JSON.parse(row.reason); reason = o?.kind === 'custom-ask' && o.rule ? String(o.rule) : String(o?.kind || '') } catch { /* ignore */ }
  }
  const status = row === 'loading' ? 'loading' : row === 'error' ? 'error' : row ? row.status : 'missing'
  const doneKey = status === 'rejected' ? 'inbox.approval.rejected' : status === 'executing' ? 'inbox.approval.executing' : status === 'failed' ? 'inbox.approval.failed' : 'inbox.approval.approved'
  const settled = row && row !== 'loading' && row !== 'error' && row.status !== 'pending'
  return (
    <div className={`t2-taskcard ibx-approval${settled ? ' done' : ''}`} data-approval-id={id} data-approval-status={status}>
      <div className="t2-taskcard-head"><ShieldCheck size={13} /> <b>{t('inbox.approval.title')}</b></div>
      {row === 'loading' ? (
        <div className="ibx-approval-meta">{t('inbox.approval.loading')}</div>
      ) : row === 'error' ? (
        <div className="t2-taskcard-actions">
          <span className="ibx-approval-err">{t('inbox.approval.loadFail')}</span>
          <button onClick={refresh}>{t('inbox.approval.retry')}</button>
        </div>
      ) : !row ? (
        <div className="ibx-approval-meta">{t('inbox.approval.missing')}</div>
      ) : (
        <>
          <div className="ibx-approval-preview">{row.preview}</div>
          <div className="ibx-approval-meta">{row.tool}{row.cwd ? ` · ${row.cwd}` : ''}{reason ? ` · ${reason}` : ''}</div>
          {row.note && <div className="ibx-approval-meta">{t('special.muse.approvalNote', { note: row.note })}</div>}
          {row.status === 'pending' ? (
            <div className="t2-taskcard-actions">
              <button className="primary" disabled={busy} onClick={() => void decide('approve')}><ShieldCheck size={12} /> {t('special.muse.approve')}</button>
              <button disabled={busy} onClick={() => void decide('reject')}><ShieldX size={12} /> {t('special.muse.reject')}</button>
            </div>
          ) : (
            <div className="t2-taskcard-done">{t(doneKey)}</div>
          )}
          {row.status !== 'pending' && row.result && <pre className="ibx-approval-result">{row.result}</pre>}
          {err && <div className="ibx-approval-err">{err}</div>}
        </>
      )}
    </div>
  )
}
