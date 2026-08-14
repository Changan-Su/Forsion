// 笔记编辑器路由决策(纯函数,vitest 可钉):按 classifyPageSource 把文件分给
// 「unified」(v4 统一实例编辑器)或「block」(现有 v3 每块一实例 PageView)。
// 绞杀者策略:v3 文件永远走 block 路径(那边 148 项 e2e 继续有效);素文件/外来 md
// 与 v4 结构化走 unified。「打开即升」开关打开时,v3 文件在内存里升成 v4 源喂给
// unified —— **只读打开不改写**(spec §5.1):落盘发生在首次真实编辑的保存,由
// UnifiedPage 的 lastSaved 基线保证(初始序列化差异不触发写)。
import { classifyPageSource, upgradeV3Source } from '@amadeus-shared/compiler/v4'

export type RouteDecision =
  | { editor: 'block' }
  /** diskRaw = 磁盘原始字节:UnifiedPage 的回灌基线必须用它(升级场景 initial=升级后源 ≠ 盘上 v3;
   *  基线错了,挂载补读会把盘上 v3 原文当外部更新灌回编辑器,升级当场被冲掉 —— Codex 终审)。 */
  | { editor: 'unified'; initial: string; diskRaw: string; upgradedFromV3: boolean }

/**
 * raw == null(文件尚不存在,新建流)→ block:现有 loadPage 负责 newPage。
 * future schema → block:futureSchemaPage 的原样只读展示在那边。
 * v3 + 升级开关 + 升级被拒(mindmap:/dashboard 键等)→ block,文件留在 v3。
 */
export function routeNote(path: string, raw: string | null, upgradeV3: boolean, now: string): RouteDecision {
  if (raw == null) return { editor: 'block' }
  const cls = classifyPageSource(raw)
  if (cls === 'v4-plain' || cls === 'v4-structured') return { editor: 'unified', initial: raw, diskRaw: raw, upgradedFromV3: false }
  if (cls === 'v3' && upgradeV3) {
    const up = upgradeV3Source(path, raw, now)
    if (up.ok) return { editor: 'unified', initial: up.src, diskRaw: raw, upgradedFromV3: true }
  }
  return { editor: 'block' }
}
