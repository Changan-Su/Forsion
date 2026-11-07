import { flushAllScopes } from './amadeus/store/pageStore'
/** Mini boot connects shared data and a single opt-in Space surface. */
import { useEffect, useState } from 'react'
import { MiniColumnHost, getActiveSpace, isMacPlatform, getView, setActiveSpace, setMiniMainHandler, setMiniViewRouter, showInMainPanel, supportsMiniPanel, subscribeViews, useSpaceStore, useWorkspace } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { useI18n } from './i18n'
import { installFileDropGuard } from './fileDropGuard'
import { ensureAmadeusReady } from './amadeusPlugins'
import { isDockWindow, windowKind } from './windowKind'
import type { MiniOpenOptions } from '../../shared/miniPanel'
import { DockRoot } from './mini/DockRoot'
import { track } from './achievements/store'
import { installMiniDockMotion } from './mini/dockMotion'
import { QuickFind, useQuickFind } from './quickFind'
import { openMiniWindow, setMiniNoticeSink } from './mini/openMiniWindow'
import { VOICE_CALL_VIEW } from '../../shared/miniPanel'

/** 这扇 Mini 现在显示的实体(报给主进程认「同一个再开」):直开的视图不报(类型不会变);Tangu 只有钉住的会话才算身份。 */
function currentSpaceEntity(): MiniOpenOptions | null {
  const space = getActiveSpace()
  if (!space || !supportsMiniPanel(space)) return null
  const leaf = useWorkspace.getState().getActiveLeaf()
  const params = leaf?.type === space.mini!.view.type ? leaf.params ?? {} : {}
  const sessionId = space.id === 'tangu' && typeof params.sessionId === 'string' && !params.followActive ? params.sessionId : undefined
  return { spaceId: space.id, ...(sessionId ? { sessionId } : {}) }
}

let directMini: MiniOpenOptions | null = null
/** 侧边拼接面板(DockRoot)也是 direct 形态:它自己定目标,不经 onMiniTarget。 */
export function setDirectMini(target: MiniOpenOptions | null): void { directMini = target }

if (windowKind() === 'mini') {
  setMiniMainHandler(async (target) => {
    if (target.type === 'amadeus-editor') await flushAllScopes()
    const params = { ...target.params }
    delete params.miniSurface
    if (target.type === 'chat') {
      params.sessionId ||= useApp.getState().activeId || undefined
      params.followActive = !params.sessionId
    }
    window.tangu?.showMainPanel?.({ ...target, params })
  })
  setMiniViewRouter((target) => {
    if (directMini?.view) {
      if (target.type === directMini.view.type) return target
      if (target.type === (directMini.mainView?.type || directMini.view.type)) return { type: directMini.view.type, params: { ...directMini.view.params, ...target.params } }
      showInMainPanel({ ...target })
      return null
    }
    const space = getActiveSpace()
    if (!space || !supportsMiniPanel(space)) return null
    const mini = space.mini!
    if (target.type === mini.view.type) return target
    if (target.type === mini.mainView.type) return { type: mini.view.type, params: { ...mini.view.params, ...target.params } }
    // Links to full documents/tools belong in the main panel; never expand Mini into Forsion.
    showInMainPanel({ ...target })
    return null
  })
}

function buildMiniPanel(): void {
  const space = getActiveSpace()
  if (space && supportsMiniPanel(space)) useWorkspace.getState().openView(space.mini!.view.type, space.mini!.view.params ?? {}, 'main')
}

export function MiniRoot() {
  return isDockWindow() ? <DockRoot /> : <MiniPanelRoot />
}

function MiniPanelRoot() {
  const { t } = useI18n()
  useEffect(installMiniDockMotion, [])
  const [direct, setDirect] = useState<MiniOpenOptions | null>(null)
  const transient = new URLSearchParams(location.search).has('transient')
  // Mini 多开:同一实体被再开一次 → 轻跳;开满了 → 卡片里一行提示(这扇窗没有通知宿主)
  const [nudge, setNudge] = useState(0)
  useEffect(() => window.tangu?.onMiniNudge?.(() => setNudge((n) => n + 1)), [])
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = setMiniNoticeSink((text) => { setNotice(text); clearTimeout(timer); timer = setTimeout(() => setNotice(null), 4000) })
    return () => { off(); clearTimeout(timer) }
  }, [])
  useEffect(() => { useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined)) }, [t])
  useEffect(() => {
    let ready = false
    let directSeen = false
    const query = new URLSearchParams(location.search)
    let pending: MiniOpenOptions | null = query.get('sessionId') ? { sessionId: query.get('sessionId')! } : null
    // 等目标落定(没有待办的目标)才报:载入中先报出上次留下的 Space,会让同一实体的第二次打开错开一扇新窗
    let reported = ''
    const report = (): void => {
      if (!ready || pending || directMini || transient) return
      const entity = currentSpaceEntity()
      const sig = entity ? JSON.stringify(entity) : ''
      if (!entity || sig === reported) return
      reported = sig
      window.tangu?.miniEntity?.(entity)
    }
    const apply = (): void => {
      if (!ready || !pending) return
      if (pending.view) {
        const directView = pending.view
        if (!getView(directView.type)) {
          if (directSeen) window.tangu?.closeSelf?.()
          return
        }
        directSeen = true
        const target = pending
        pending = null
        directMini = target
        setDirect(target)
        useWorkspace.getState().openView(directView.type, { ...directView.params, ...target.params }, 'main')
        return
      }
      const spaceId = pending.spaceId || (pending.sessionId ? 'tangu' : undefined)
      const space = useSpaceStore.getState().spaces.find((s) => s.id === spaceId)
      if (!space || !supportsMiniPanel(space)) return // async plugin registration can fulfill the target later
      const target = pending
      pending = null
      directMini = null
      setDirect(null)
      setActiveSpace(space.id)
      const params = { ...space.mini!.view.params, ...target.params,
        ...(target.sessionId ? { sessionId: target.sessionId, followActive: false } : {}) }
      useWorkspace.getState().openView(space.mini!.view.type, params, 'main')
      if (target.sessionId) useApp.getState().setActiveId(target.sessionId)
    }
    const off = window.tangu?.onMiniTarget?.((target) => { pending = target; apply(); report() })
    window.tangu?.miniReady?.()
    const offSpaces = useSpaceStore.subscribe(() => { apply(); report() })
    const offViews = subscribeViews(apply)
    const offLeaf = useWorkspace.subscribe(report)
    void useApp.getState().boot().finally(() => { ready = true; apply(); report() })
    return () => { off?.(); offSpaces(); offViews(); offLeaf(); ready = false; directMini = null }
  }, [])
  useEffect(() => { if (window.amadeus) ensureAmadeusReady() }, [])
  useEffect(() => installFileDropGuard(), [])
  // 文件搜索 = 主窗那份快速查找(11-03 用户)。Mini 不装全局热键(installHotkeys 只在 Shell,装了会把主窗专属命令一起武装),
  // 只认 ⌘P / Ctrl+P 这一个。选中的笔记 / 会话照 setMiniViewRouter 走:本 Space 的视图就地开,别的进主面板。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'p' || !(isMacPlatform() ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey || e.isComposing) return
      e.preventDefault()
      useQuickFind.getState().openPalette()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // 引导「打开一次 Mini」:open-mini 命令 / 全局快捷键都只经主进程建窗,渲染层能看到的就是这张卡挂载(窗口复用时再显示不重计);
  // Computer Use 的自动观察窗(?transient=1)不算。计数经 localStorage + storage 事件同步回主窗。
  useEffect(() => { if (!new URLSearchParams(location.search).has('transient')) track('mini.open') }, [])
  // 「复制一扇」:按这扇现在显示的内容再开一扇(直开视图带上当前参数;Space 带上当前视图参数和钉住的会话)。
  // 语音通话一次只有一通、自动 Mini 是临时观察窗:都不给。
  const duplicate = (): void => {
    const leaf = useWorkspace.getState().getActiveLeaf()
    if (directMini?.view) {
      void openMiniWindow({ ...directMini, view: { type: directMini.view.type, params: { ...directMini.view.params, ...leaf?.params } }, duplicate: true })
      return
    }
    const entity = currentSpaceEntity()
    if (entity) void openMiniWindow({ ...entity, params: { ...leaf?.params }, duplicate: true })
  }
  const canDuplicate = !transient && !!window.tangu?.openMini && direct?.view?.type !== VOICE_CALL_VIEW
  // 自动 Mini(?transient=1,Computer Use 的临时观察窗)大小固定;用户自己开的这张可以拖边改大小
  return <>
    <MiniColumnHost buildDefault={buildMiniPanel} resizable={!!window.tangu?.miniResize && !transient} direct={direct?.view ? {
      title: direct.title,
      view: direct.view,
      mainView: direct.mainView ?? direct.view,
    } : null} onSearch={() => useQuickFind.getState().openPalette()}
    onDuplicate={canDuplicate ? duplicate : undefined} notice={notice} nudge={nudge}
    onTitle={(title) => { document.title = title }} />
    <QuickFind />
  </>
}
