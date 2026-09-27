/** 作品卡(```forsion-creation,2026-09-27):agent 提议把这条对话里做的东西变成「造物」,用户点了宿主才动手 ——
 *   无 path = 做成作品:在托管根建文件夹 → 把这条会话挪进去 → 替用户发一句「接着做」,agent 下一轮就在作品文件夹里写;
 *   有 path = 加入造物:把会话工作目录里那个文件夹**复制**进托管根 → 会话挪到复制品(原文件夹不动)。
 * 完成态不另存:会话的工作目录已经是托管根的直接子目录 = 已在造物里(重载后自然还是完成态)。
 * 私聊 / 独立团队 / Chat 预设的会话挪不动(工作目录被身份锁住或没有本机文件工具)→ 退化成在作品里开一个新对话。
 * 只有桌面端渲染(按钮要宿主 IPC);卡片里的 path 是模型写的,先经 resolveInside 限定在会话工作目录内。 */
import { useEffect, useState } from 'react'
import { AppWindow, Code2, FolderInput, Loader2, Sparkles } from 'lucide-react'
import { setActiveSpace } from '@lcl/engine'
import { registerMessages, translate, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useCodeStudio } from '../../stores/codeStudioStore'
import { normPath } from '../coding/studioModel'
import { resolveInside } from './creationPath'
import type { CreationCard } from './suggest'

registerMessages({
  'creation.card.createTitle': { zh: '做成作品：{name}', en: 'Make it a creation: {name}' },
  'creation.card.createBody': {
    zh: '在「造物」里给它建一个文件夹，把这条对话的工作目录切过去，接着在里面做。之后它会出现在造物里，有稳定的预览、桌面快捷方式和版本历史。',
    en: 'Creates a folder for it in Creations, moves this conversation into that folder and keeps building there. It then shows up in Creations with a stable preview, a desktop shortcut and version history.',
  },
  'creation.card.addTitle': { zh: '加入造物：{name}', en: 'Add to Creations: {name}' },
  'creation.card.addBody': {
    zh: '把「{path}」复制进造物（不带 .git 和 node_modules），这条对话之后改的是复制品，原文件夹保留不动。',
    en: 'Copies “{path}” into Creations (without .git and node_modules). From then on this conversation works on the copy; the original folder stays as it is.',
  },
  'creation.card.create': { zh: '做成作品', en: 'Make it a creation' },
  'creation.card.add': { zh: '加入造物', en: 'Add to Creations' },
  'creation.card.done': { zh: '已在造物里：{name}', en: 'In Creations: {name}' },
  'creation.card.doneNewChat': {
    zh: '已在造物里建好「{name}」，并在它里面开了一个新对话（这条对话的工作目录不能换）。',
    en: 'Created “{name}” in Creations and opened a new conversation in it (this conversation cannot change its working folder).',
  },
  'creation.card.openStudio': { zh: '在编码工作室中打开', en: 'Open in Coding Studio' },
  'creation.card.openCreations': { zh: '在造物中查看', en: 'View in Creations' },
  'creation.continuePrompt': {
    zh: '作品文件夹「{name}」已经建好，这条对话的工作目录已经切过去了。请在这里接着做。',
    en: 'The creation folder “{name}” is ready and this conversation now works in it. Please continue building here.',
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
  'creation.err.too_large': {
    zh: '文件夹太大（超过 5000 个文件或 500 MB），没有复制。',
    en: 'The folder is too large (over 5,000 files or 500 MB), so nothing was copied.',
  },
})

/** 把一个文件夹复制进造物(不带 .git / node_modules);失败抛出已翻译的原因。作品卡与 PROJECT 详情共用。 */
export async function adoptIntoCreations(source: string, name: string): Promise<{ dir: string; name: string }> {
  const r = await window.tangu!.productsAdopt!(source, name)
  if (!r.ok) throw new Error(translate(`creation.err.${r.code}`))
  return { dir: r.dir, name: r.name }
}

export function CreationCards({ cards, sessionId }: { cards: CreationCard[]; sessionId?: string }) {
  if (!cards.length || !window.tangu?.productsCreate || !window.tangu?.productsAdopt) return null
  return <div className="t2-tasks">{cards.map((card, i) => <CreationCardView key={`${i}:${card.name}:${card.path || ''}`} card={card} sessionId={sessionId} />)}</div>
}

function CreationCardView({ card, sessionId }: { card: CreationCard; sessionId?: string }) {
  const { t } = useI18n()
  const session = useApp((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined))
  const configCwd = useApp((s) => (sessionId ? s.configBySession[sessionId]?.cwd : undefined))
  const defaultWs = useApp((s) => s.defaultWsDir)
  const cwd = configCwd || session?.project_path || ''
  const [root, setRoot] = useState('')
  useEffect(() => {
    let alive = true
    void window.tangu?.codeProjectsRoot?.().then((r) => { if (alive) setRoot(r || '') }).catch(() => {})
    return () => { alive = false }
  }, [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [made, setMade] = useState<{ dir: string; name: string; moved: boolean } | null>(null)
  const adding = !!card.path
  const inCreation = !!root && !!cwd && normPath(cwd).replace(/\/[^/]*$/, '') === normPath(root)
  // 整个工作目录加入造物只对真项目放行;默认工作区是所有不在项目里的对话共用的大目录
  const source = adding ? resolveInside(cwd, card.path!, !!cwd && normPath(cwd) !== normPath(defaultWs || '')) : null
  const done = made ?? (inCreation ? { dir: cwd, name: session?.project_name || card.name, moved: true } : null)

  const accept = async (): Promise<void> => {
    const api = window.tangu
    if (!api?.productsCreate || !api.productsAdopt || busy) return
    setBusy(true); setError('')
    try {
      let dir: string
      let name: string
      if (adding) {
        if (!source) throw new Error(t('creation.err.outside'))
        ;({ dir, name } = await adoptIntoCreations(source, card.name))
      } else {
        const r = await api.productsCreate(card.name)
        dir = r.dir; name = r.name
      }
      const app = useApp.getState()
      const moved = sessionId ? await app.moveSessionToProject(sessionId, dir, name) : false
      if (!moved) { app.setNewChatWs({ key: dir, name, kind: 'local', path: dir }); app.setActiveId(null) }
      setMade({ dir, name, moved })
      // 新做的作品:点按钮就是「好,做成作品」—— 替用户接一句,agent 下一轮就在作品文件夹里写(新的 cwd 在系统提示里)
      if (moved && !adding && sessionId) void app.send(t('creation.continuePrompt', { name }), [], undefined, undefined, undefined, sessionId)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally { setBusy(false) }
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
      ) : adding && !source ? (
        <div className="t2-taskcard-done" role="alert">{t('creation.err.outside')}</div>
      ) : (
        <div className="t2-taskcard-actions">
          <button className="primary" disabled={busy} onClick={() => void accept()} data-creation-accept>
            {busy ? <Loader2 size={12} className="spin" /> : adding ? <FolderInput size={12} /> : <Sparkles size={12} />} {t(adding ? 'creation.card.add' : 'creation.card.create')}
          </button>
        </div>
      )}
      {error && <div className="t2-taskcard-done" role="alert" data-creation-error>{error}</div>}
    </div>
  )
}
