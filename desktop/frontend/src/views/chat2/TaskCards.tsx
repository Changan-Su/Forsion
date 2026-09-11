/** 任务卡(```forsion-task)的渲染 + 落点按钮 —— 聊天(EditorialMessage)与收件箱(InboxBody)共用这一份。
 *  卡片本身什么也不做,点了才经 onTask 发消息 / 建 Muse 日程;做成了定格成「已…」(失败保留按钮)。
 *  任务书默认折叠但**必须可展开**:点下去发出的是任务书而不是标题,不能让用户看不见自己在同意什么。 */
import { useState } from 'react'
import { ClipboardList, ChevronDown, ChevronRight, MessageSquarePlus, Play, Sparkles, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { TaskCard } from './suggest'
import './chat2.css'

/** 任务卡落点:在此执行 / 新会话执行 / 交给 Muse 追踪 / 忽略(spawn_task 的 worktree、云端两档刻意不搬)。 */
export type TaskLanding = 'here' | 'new' | 'muse' | 'ignore'

/** 已处理的任务卡(模块级,活到应用关闭):切走再切回来组件重挂,卡片不能又长出按钮 —— 那是第二次建同一条日程的入口。
 *  键 = 归属 id(消息 id)+ 卡序 + 内容哈希(重新生成 / 重排后内容不同就不算同一张)。 */
const handledTaskCards = new Map<string, TaskLanding>()
/** 进行中的卡(模块级):同一会话分屏 / 新标签挂了两份视图时,一处点了另一处也必须拒绝 —— busy 是组件私有状态挡不住(Codex 09-11 P1)。 */
const inFlightTaskCards = new Set<string>()
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
export function taskCardKey(ownerId: string, index: number, c: TaskCard): string {
  return `${ownerId}:${index}:${hashStr(`${c.title}|${c.prompt}`)}`
}

export function TaskCards({ tasks, ownerId, onTask, noHere = false }: {
  tasks: TaskCard[]
  /** 卡片归属(消息 id):定格记录按它 + 卡序 + 内容哈希索引。 */
  ownerId: string
  /** 返回 false = 没做成(卡片保留按钮);其余(true / void)= 做成,卡片定格。 */
  onTask?: (card: TaskCard, landing: TaskLanding) => boolean | void | Promise<boolean | void>
  /** 收件箱没有当前会话:不给「在此执行」。 */
  noHere?: boolean
}) {
  const { t } = useI18n()
  // 任务卡各自一次性:做成了才定格成「已…」(失败保留按钮),busy 期间按钮禁用 —— 防双击把同一任务书发两遍 / 建两条日程。
  const [taskDone, setTaskDone] = useState<Record<string, TaskLanding>>({})
  const [taskBusy, setTaskBusy] = useState<string | null>(null)
  const [taskOpen, setTaskOpen] = useState<Record<string, boolean>>({})
  if (!tasks.length) return null
  return (
    <div className="t2-tasks">
      {tasks.map((c, i) => {
        const key = taskCardKey(ownerId, i, c)
        const done = taskDone[key] ?? handledTaskCards.get(key)
        const busy = taskBusy === key
        const open = !!taskOpen[key]
        // Muse 落点只在本地引擎在场时给(Web/移动端没有 /agent/special 端点,按钮只会失败)。
        const museOk = !!window.tangu?.backendStatus
        const pick = async (landing: TaskLanding): Promise<void> => {
          if (busy || done || inFlightTaskCards.has(key) || handledTaskCards.has(key)) return
          inFlightTaskCards.add(key)
          setTaskBusy(key)
          let ok = false
          try { ok = (await onTask?.(c, landing)) !== false } catch { ok = false }
          inFlightTaskCards.delete(key)
          setTaskBusy((b) => (b === key ? null : b))
          if (ok) { handledTaskCards.set(key, landing); setTaskDone((p) => ({ ...p, [key]: landing })) }
        }
        const btn = (landing: TaskLanding, icon: React.ReactNode, label: string, primary = false): React.ReactNode => (
          <button key={landing} className={primary ? 'primary' : ''} disabled={busy} onClick={() => void pick(landing)}>{icon} {label}</button>
        )
        // 收件箱(noHere)没有当前会话:不给「在此执行」,主按钮顺延给「新会话执行」。
        const here = noHere ? null : btn('here', <Play size={12} />, t('chat.task.here'), !(c.track && museOk))
        const fresh = btn('new', <MessageSquarePlus size={12} />, t('chat.task.new'), noHere && !(c.track && museOk))
        const muse = museOk ? btn('muse', <Sparkles size={12} />, t('chat.task.muse'), !!c.track) : null
        const doneKey = done === 'here' ? 'chat.task.doneHere' : done === 'new' ? 'chat.task.doneNew' : done === 'muse' ? 'chat.task.doneMuse' : 'chat.task.doneIgnore'
        return (
          <div key={key} className={`t2-taskcard${done ? ' done' : ''}${busy ? ' busy' : ''}`}>
            <div className="t2-taskcard-head">
              <ClipboardList size={13} /> <b>{c.title}</b>
              {c.track && <span className="t2-taskcard-tag">{t('chat.task.trackTag')}</span>}
            </div>
            {c.tldr && <div className="t2-taskcard-tldr">{c.tldr}</div>}
            <button className="t2-taskcard-toggle" onClick={() => setTaskOpen((p) => ({ ...p, [key]: !open }))} aria-expanded={open}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t(open ? 'chat.task.hidePrompt' : 'chat.task.showPrompt')}
            </button>
            {open && <pre className="t2-taskcard-prompt">{c.prompt}</pre>}
            {done
              ? <div className="t2-taskcard-done">{t(doneKey)}</div>
              : (
                <div className="t2-taskcard-actions">
                  {c.track && museOk ? [muse, here, fresh] : [here, fresh, muse]}
                  {btn('ignore', <X size={12} />, t('chat.task.ignore'))}
                </div>
              )}
          </div>
        )
      })}
    </div>
  )
}
