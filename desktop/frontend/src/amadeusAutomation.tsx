/**
 * Amadeus「按钮」块 ← 宿主自动化实现(automationBridge 的桌面侧)。
 *
 * 住在宿主壳而不是 amadeus/ 子树里,是因为 amadeus/ 要能被云端 Web / 移动端整棵复用,不能 import
 * 桌面的 appStore / backendService。那两个宿主不注册本实现 → 按钮块显示「当前环境不支持」。
 *
 * editRule 要弹一个 React 弹层却是命令式调用(await),照 askString 的同款做法:zustand 单例请求态
 * + 一个挂在 AmadeusOverlays 里的 Host 组件。构建器本体懒加载 —— 它属于「自动化」Space,
 * 不该被拖进笔记视图的首屏 chunk。
 */
import { Suspense, lazy } from 'react'
import { create } from 'zustand'
import { setAutomationBridge, type AutomationRuleInfo } from '@amadeus/blocks/button/automationBridge'
import { setAutomationKick } from '@amadeus/store/automationKick'
import { useApp } from './stores/appStore'
import { useAutomation } from './stores/automationStore'
import { fireAutomationTrigger, getMuseTriggers, kickAutomation } from './services/backendService'
import type { MuseTriggerInfo } from './types'

const AutomationBuilder = lazy(() =>
  import('./views/automation/AutomationBuilder').then((m) => ({ default: m.AutomationBuilder })),
)

interface BuilderReq {
  editing?: MuseTriggerInfo
  resolve: (r: AutomationRuleInfo | null) => void
}

const useBuilderReq = create<{ req: BuilderReq | null; open(r: BuilderReq): void; clear(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  clear: () => set({ req: null }),
}))

const cfg = (): ReturnType<typeof useApp.getState>['cfg'] => useApp.getState().cfg

/** 幂等注册(installAmadeusPlugins 调用)。 */
export function installAmadeusAutomationBridge(): void {
  // .db 落盘 → 踢一次巡检(dbStore 侧已节流 1.5s)。云端/移动端不注册 → 那边只有轮询,行为如常。
  setAutomationKick(() => {
    const c = cfg()
    if (c) void kickAutomation(c).catch(() => { /* 引擎没起来/旧版本无此端点:轮询兜底 */ })
  })
  setAutomationBridge({
    async getRule(triggerId) {
      const c = cfg()
      if (!c) return null
      const t = (await getMuseTriggers(c)).find((x) => x.id === triggerId)
      // 只认手动类:引擎 fire 对 origin='button' 也只放行它们,这里先给出一致的界面反馈。
      return t && t.cond?.type === 'manual' ? { id: t.id, desc: t.desc, enabled: t.enabled } : null
    },
    async run(triggerId) {
      const c = cfg()
      if (!c) throw new Error('后端未连接')
      const r = await fireAutomationTrigger(c, triggerId, 'button')
      return { status: (r.status as 'done' | 'failed' | 'busy') ?? 'failed', steps: r.steps ?? [] }
    },
    async editRule(triggerId) {
      const c = cfg()
      if (!c) throw new Error('后端未连接')
      // 构建器读 automationStore 的动作目录/规则表,而那个 store 只有「自动化」Space 在轮询。
      // 从笔记里开构建器时没人拉过 → 工具步骤会是空目录(表现为「调工具」按钮恒灰)。这里补一次。
      await useAutomation.getState().refresh(c).catch(() => { /* 拉不到就退化成只有通知/跑 Agent 两种步骤 */ })
      const editing = triggerId ? (await getMuseTriggers(c)).find((x) => x.id === triggerId) : undefined
      return new Promise<AutomationRuleInfo | null>((resolve) => {
        useBuilderReq.getState().req?.resolve(null) // 单例:旧的未决请求先取消
        useBuilderReq.getState().open({ editing, resolve })
      })
    },
  })
}

/** 构建器弹层宿主(挂在 AmadeusOverlays 里;.am-app.tangu-lovable = .dialog-* 取色桥,同 askString)。 */
export function AutomationBuilderHost() {
  const req = useBuilderReq((s) => s.req)
  if (!req) return null
  const finish = (r: AutomationRuleInfo | null): void => {
    useBuilderReq.getState().clear()
    req.resolve(r)
  }
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <div className="dialog-overlay" onMouseDown={() => finish(null)}>
        <div className="dialog amx-btnblock-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <Suspense fallback={<div className="dialog-msg">载入构建器…</div>}>
            <AutomationBuilder
              editing={req.editing}
              fixedManual
              onSaved={(tr) => finish({ id: tr.id, desc: tr.desc, enabled: tr.enabled })}
              onCancel={() => finish(null)}
            />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
