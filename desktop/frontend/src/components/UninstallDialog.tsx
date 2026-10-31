/**
 * 卸载确认框(10-28 手动卸载规范 A + D):确认之前逐项写清每样东西去哪(回收站 / 归档 / 删除 / 保留 / 暂停),
 * 勾选项挂在对应那行下面、缺省不勾;删了之后 6 秒内能撤销,30 天内能在「设置 › 系统 › 回收站」恢复。
 * Agent / 技能 / 插件三类、名册 / 设置 / 商店三个入口都开这一个框。手机(原生外壳)贴底成半屏。
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Box, Clock, Cloud, FolderClosed, Loader2, MessageCircle, Pause, SlidersHorizontal, Sparkles, Users } from 'lucide-react'
import { DialogOverlay } from '@amadeus/components/DialogOverlay'
import { useEscape } from '@amadeus/components/Dialogs'
import { registerMessages, translate, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { panelToast } from './PanelNotice'
import { ipcErrorText } from '../ipcError'
import { homeTarget } from '../services/engine/targets'
import {
  agentUninstallPreview, deleteSkillCatalogEntry, restoreTrashEntry, skillUninstallPreview,
  type AgentUninstallPreview, type SkillUninstallPreview, type TrashEntry,
} from '../services/backendService'

registerMessages({
  'uninstall.trash30': { zh: '回收站 · 30 天', en: 'Trash · 30 days' },
  'uninstall.note': { zh: '30 天内可在「设置 › 回收站」恢复', en: 'Restore within 30 days in Settings › Trash' },
  'uninstall.loading': { zh: '正在清点它留下的东西…', en: 'Checking what it leaves behind…' },
  'uninstall.undo': { zh: '撤销', en: 'Undo' },
  'uninstall.restored': { zh: '已恢复「{name}」', en: 'Restored “{name}”' },
  'uninstall.restoredAs': { zh: '已恢复为「{name}」（原名已被占用）', en: 'Restored as “{name}” (the original name is taken)' },
  'uninstall.restoreFail': { zh: '恢复失败：{e}', en: 'Could not restore: {e}' },
  'uninstall.engineDown': { zh: '本机引擎还没就绪，稍后再卸载。', en: 'The engine on this device is not ready yet. Try uninstalling again in a moment.' },
  'uninstall.reinstalled': { zh: '这个插件又装上了。先卸载新装的那份，再从回收站恢复。', en: 'This plugin is installed again. Uninstall that copy first, then restore it from the Trash.' },
  'uninstall.targetMoved': { zh: '原来的文件夹现在指向别处了，没有恢复进去。', en: 'The original folder now points somewhere else, so nothing was restored into it.' },
  'uninstall.agent.teamBusy': { zh: '它所在的两人团队还有会话在运行，先停掉再删。', en: 'Its two-member team still has a session running. Stop it before deleting.' },
  'uninstall.close': { zh: '关闭', en: 'Close' },
  'uninstall.delete': { zh: '删除', en: 'Delete' },
  'uninstall.keep': { zh: '保留', en: 'Keep' },
  // Agent
  'uninstall.agent.title': { zh: '删除 Agent「{name}」？', en: 'Delete agent “{name}”?' },
  'uninstall.agent.msg': { zh: '它会从名册和侧栏消失。它留下的东西各自去哪：', en: 'It leaves the roster and the sidebar. Here is where everything it leaves behind goes:' },
  'uninstall.agent.msgCloud': { zh: '会从 Agent 名册移除，历史会话保留（只读）。', en: 'It is removed from the agent roster; past sessions are kept (read-only).' },
  'uninstall.agent.default': { zh: '这是默认 Agent，不能删除。先在名册里把别的 Agent 设为默认。', en: 'This is the default agent, so it cannot be deleted. Make another agent the default in the roster first.' },
  'uninstall.agent.muse': { zh: 'Muse 正在启用，先在「设置 › 后台 Agent」关闭 Muse 再删除。', en: 'Muse is on. Turn it off in Settings › Background agents before deleting it.' },
  'uninstall.agent.files': { zh: '定义、记忆与 Library', en: 'Definition, memory and Library' },
  'uninstall.agent.chats': { zh: '历史私聊 · {n} 条', en: 'Past direct chats · {n}' },
  'uninstall.agent.archived': { zh: '归档（只读）', en: 'Archived (read-only)' },
  'uninstall.agent.deleteChats': { zh: '一并删除这些私聊', en: 'Delete these chats too' },
  'uninstall.agent.cloud': { zh: '云端副本', en: 'Cloud copy' },
  'uninstall.agent.cloudSub': { zh: '其他设备下次同步时移除', en: 'Other devices remove it on their next sync' },
  'uninstall.agent.seat': { zh: '团队「{team}」里的成员位', en: 'Member slot in team “{team}”' },
  'uninstall.agent.leave': { zh: '移出团队', en: 'Leave team' },
  'uninstall.agent.dissolve': { zh: '团队「{team}」', en: 'Team “{team}”' },
  'uninstall.agent.dissolveSub': { zh: '只剩一位成员，团队一起放进回收站', en: 'Only one member would be left, so the team goes to the Trash too' },
  'uninstall.agent.automations': { zh: '用它的自动化 · {n} 个', en: 'Automations using it · {n}' },
  'uninstall.agent.pause': { zh: '暂停', en: 'Pause' },
  'uninstall.agent.done': { zh: '已删除 Agent「{name}」', en: 'Agent “{name}” deleted' },
  // 技能
  'uninstall.skill.title': { zh: '删除技能「{name}」？', en: 'Delete skill “{name}”?' },
  'uninstall.skill.revertTitle': { zh: '把「{name}」还原为内置版本？', en: 'Revert “{name}” to the built-in version?' },
  'uninstall.skill.revertMsg': { zh: '这是你改过的内置技能。删掉改过的这一份，内置版本立刻装回来。', en: 'You edited this built-in skill. Your edited copy is removed and the built-in version comes right back.' },
  'uninstall.skill.revert': { zh: '还原为内置版本', en: 'Revert to built-in' },
  'uninstall.skill.edited': { zh: '你改过的这一份', en: 'Your edited copy' },
  'uninstall.skill.builtin': { zh: '内置版本', en: 'Built-in version' },
  'uninstall.skill.reinstall': { zh: '装回', en: 'Reinstalled' },
  'uninstall.skill.pauseOnly': { zh: '这是随 App 或插件带来的技能，不能删除，可以停用。', en: 'This skill ships with the app or a plugin. It cannot be deleted, but you can pause it.' },
  'uninstall.skill.legacy': { zh: '旧名字的技能是只读的。复制成新名字后再管理。', en: 'Skills with old-style names are read-only. Copy it under a new name to manage it.' },
  'uninstall.skill.folder': { zh: '技能文件夹', en: 'Skill folder' },
  'uninstall.skill.picks': { zh: '选了它的 Agent · {names}', en: 'Agents that picked it · {names}' },
  'uninstall.skill.unpick': { zh: '从清单移除', en: 'Unpick' },
  'uninstall.skill.paused': { zh: '停用名单里的记录', en: 'Its entry in the paused list' },
  'uninstall.skill.pausedSub': { zh: '不然以后同名的新技能一装上就是停用的', en: 'Otherwise a new skill with this name starts paused' },
  'uninstall.skill.clear': { zh: '清掉', en: 'Clear' },
  'uninstall.skill.done': { zh: '已删除技能「{name}」', en: 'Skill “{name}” deleted' },
  'uninstall.skill.reverted': { zh: '「{name}」已还原为内置版本', en: '“{name}” is back to the built-in version' },
  // 插件
  'uninstall.plugin.title': { zh: '卸载插件「{name}」？', en: 'Uninstall plugin “{name}”?' },
  'uninstall.plugin.msg': { zh: '插件会停下、从 Space 和设置里消失。它留下的东西各自去哪：', en: 'The plugin stops and leaves your Spaces and Settings. Here is where everything it leaves behind goes:' },
  'uninstall.plugin.confirm': { zh: '卸载', en: 'Uninstall' },
  'uninstall.plugin.files': { zh: '插件文件', en: 'Plugin files' },
  'uninstall.plugin.settings': { zh: '插件的设置与偏好', en: 'Plugin settings and preferences' },
  'uninstall.plugin.keepSettings': { zh: '保留设置，重装后接着用', en: 'Keep settings for a reinstall' },
  'uninstall.plugin.settingsCloud': { zh: '含同步到账号的那份', en: 'Including the copy synced to your account' },
  'uninstall.plugin.vault': { zh: '智库里的 {folder}/', en: '{folder}/ in your vault' },
  'uninstall.plugin.vaultSub': { zh: '你的数据', en: 'Your data' },
  'uninstall.plugin.moveVault': { zh: '一并移到回收站', en: 'Move to Trash too' },
  'uninstall.plugin.skills': { zh: '它带的技能 · {n} 个', en: 'Skills it ships · {n}' },
  'uninstall.plugin.skillsGo': { zh: '随插件进回收站', en: 'Go with the plugin' },
  'uninstall.plugin.agent': { zh: '它带来的 Agent「{name}」', en: 'Agent it added: “{name}”' },
  'uninstall.plugin.agentSub': { zh: '你和它的私聊还在', en: 'Your chats with it are still there' },
  'uninstall.plugin.done': { zh: '已卸载插件「{name}」', en: 'Plugin “{name}” uninstalled' },
})

export const fmtSize = (b: number): string => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`)

export interface UninstallRow {
  icon: ReactNode
  title: string
  sub?: string
  dest: string
  tone?: 'del' | 'keep'
  /** 挂在这行下面的勾选项;勾上后这行的去向换成 checkedDest。 */
  check?: { key: string; label: string; checkedDest?: string; checkedTone?: 'del' | 'keep' }
}

export function UninstallDialog({ title, message, rows, confirmLabel, note, blocked, loading, onConfirm, onClose }: {
  title: string
  message?: string
  rows: UninstallRow[]
  confirmLabel: string
  note?: string
  /** 删不了(默认 Agent、内置技能…):只给关闭。 */
  blocked?: boolean
  loading?: boolean
  onConfirm: (checks: Record<string, boolean>) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  useEscape(onClose)
  const ic = { size: 15, strokeWidth: 1.8 }
  return createPortal(
    <div className="am-app tangu-lovable" style={{ display: 'contents' }} data-uninstall-dialog>
      <DialogOverlay className={window.tangu?.mobile ? 'un-sheet' : undefined} onMouseDown={onClose}>
        <div className="dialog un-dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
          <div className="dialog-title" id={titleId}>{title}</div>
          {message && <div className="dialog-msg">{message}</div>}
          {loading
            ? <div className="un-list"><div className="un-row"><Loader2 {...ic} className="spin" /><div className="un-tx"><small>{t('uninstall.loading')}</small></div></div></div>
            : rows.length > 0 && <div className="un-list">{rows.map((r) => {
              const on = !!(r.check && checks[r.check.key])
              return <div className="un-row" key={r.title} data-un-row={r.check?.key}>
                {r.icon}
                <div className="un-tx">{r.title}{r.sub && <small>{r.sub}</small>}
                  {r.check && <label className="dialog-check"><input type="checkbox" checked={on} onChange={(e) => setChecks({ ...checks, [r.check!.key]: e.target.checked })} /><span>{r.check.label}</span></label>}
                </div>
                <span className="un-pill" data-tone={(on ? r.check?.checkedTone : r.tone) || undefined}>{on && r.check?.checkedDest ? r.check.checkedDest : r.dest}</span>
              </div>
            })}</div>}
          <div className="un-foot">
            <span className="un-note">{!blocked && note}</span>
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={onClose}>{t(blocked ? 'uninstall.close' : 'amdlg.cancel')}</button>
              {!blocked && <button className="dialog-btn" data-danger autoFocus disabled={loading} onClick={() => { onConfirm(checks); onClose() }}>{confirmLabel}</button>}
            </div>
          </div>
        </div>
      </DialogOverlay>
    </div>,
    document.body,
  )
}

/** 从回收站恢复一条后的刷新:各类接回各自的界面(撤销提示与回收站页共用)。 */
export async function afterRestore(kind: TrashEntry['kind'], desktopExtra?: Record<string, unknown>): Promise<void> {
  const app = useApp.getState()
  if (kind === 'agent') {
    app.refreshAgents()
    void app.refreshSessions(app.cfg).catch(() => {})
    window.dispatchEvent(new Event('forsion:agents-changed'))
    window.tangu?.requestMainAction?.('agents-changed')
  } else if (kind === 'skill') {
    window.tangu?.requestMainAction?.('skills-changed')
  } else if (desktopExtra?.engine) {
    // 引擎插件(引擎不在时主进程挪的那份):文件夹回来了,让引擎重扫。
    const { rescanPlugins } = await import('../services/backendService')
    await rescanPlugins(homeTarget()).catch(() => {})
  } else {
    // Forsion 插件(主进程恢复):localStorage 偏好由渲染层写回,再重载插件、撤下 / 接回内嵌 Space。
    const prefs = desktopExtra?.prefs
    if (prefs && typeof prefs === 'object') for (const [k, v] of Object.entries(prefs)) { try { if (typeof v === 'string') localStorage.setItem(k, v) } catch { /* 存不下就算了 */ } }
    if (window.amadeus) {
      const [{ reloadPluginsAndAnnounce }, { loadUserSpaces }] = await Promise.all([import('../amadeusPlugins'), import('../userSpaces')])
      await reloadPluginsAndAnnounce().catch(() => {})
      void loadUserSpaces()
    }
    // 内嵌引擎插件:设置先放回、再重扫激活(先激活的话它建的空目录会占住原位,数据落到 -2)。放不回的条目留在回收站里,用户能手动恢复。
    // engineEnabled 是 10-30 之前的条目(卸载时把它们关了),按原样开回来。
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const { rescanPlugins, setPluginEnabled } = await import('../services/backendService')
    for (const id of strings(desktopExtra?.engineTrash)) await restoreTrashEntry(homeTarget(), id, { rescan: false }).catch(() => {})
    await rescanPlugins(homeTarget()).catch(() => {})
    for (const id of strings(desktopExtra?.engineEnabled)) await setPluginEnabled(homeTarget(), id, true).catch(() => {})
  }
}

/** 恢复一条:Forsion 插件走主进程(它知道笔记库在哪、要重扫插件),其余走引擎。返回恢复后的名字(改名落位时是新名字)。 */
export async function restoreFromTrash(entry: Pick<TrashEntry, 'id' | 'kind' | 'restorer'>): Promise<{ renamedTo?: string }> {
  if (entry.restorer === 'desktop') {
    const r = await window.amadeus!.trashRestore!(entry.id)
    await afterRestore(entry.kind, r.extra)
    return {}
  }
  const r = await restoreTrashEntry(homeTarget(), entry.id)
  await afterRestore(entry.kind)
  return r.renamed && r.slug ? { renamedTo: r.slug } : {}
}

/** 恢复失败说人话:重装过的插件、原处上级被换成软链各有一句,其余带原因。 */
export function restoreErrorText(e: unknown): string {
  const m = ipcErrorText(e)
  if (/plugin[-_]reinstalled|installed again/.test(m)) return translate('uninstall.reinstalled')
  if (/restore-target-moved|points somewhere else/.test(m)) return translate('uninstall.targetMoved')
  return translate('uninstall.restoreFail', { e: m })
}

/** 删完的回执:6 秒内点「撤销」原样放回去。设置浮窗里画在面板提示条上,别处走全局通知(panelToast 自己回落)。
 *  没有 trashId(云端 Agent 等)就只报一句。 */
export function notifyUninstalled(text: string, name: string, entry: Pick<TrashEntry, 'id' | 'kind' | 'restorer'> | null): void {
  if (!entry) { panelToast(text); return }
  panelToast(text, false, {
    durationMs: 6000,
    action: {
      label: translate('uninstall.undo'),
      run: () => void restoreFromTrash(entry)
        .then((r) => panelToast(r.renamedTo ? translate('uninstall.restoredAs', { name: r.renamedTo }) : translate('uninstall.restored', { name })))
        .catch((e: unknown) => panelToast(restoreErrorText(e), true)),
    },
  })
}

/** 删除 Agent(侧栏 Agent 行、Agents 名册、商店卸载共用)。只要 slug:商店那头只有目录名,名字由预览带回来。 */
export function AgentUninstallDialog({ slug, name: fallbackName, onDone, onClose }: { slug: string; name?: string; onDone?: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const [pv, setPv] = useState<AgentUninstallPreview | null | 'cloud'>(null)
  useEffect(() => {
    let live = true
    // 预览只在本机引擎有(云端 Agent 没有本机文件 / 回收站):拿不到就按云端那句说,照旧能删。
    agentUninstallPreview(homeTarget(), slug).then((r) => { if (live) setPv(r) }, () => { if (live) setPv('cloud') })
    return () => { live = false }
  }, [slug])
  const name = (pv && pv !== 'cloud' && pv.name) || fallbackName || slug
  const ic = { size: 15, strokeWidth: 1.8 }
  const rows: UninstallRow[] = !pv || pv === 'cloud' || pv.blocked ? [] : [
    { icon: <FolderClosed {...ic} />, title: t('uninstall.agent.files'), sub: fmtSize(pv.size), dest: t('uninstall.trash30') },
    ...(pv.chats ? [{ icon: <MessageCircle {...ic} />, title: t('uninstall.agent.chats', { n: pv.chats }), dest: t('uninstall.agent.archived'), check: { key: 'deleteChats', label: t('uninstall.agent.deleteChats'), checkedDest: t('uninstall.delete'), checkedTone: 'del' as const } }] : []),
    ...(pv.cloud ? [{ icon: <Cloud {...ic} />, title: t('uninstall.agent.cloud'), sub: t('uninstall.agent.cloudSub'), dest: t('uninstall.delete'), tone: 'del' as const }] : []),
    ...pv.teams.map((tm) => tm.dissolve
      ? { icon: <Users {...ic} />, title: t('uninstall.agent.dissolve', { team: tm.name }), sub: t('uninstall.agent.dissolveSub'), dest: t('uninstall.trash30') }
      : { icon: <Users {...ic} />, title: t('uninstall.agent.seat', { team: tm.name }), dest: t('uninstall.agent.leave') }),
    ...(pv.automations.length ? [{ icon: <Clock {...ic} />, title: t('uninstall.agent.automations', { n: pv.automations.length }), sub: pv.automations.map((a) => a.desc).join(t('common.listSep')), dest: t('uninstall.agent.pause') }] : []),
  ]
  const blocked = pv && pv !== 'cloud' ? pv.blocked : null
  return <UninstallDialog
    title={t('uninstall.agent.title', { name })}
    message={pv === 'cloud' ? t('uninstall.agent.msgCloud') : blocked === 'default' ? t('uninstall.agent.default') : blocked === 'muse' ? t('uninstall.agent.muse') : t('uninstall.agent.msg')}
    rows={rows} loading={!pv} blocked={!!blocked}
    confirmLabel={t('uninstall.delete')} note={pv === 'cloud' ? undefined : t('uninstall.note')}
    onConfirm={(checks) => {
      const app = useApp.getState()
      void app.removeAgent(slug, { deleteChats: !!checks.deleteChats })
        .then((r) => { notifyUninstalled(t('uninstall.agent.done', { name }), name, r.trashId ? { id: r.trashId, kind: 'agent', restorer: 'engine' } : null); onDone?.() })
        .catch((e: any) => panelToast(/run_active/.test(String(e?.message || e)) ? t('uninstall.agent.teamBusy') : String(e?.message || e), true))
    }}
    onClose={onClose}
  />
}

/** 删除技能(设置 › 技能、Agent 的技能页、商店卸载共用)。onDone 在删完之后调(刷新所在列表)。 */
export function SkillUninstallDialog({ skillKey, agentSlug, name: fallbackName, onDone, onClose }: { skillKey: string; agentSlug?: string; name?: string; onDone?: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const [pv, setPv] = useState<SkillUninstallPreview | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    skillUninstallPreview(homeTarget(), skillKey, agentSlug).then((r) => { if (live) setPv(r) }, (e: any) => { if (live) setErr(String(e?.message || e)) })
    return () => { live = false }
  }, [skillKey, agentSlug])
  const name = pv?.name || fallbackName || ''
  const ic = { size: 15, strokeWidth: 1.8 }
  const revert = pv?.mode === 'restore-builtin'
  const rows: UninstallRow[] = !pv || pv.mode === 'pause' || pv.mode === 'none' ? [] : revert ? [
    { icon: <FolderClosed {...ic} />, title: t('uninstall.skill.edited'), sub: fmtSize(pv.size), dest: t('uninstall.trash30') },
    { icon: <Sparkles {...ic} />, title: t('uninstall.skill.builtin'), dest: t('uninstall.skill.reinstall'), tone: 'keep' },
  ] : [
    { icon: <FolderClosed {...ic} />, title: t('uninstall.skill.folder'), sub: fmtSize(pv.size), dest: t('uninstall.trash30') },
    ...(pv.picks.length ? [{ icon: <Bot {...ic} />, title: t('uninstall.skill.picks', { names: pv.picks.map((p) => p.name).join(t('common.listSep')) }), dest: t('uninstall.skill.unpick') }] : []),
    ...(pv.disabled ? [{ icon: <Pause {...ic} />, title: t('uninstall.skill.paused'), sub: t('uninstall.skill.pausedSub'), dest: t('uninstall.skill.clear') }] : []),
  ]
  const blocked = !!err || pv?.mode === 'pause' || pv?.mode === 'none'
  return <UninstallDialog
    title={t(revert ? 'uninstall.skill.revertTitle' : 'uninstall.skill.title', { name })}
    message={err || (pv?.mode === 'pause' ? t('uninstall.skill.pauseOnly') : pv?.mode === 'none' ? t('uninstall.skill.legacy') : revert ? t('uninstall.skill.revertMsg') : undefined)}
    rows={rows} loading={!pv && !err} blocked={blocked}
    confirmLabel={t(revert ? 'uninstall.skill.revert' : 'uninstall.delete')} note={t('uninstall.note')}
    onConfirm={() => {
      const app = useApp.getState()
      void deleteSkillCatalogEntry(homeTarget(), skillKey, agentSlug)
        .then((r) => {
          notifyUninstalled(t(revert ? 'uninstall.skill.reverted' : 'uninstall.skill.done', { name }), name, r.trashId ? { id: r.trashId, kind: 'skill', restorer: 'engine' } : null)
          window.tangu?.requestMainAction?.('skills-changed')
          onDone?.()
        })
        .catch((e: any) => panelToast(String(e?.message || e), true))
    }}
    onClose={onClose}
  />
}

/** 卸载插件(Forsion 插件与引擎插件;设置页与商店共用)。框只收集选择,真正的卸载(停内嵌引擎插件、重载、重扫)由调用方做。
 *  vaultFolder:库里的工作文件夹(pluginStore.pluginVaultFolder 算出,库里没有就不传);skills / agents:捆绑包里带的。 */
export function PluginUninstallDialog({ name, warning, vaultFolder, cloudData, skills = 0, agents = [], onConfirm, onClose }: {
  name: string
  /** 还有别的插件依赖它时的提醒,排在正文前面。 */
  warning?: string
  vaultFolder?: string | null
  /** 这个插件的数据正随账号同步(pluginDataSyncOn):不留设置时云端那份也清。 */
  cloudData?: boolean
  skills?: number
  agents?: string[]
  onConfirm: (opts: { keepSettings: boolean; moveVault: boolean }) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const ic = { size: 15, strokeWidth: 1.8 }
  const rows: UninstallRow[] = [
    { icon: <Box {...ic} />, title: t('uninstall.plugin.files'), dest: t('uninstall.trash30') },
    { icon: <SlidersHorizontal {...ic} />, title: t('uninstall.plugin.settings'), ...(cloudData ? { sub: t('uninstall.plugin.settingsCloud') } : {}), dest: t('uninstall.trash30'), check: { key: 'keepSettings', label: t('uninstall.plugin.keepSettings'), checkedDest: t('uninstall.keep'), checkedTone: 'keep' } },
    ...(vaultFolder ? [{ icon: <FolderClosed {...ic} />, title: t('uninstall.plugin.vault', { folder: vaultFolder }), sub: t('uninstall.plugin.vaultSub'), dest: t('uninstall.keep'), tone: 'keep' as const, check: { key: 'moveVault', label: t('uninstall.plugin.moveVault'), checkedDest: t('uninstall.trash30') } }] : []),
    ...(skills ? [{ icon: <Sparkles {...ic} />, title: t('uninstall.plugin.skills', { n: skills }), dest: t('uninstall.plugin.skillsGo') }] : []),
    ...agents.map((a) => ({ icon: <Bot {...ic} />, title: t('uninstall.plugin.agent', { name: a }), sub: t('uninstall.plugin.agentSub'), dest: t('uninstall.keep'), tone: 'keep' as const })),
  ]
  return <UninstallDialog
    title={t('uninstall.plugin.title', { name })} message={warning ? `${warning} ${t('uninstall.plugin.msg')}` : t('uninstall.plugin.msg')} rows={rows}
    confirmLabel={t('uninstall.plugin.confirm')} note={t('uninstall.note')}
    onConfirm={(checks) => onConfirm({ keepSettings: !!checks.keepSettings, moveVault: !!checks.moveVault })}
    onClose={onClose}
  />
}
