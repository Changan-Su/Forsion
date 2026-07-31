/**
 * 「按钮」块 → 宿主自动化的接缝。
 *
 * amadeus/ 子树的既有纪律:**不直接 import 宿主 store/服务**(web / mobile / 独立版都复用这棵树,
 * 宿主各不相同)。既有解耦手段是单向 CustomEvent(`amadeus:template-picker` 等),但按钮需要**回值**
 * (规则存不存在、跑完什么结果、构建器保存了哪条规则),事件不合用 —— 所以照 blocks/registry.ts、
 * propertyTypes 的同款做法开一个可注册的接缝。
 *
 * 桌面壳在 amadeusPlugins.installAmadeusPlugins() 里注册实现;没注册的宿主(云端 Web / 移动端)
 * 按钮块照常渲染,但明说「当前环境不支持」——比点了没反应好。
 */

export interface AutomationRuleInfo {
  id: string
  desc: string
  enabled: boolean
}

export interface AutomationRunResult {
  /** done=全部步骤成功;failed=某步失败(fail-stop);busy=上一次点击还在跑(服务端单飞)。 */
  status: 'done' | 'failed' | 'busy'
  steps: { type: string; ok: boolean; summary: string }[]
}

export interface AutomationBridge {
  /** 引用的规则是否还在(被删 / 笔记来自别的机器 → null)。 */
  getRule(triggerId: string): Promise<AutomationRuleInfo | null>
  /** 执行(origin=button;引擎侧只放行 cond=manual 且已启用的规则)。 */
  run(triggerId: string): Promise<AutomationRunResult>
  /** 打开构建器新建/编辑一条 manual 规则;用户取消 → null。 */
  editRule(triggerId?: string): Promise<AutomationRuleInfo | null>
}

let bridge: AutomationBridge | null = null

export function setAutomationBridge(b: AutomationBridge | null): void {
  bridge = b
}

export function getAutomationBridge(): AutomationBridge | null {
  return bridge
}
