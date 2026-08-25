/**
 * forsion:// deep link 渲染层落地(P1):意图 → 现有门面(openNote/openSession/openView/setActiveSpace),
 * **不新建打开路径**。仅主窗(deep link 一律定向主窗,mini/detached 不是目标)。
 * 安全(方案 §4.3):只导航不执行;view 白名单 default-deny——注册表在场 = 已启用(插件禁用即反注册),
 * browser/terminal 明确拒(任意网页可唤起 = 现成钓鱼面);aux 类无独立打开意义,拒。
 */
import { getView, useWorkspace, setActiveSpace, useSpaceStore } from '@lcl/engine'
import type { ViewDefinition } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { openNote } from './amadeusNav'
import { openSession, openNewChat } from './sessionNav'
import { parseDeepLink, isSafeVaultPath, isSafeId, type DeepLinkIntent } from './deepLinkPlan'
import { fileMatchViewType } from './viewFileMatch'
import { windowKind } from './windowKind'

const VIEW_DENY = new Set(['browser', 'terminal'])

/**
 * 通用径 `open?view=…` 的身份参数安全闸(§4.3)。
 *
 * ⚠️「view 已注册」远不够格当放行凭据(Codex 评审实证两条):
 *  · `wsfile` 的身份参数是**主机绝对路径**(hostTargetFor → readHostFile 直读任意本机文件),
 *    它没有 fileMatch —— 若只在「有 fileMatch 时」才校验,等于给任意网页开了读盘口子;
 *  · 文件类 view 收到不归自己的后缀会**毁档**:`.excalidraw.md` 掉进笔记编辑器,compiler
 *    会把插件载荷改写成块。amadeusNav 的门面有这道防线,openView 直路没有。
 *
 * 故 entity 一律按 idParam 逐一判形:文件类要求「安全 vault 相对路径 **且后缀归属本 view**」,
 * 非文件类只收 id 形态(带斜杠的绝对路径在这里出局)。page/collection 不消费身份参数,放行。
 */
export function entityParamsSafe(def: ViewDefinition, params: Record<string, string>): boolean {
  if (def.kind !== 'entity' || !def.idParam) return true
  const v = params[def.idParam]
  if (v === undefined) return true // 不带身份 = 开一个空壳视图,无害
  if (typeof v !== 'string' || !v) return false
  if (def.fileMatch) return isSafeVaultPath(v) && fileMatchViewType(v) === def.type
  return isSafeId(v, 256)
}

const zh = (): boolean => document.documentElement.lang.startsWith('zh')

/** 冷启动 drain 到的 URL 会先于 Dockview 就绪到达 → 等 api 上线再落地(封顶 8s,超时按当前状态硬试)。 */
function whenWorkspaceReady(timeoutMs = 8000): Promise<void> {
  if (useWorkspace.getState().api) return Promise.resolve()
  return new Promise((resolve) => {
    const off = useWorkspace.subscribe((s) => {
      if (s.api) { clearTimeout(t); off(); resolve() }
    })
    const t = setTimeout(() => { off(); resolve() }, timeoutMs)
  })
}

function switchSpace(id: string): boolean {
  const st = useSpaceStore.getState()
  if (!st.spaces.some((s) => s.id === id)) return false
  setActiveSpace(id) // 同 id no-op;未注册在上面已拒
  return true
}

export async function resolveDeepLink(intent: DeepLinkIntent): Promise<boolean> {
  switch (intent.kind) {
    case 'note': {
      // ⚠️ 必须先确认笔记**真的存在**:pageStore.loadPage 是「存在则解析、不存在则新建」语义,
      // 直接开等于让任意网页用一批唯一文件名往用户库里造文件 —— 违反「只导航不执行」(Codex 评审)。
      // 用现成的结构清单判,不做额外 IO;冷启动清单还空 → 刷一次再判。
      const norm = (s: string): string => s.replace(/\\/g, '/')
      const want = norm(intent.ref!)
      const known = (): boolean => {
        const ps = usePageStore.getState()
        return [...ps.pages, ...ps.files].some((f) => norm(f) === want)
      }
      if (!known()) {
        await usePageStore.getState().refreshStructure().catch(() => {})
        if (!known()) return false
      }
      await openNote(intent.ref!) // openNote 自带后缀分派(白板/仪表盘/插件文件类型各回各家)
      return true
    }
    case 'session':
      // ponytail: 不预查会话存在性——冷启动时列表可能还没拉到,误拒比开出「加载失败」的会话更糟。
      openSession(intent.ref!)
      return true
    case 'space':
      return switchSpace(intent.ref!)
    case 'agent': {
      const app = useApp.getState()
      // 列表已加载且查无此 agent → 拒;列表未加载(冷启动竞态)放行,引擎侧有 defaultAgent 兜底。
      if (app.agentDefs.length && !app.agentDefs.some((a) => a.slug === intent.ref)) return false
      // ⚠️ 顺序:openNewChat 内部会清空 newChatCfg(sessionNav.ts:82)——先开再选,
      // 与 UI 实际次序一致(开新聊天 → 输入框里选 agent),选择才存活。
      openNewChat()
      useApp.getState().selectNewChatAgent(intent.ref!) // UI 同款 setter(带 model/thinkingLevel 联动)
      return true
    }
    case 'view': {
      const type = intent.view!
      if (VIEW_DENY.has(type)) return false
      const def = getView(type)
      if (!def || def.kind === 'aux') return false
      if (!entityParamsSafe(def, intent.params)) return false
      if (intent.space && !switchSpace(intent.space)) return false
      const go = (): void => { useWorkspace.getState().openView(type, intent.params, 'main') }
      // setActiveSpace 同步换整个布局(applyNamed/resetLayout);同 tick 开 view 会跟布局应用赛跑 → 推一帧。
      if (intent.space) requestAnimationFrame(go)
      else go()
      return true
    }
  }
}

/** 装载(bootstrapEngine 调,仅桌面主窗):订阅热推 + 拉冷启动积压。 */
export function installDeepLinks(): void {
  if (windowKind() !== 'main') return
  const w = window as unknown as {
    tangu?: { onDeepLink?: (cb: (u: string) => void) => () => void; drainDeepLinks?: () => Promise<string[]> }
  }
  if (!w.tangu?.onDeepLink || !w.tangu?.drainDeepLinks) return // web/mobile 有各自通道(https /open、tangu://)
  const handle = (url: string): void => {
    void (async () => {
      const toast = useApp.getState().toast
      const intent = parseDeepLink(url)
      if (!intent) { toast(zh() ? '无法识别的 Forsion 链接' : 'Unrecognized Forsion link'); return }
      await whenWorkspaceReady()
      const ok = await resolveDeepLink(intent).catch(() => false)
      if (!ok) toast(zh() ? '链接目标不可用(视图未启用或参数非法)' : 'Link target unavailable (view disabled or bad params)')
    })()
  }
  w.tangu.onDeepLink(handle)
  void w.tangu.drainDeepLinks().then((urls) => { for (const u of urls) handle(u) })
}
