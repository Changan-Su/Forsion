/** 作品卡(```forsion-creation,2026-09-27):agent 提议把这条对话里做的东西变成「造物」,用户点了宿主才动手 ——
 *   无 path = 做成作品:在托管根建文件夹 → 把这条会话挪进去 → 替用户发一句「接着做」,agent 下一轮就在作品文件夹里写;
 *   有 path = 加入造物:把会话工作目录里那个文件夹**原地**加入造物(不复制、不移动;宿主侧登记 + 写身份 sidecar),
 *   会话的工作目录切到它(本来就在它里面就不用切)。
 * 完成态不另存:会话的工作目录已经是造物(宿主 products:isCreation 判,只读)= 已在造物里(重载后自然还是完成态)。
 * 私聊 / 独立团队 / Chat 预设的会话挪不动(工作目录被身份锁住或没有本机文件工具)→ 退化成在作品里开一个新对话。
 * 只有桌面端渲染(按钮要宿主 IPC);卡片里的 path 是模型写的,先经 resolveInside 限定在会话工作目录内。 */
import { useEffect, useState } from 'react'
import { AppWindow, ArrowDown, Check, Code2, FolderInput, Loader2, Sparkles, X } from 'lucide-react'
import { setActiveSpace } from '@lcl/engine'
import { registerMessages, translate, useI18n } from '../../i18n'
import { lockSessionMove, unlockSessionMove, useApp } from '../../stores/appStore'
import { useCodeStudio } from '../../stores/codeStudioStore'
import { normPath } from '../coding/studioModel'
import { resolveInside } from './creationPath'
import type { CreationCard } from './suggest'
import { creationDoneKey, markTaskHandled, taskHandled, useTaskHandledVersion, TASK_CARD_TTL_MS } from './pendingTasks'

registerMessages({
  'creation.card.createTitle': { zh: '做成作品：{name}', en: 'Make it a creation: {name}' },
  'creation.card.createBody': {
    zh: '在「造物」里给它建一个文件夹，把这条对话的工作目录切过去，接着在里面做。之后它会出现在造物里，有稳定的预览、桌面快捷方式和版本历史。',
    en: 'Creates a folder for it in Creations, moves this conversation into that folder and keeps building there. It then shows up in Creations with a stable preview, a desktop shortcut and version history.',
  },
  'creation.card.addTitle': { zh: '加入造物：{name}', en: 'Add to Creations: {name}' },
  'creation.card.addBody': {
    zh: '把「{path}」原地加入造物，不复制也不移动。这条对话之后在它里面继续，它会出现在造物里，有稳定的预览和桌面快捷方式。',
    en: 'Adds “{path}” to Creations where it is, without copying or moving it. This conversation continues in it, and it shows up in Creations with a stable preview and a desktop shortcut.',
  },
  'creation.card.create': { zh: '做成作品', en: 'Make it a creation' },
  'creation.card.add': { zh: '加入造物', en: 'Add to Creations' },
  'creation.card.done': { zh: '已在造物里：{name}', en: 'In Creations: {name}' },
  'creation.card.doneNewChat': {
    zh: '已在造物里建好「{name}」。这条对话没有挪过去，已切到在它里面新建对话。',
    en: 'Created “{name}” in Creations. This conversation was not moved there, so a new conversation in it is ready.',
  },
  'creation.card.openStudio': { zh: '在编码工作室中打开', en: 'Open in Coding Studio' },
  'creation.card.openCreations': { zh: '在造物中查看', en: 'View in Creations' },
  'creation.card.dismiss': { zh: '不用了', en: 'No thanks' },
  'creation.card.dismissed': { zh: '不用了', en: 'Dismissed' },
  'creation.card.made': { zh: '已做成作品', en: 'Made into a creation' },
  'creation.card.inDeck': { zh: '作品卡「{name}」· 在对话最下面', en: 'Creation card “{name}” · at the end of the chat' },
  'creation.card.traceMade': { zh: '作品卡「{name}」· 已做成作品', en: 'Creation card “{name}” · made' },
  'creation.card.traceDismissed': { zh: '作品卡「{name}」· 不用了', en: 'Creation card “{name}” · dismissed' },
  'creation.card.traceIn': { zh: '作品卡「{name}」· 已在造物里', en: 'Creation card “{name}” · in Creations' },
  'creation.continuePrompt': {
    zh: '作品文件夹「{name}」已经建好，这条对话的工作目录已经切过去了。请在这里接着做。',
    en: 'The creation folder “{name}” is ready and this conversation now works in it. Please continue building here.',
  },
  'creation.err.running': {
    zh: '这条对话还在运行，等这一轮结束再点。',
    en: 'This conversation is still running. Try again when this turn has finished.',
  },
  'creation.err.outside': {
    zh: '卡片里的文件夹不在这条对话的工作目录里，不能从这里加入。',
    en: 'The folder in this card is outside this conversation’s working folder, so it cannot be added from here.',
  },
  'creation.err.invalid_source': { zh: '找不到要加入的文件夹。', en: 'The folder to add was not found.' },
  'creation.err.forbidden_source': {
    zh: '这个文件夹不能加入造物（比如家目录、造物自己的文件夹这类位置）。',
    en: 'This folder cannot be added to Creations (for example your home folder or the Creations folder itself).',
  },
  'creation.err.nested': {
    zh: '这个文件夹在另一个造物里面，或者里面已经有造物了，不能再单独加入。',
    en: 'This folder is inside another creation, or already contains one, so it cannot be added on its own.',
  },
})

/** 把一个文件夹原地加入造物(不复制、不移动);失败抛出已翻译的原因。作品卡与 PROJECT 详情共用。
 *  within / strict:宿主按真实路径判「源在这个目录里(strict = 且不是它本身)」—— 字符串判定挡不住里面指向别处的软链。 */
export async function addToCreations(source: string, within: string, strict: boolean): Promise<{ dir: string; name: string }> {
  const r = await window.tangu!.productsRegister!(source, within, strict)
  if (!r.ok) throw new Error(translate(`creation.err.${r.code}`))
  return { dir: r.dir, name: r.name }
}

/** 作品卡只有桌面端画(按钮要宿主 IPC)。 */
export const creationCardsSupported = (): boolean => !!(window.tangu?.productsCreate && window.tangu?.productsRegister)

/** 会话的工作目录,以及它是不是已经是造物(宿主 products:isCreation 判,只读)—— 是的话这条会话里的作品卡都已完成。 */
export function useSessionCreation(sessionId?: string): { cwd: string; inCreation: boolean } {
  // 点过一张作品卡就重查:原地加入的就是工作目录本身(cwd 不变)时,这条会话里别的作品卡也随之完成(Codex 10-23)
  const handledV = useTaskHandledVersion()
  const session = useApp((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined))
  const configCwd = useApp((s) => (sessionId ? s.configBySession[sessionId]?.cwd : undefined))
  const cwd = configCwd || session?.project_path || ''
  const [inCreation, setInCreation] = useState(false)
  useEffect(() => {
    let alive = true
    setInCreation(false)
    if (cwd) void window.tangu?.productsIsCreation?.(cwd).then((v) => { if (alive) setInCreation(!!v) }).catch(() => {})
    return () => { alive = false }
  }, [cwd, handledV])
  return { cwd, inCreation }
}

/** 10-23 起作品卡是交互卡片:有对话末尾卡片堆的视图里(onJump),还没做成 / 没点「不用了」的进卡片堆,
 *  流里原处每张只留一行(指过去,或结局);过了 7 天的不进卡片堆,原处照旧摆整张。 */
export function CreationCards({ cards, sessionId, onJump, createdAt }: { cards: CreationCard[]; sessionId?: string; onJump?: () => void; createdAt?: number }) {
  if (!cards.length || !creationCardsSupported()) return null
  if (onJump && sessionId && (!createdAt || Date.now() - createdAt <= TASK_CARD_TTL_MS)) return <CreationTraces cards={cards} sessionId={sessionId} onJump={onJump} />
  return <div className="t2-tasks">{cards.map((card, i) => <CreationCardView key={`${i}:${card.name}:${card.path || ''}`} card={card} sessionId={sessionId} />)}</div>
}

function CreationTraces({ cards, sessionId, onJump }: { cards: CreationCard[]; sessionId: string; onJump: () => void }) {
  const { t } = useI18n()
  useTaskHandledVersion()
  const { inCreation } = useSessionCreation(sessionId)
  return (
    <div className="t2-tasks t2-tasks--trace">
      {cards.map((card, i) => {
        const key = `${i}:${card.name}:${card.path || ''}`
        const rec = taskHandled(creationDoneKey(sessionId, card))
        if (rec || inCreation) {
          const made = rec?.landing !== 'ignore'
          return (
            <div key={key} className="t2-dim t2-tasktrace" data-creation-trace={made ? 'made' : 'dismissed'}>
              {made ? <Check size={13} /> : <X size={13} />}
              <span>{t(!rec ? 'creation.card.traceIn' : made ? 'creation.card.traceMade' : 'creation.card.traceDismissed', { name: card.name })}</span>
              {made && <button type="button" className="t2-taskcard-toggle" onClick={() => setActiveSpace('artificial')}>{t('creation.card.openCreations')}</button>}
            </div>
          )
        }
        return (
          <button key={key} type="button" className="t2-dim t2-tasktrace t2-tasktrace-jump" data-creation-trace="pending" onClick={onJump}>
            <Sparkles size={13} /><span>{t('creation.card.inDeck', { name: card.name })}</span><ArrowDown size={12} />
          </button>
        )
      })}
    </div>
  )
}

export function CreationCardView({ card, sessionId }: { card: CreationCard; sessionId?: string }) {
  const { t } = useI18n()
  useTaskHandledVersion()
  const session = useApp((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined))
  const defaultWs = useApp((s) => s.defaultWsDir)
  const { cwd, inCreation } = useSessionCreation(sessionId)
  const doneKey = sessionId ? creationDoneKey(sessionId, card) : ''
  const rec = doneKey ? taskHandled(doneKey) : undefined
  const dismissed = rec?.landing === 'ignore'
  // 记过「做成了」的(没挪成、已切到新对话那种,工作目录不是造物):定格,不再给按钮 —— 再点会多建一个作品(Codex 10-23)
  const recordedMade = rec?.landing === 'here'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [made, setMade] = useState<{ dir: string; name: string; moved: boolean } | null>(null)
  const adding = !!card.path
  // 整个工作目录加入造物只对真项目放行;默认工作区是所有不在项目里的对话共用的大目录
  const allowSelf = !!cwd && normPath(cwd) !== normPath(defaultWs || '')
  const source = adding ? resolveInside(cwd, card.path!, allowSelf) : null
  const done = made ?? (inCreation ? { dir: cwd, name: session?.project_name || card.name, moved: true } : null)

  const accept = async (): Promise<void> => {
    const api = window.tangu
    if (!api?.productsCreate || !api.productsRegister || busy) return
    setBusy(true); setError('')
    // 跑着 / 正在发送 / 另一张作品卡正在挪它的时候不动:agent 正往原目录写,挪过去续话还会被当成插话塞进这一轮。
    // 占住之后到挪完(含复制那几秒)这条会话发不了新消息
    if (sessionId && (useApp.getState().runningBySession[sessionId] || !lockSessionMove(sessionId))) { setError(t('creation.err.running')); setBusy(false); return }
    let moved = false
    let created = ''
    try {
      let dir: string
      let name: string
      if (adding) {
        if (!source) throw new Error(t('creation.err.outside'))
        ;({ dir, name } = await addToCreations(source, cwd, !allowSelf))
      } else {
        const r = await api.productsCreate(card.name)
        dir = r.dir; name = r.name
      }
      const app = useApp.getState()
      // 原地加入的就是会话自己的工作目录:本来就在里面,不用挪
      const here = !!cwd && normPath(dir) === normPath(cwd)
      moved = here || (sessionId ? (await app.moveSessionToProject(sessionId, dir, name)) === 'moved' : false)
      if (!moved) { app.setNewChatWs({ key: dir, name, kind: 'local', path: dir }); app.setActiveId(null) }
      setMade({ dir, name, moved })
      created = name
      if (doneKey) markTaskHandled(doneKey, 'here') // 卡片堆据此把它拿走,流里那行写结局
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      if (sessionId) unlockSessionMove(sessionId)
      setBusy(false)
    }
    // 新做的作品:点按钮就是「好,做成作品」—— 替用户接一句,agent 下一轮就在作品文件夹里写(新的 cwd 在系统提示里)
    if (moved && !adding && sessionId) void useApp.getState().send(t('creation.continuePrompt', { name: created }), [], undefined, undefined, undefined, sessionId)
  }
  const openStudio = (): void => {
    if (!done) return
    setActiveSpace('coding')
    requestAnimationFrame(() => { useCodeStudio.getState().openProject(done.dir, done.name) })
  }

  return (
    <div className={`t2-taskcard t2-creationcard${done ? ' done' : ''}${busy ? ' busy' : ''}`} data-creation-card={adding ? 'add' : 'create'}>
      <div className="t2-taskcard-head">{adding ? <FolderInput size={13} /> : <Sparkles size={13} />} <b>{t(adding ? 'creation.card.addTitle' : 'creation.card.createTitle', { name: card.name })}</b></div>
      <div className="t2-taskcard-tldr">{t(adding ? 'creation.card.addBody' : 'creation.card.createBody', { path: card.path || '' })}</div>
      {done ? (
        <div className="t2-taskcard-done" data-creation-done>
          {t(done.moved ? 'creation.card.done' : 'creation.card.doneNewChat', { name: done.name })}
          <div className="t2-taskcard-actions">
            <button onClick={openStudio}><Code2 size={12} /> {t('creation.card.openStudio')}</button>
            <button onClick={() => setActiveSpace('artificial')}><AppWindow size={12} /> {t('creation.card.openCreations')}</button>
          </div>
        </div>
      ) : dismissed ? (
        <div className="t2-taskcard-done" data-creation-dismissed>{t('creation.card.dismissed')}</div>
      ) : recordedMade ? (
        <div className="t2-taskcard-done" data-creation-done>
          {t('creation.card.made')}
          <div className="t2-taskcard-actions"><button onClick={() => setActiveSpace('artificial')}><AppWindow size={12} /> {t('creation.card.openCreations')}</button></div>
        </div>
      ) : (
        <>
          {adding && !source && <div className="t2-taskcard-done" role="alert">{t('creation.err.outside')}</div>}
          <div className="t2-taskcard-actions">
            {(!adding || source) && (
              <button className="primary" disabled={busy} onClick={() => void accept()} data-creation-accept>
                {busy ? <Loader2 size={12} className="spin" /> : adding ? <FolderInput size={12} /> : <Sparkles size={12} />} {t(adding ? 'creation.card.add' : 'creation.card.create')}
              </button>
            )}
            {doneKey && <button disabled={busy} onClick={() => markTaskHandled(doneKey, 'ignore')} data-creation-dismiss><X size={12} /> {t('creation.card.dismiss')}</button>}
          </div>
        </>
      )}
      {error && <div className="t2-taskcard-done" role="alert" data-creation-error>{error}</div>}
    </div>
  )
}
