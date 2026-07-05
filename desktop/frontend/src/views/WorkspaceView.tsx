/**
 * 统一「工作区」视图 + 统一「大纲」视图 —— 会话列表 / 工作区文件 / 笔记库(以及 目录 / Amadeus 大纲)
 * 底层合并为两套共享视图,按 (所在侧栏左右 × focus 的主视图类型) 自动切换模式,也可手动切换。
 *
 * 模式体全部**包裹复用**现有组件(SessionsView / FilesPanel / AmadeusPagesView / TocView /
 * AmadeusOutlineView),本文件只提供:模式状态(存 leaf params,随布局持久化)+ 头部切换器 + 自动跟随。
 * 自动规则:主视图=chat → 左=会话、右=文件(当前会话工作区);主视图=编辑器 → 左=笔记、右=文件
 * (定位到笔记所在目录;笔记与工作区层级不一致时以笔记所在目录为准);其他主视图 → 维持上一模式。
 */
import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react'
import { useWorkspace, activeMainPanel, scheduleWorkspaceSave } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { useShallow } from 'zustand/react/shallow'
import { SessionsView } from './SessionsView'
import { TocView } from './RightViews'
import { FilesPanel } from './chat2/FilesPanel'
import { AmadeusPagesView, AmadeusOutlineView } from '../amadeusViews'
import { usePageStore } from '@amadeus/store/pageStore'
import type { WorkspaceDescriptor } from '../types'
import { autoWorkspaceMode, type WorkspaceMode } from './workspaceMode'

/** 当前活动主 leaf 的视图类型(订阅 mainTabs 驱动重算;焦点在侧栏时 activeMainPanel 有组内回退)。 */
function useActiveMainType(): string | null {
  useWorkspace((s) => s.mainTabs)
  const api = useWorkspace.getState().api
  const am = api ? activeMainPanel(api) : null
  return am ? (((am.params ?? {}) as { __type?: string }).__type ?? null) : null
}

/** 文件模式体:appStore 接线(≈ 原 FilesView),编辑器场景注入合成的 vault 工作区并定位笔记目录。
 *  vault 场景手风琴用本地 state(初始/跟随 vault),不写全局 activeWorkspaceKey(那是会话侧的联动)。 */
function FilesBody({ vaultCtx }: { vaultCtx: { root: string; noteDir: string | null } | null }) {
  const s = useApp(useShallow((state) => ({
    workspaces: state.workspaces,
    setFilePreview: state.setFilePreview,
    activeWorkspaceKey: state.activeWorkspaceKey,
    setActiveWorkspaceKey: state.setActiveWorkspaceKey,
  })))
  const vaultKey = vaultCtx ? `vault:${vaultCtx.root}` : null
  const [localKey, setLocalKey] = useState<string | null>(vaultKey)
  useEffect(() => { setLocalKey(vaultKey) }, [vaultKey])
  const workspaces = useMemo<WorkspaceDescriptor[]>(() => {
    const base = s.workspaces()
    if (!vaultCtx) return base
    const vaultWs: WorkspaceDescriptor = {
      key: vaultKey!,
      name: vaultCtx.root.split(/[\\/]/).filter(Boolean).pop() || 'Vault',
      kind: 'local',
      path: vaultCtx.root,
    }
    return [vaultWs, ...base.filter((w) => w.path !== vaultCtx.root)] // 同目录已是会话工作区 → 去重
  }, [s, vaultCtx, vaultKey])
  return (
    <FilesPanel
      workspaces={workspaces}
      onOpenPreview={s.setFilePreview}
      activeWorkspaceKey={vaultCtx ? localKey : s.activeWorkspaceKey}
      onEnterWorkspace={(key) => (vaultCtx ? setLocalKey(key) : s.setActiveWorkspaceKey(key))}
      expandToPath={vaultCtx?.noteDir ?? null}
    />
  )
}

const MODE_KEYS: Array<{ id: WorkspaceMode | 'auto'; label: string }> = [
  { id: 'auto', label: 'workspace.mode.auto' },
  { id: 'sessions', label: 'workspace.mode.sessions' },
  { id: 'files', label: 'workspace.mode.files' },
  { id: 'notes', label: 'workspace.mode.notes' },
]

export function WorkspaceView({ leaf }: ViewProps) {
  const { t } = useI18n()
  const hasNotes = !!window.amadeus
  const mainType = useActiveMainType()
  const loc = leaf.loc
  // 手动覆盖存 leaf params(随布局持久化);'auto'(默认)跟随主视图。
  const raw = leaf.params.mode
  const override: WorkspaceMode | 'auto' =
    raw === 'sessions' || raw === 'files' || (raw === 'notes' && hasNotes) ? raw : 'auto'
  const autoRef = useRef<WorkspaceMode>(loc === 'right' ? 'files' : 'sessions')
  const auto = autoWorkspaceMode(loc, mainType, autoRef.current)
  autoRef.current = auto
  const mode: WorkspaceMode = override === 'auto' ? (auto === 'notes' && !hasNotes ? 'files' : auto) : override

  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const activePage = usePageStore((s) => s.activePage)
  // 编辑器场景的文件模式:定位到笔记所在目录(顶层笔记 → 工作区根,无需展开)。
  const vaultCtx = useMemo(() => {
    if (mode !== 'files' || mainType !== 'amadeus-editor' || !vaultRoot) return null
    const segs = (activePage ?? '').split(/[\\/]/).filter(Boolean)
    segs.pop()
    return { root: vaultRoot, noteDir: segs.length ? `${vaultRoot}/${segs.join('/')}` : null }
  }, [mode, mainType, vaultRoot, activePage])

  const body: ReactNode =
    mode === 'sessions' ? <SessionsView />
    : mode === 'files' ? <FilesBody vaultCtx={vaultCtx} />
    : hasNotes ? <AmadeusPagesView />
    : <div className="t2sw-empty">{t('workspace.notesUnavailable')}</div>

  return (
    <div className="t2sw">
      <div className="t2sw-head">
        {MODE_KEYS.filter((m) => m.id !== 'notes' || hasNotes).map((m) => (
          <button
            key={m.id}
            className={`t2sw-seg${override === m.id ? ' on' : ''}`}
            title={m.id === 'auto' ? t('workspace.mode.autoTip') : undefined}
            onClick={() => { leaf.setParams({ mode: m.id }); scheduleWorkspaceSave() }}
          >
            {t(m.label)}
            {m.id === 'auto' && override === 'auto' && <span className="t2sw-auto-now">·{t(`workspace.mode.${mode}`)}</span>}
          </button>
        ))}
      </div>
      <div className="t2sw-body">{body}</div>
    </div>
  )
}

/** 统一「大纲」视图:主视图=chat → 会话目录(DOM 扫描);=编辑器 → 笔记标题大纲(块模型);其他 → 空态。 */
export function OutlineView() {
  const { t } = useI18n()
  const mainType = useActiveMainType()
  if (mainType === 'chat') return <TocView />
  if (mainType === 'amadeus-editor' && window.amadeus) return <AmadeusOutlineView />
  return <div className="t2sw-empty">{t('outline.empty')}</div>
}
