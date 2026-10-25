/**
 * 宿主内置列表源的空态(2026-10-25 第四轮 4.1)。**不进插件契约**(ListSourceContribution 不加字段):
 * 插件的列表照旧在空时写一句「暂无内容」;只有宿主自己的源能在这里登记「主区已经把空讲清楚了」。
 *
 * 规则(DESIGN §6 空态):主区的空态说清「这里会出现什么」,侧栏不再重复一句「暂无内容」。
 *  - 桌面:当前 Space 是 `space`(主区开着那份空态)、没在搜索、没选分类 → 列表那句不画;
 *    在别的 Space 的工作区里手动切到这个源时,主区不是它,照旧写「暂无内容」。
 *  - 手机整屏列表(flat):列表就是这一页,主区要点进去才看得到 → 列表里直接画同一个 EmptyState。
 */
import type { LucideIcon } from 'lucide-react'

export interface HostListEmpty {
  /** 主区负责讲空的那个 Space。 */
  space: string
  icon: LucideIcon
  title: () => string
  line?: () => string
  /** 数据真拉到过才算「空」(没拉到之前的空数组只是还没拉):不给 = 一直算拉到了。没拉到时手机列表照旧写「暂无内容」。 */
  ready?: () => boolean
}

const HOST_EMPTY = new WeakMap<object, HostListEmpty>()

export function setHostListEmpty(src: object, empty: HostListEmpty): void { HOST_EMPTY.set(src, empty) }
export function hostListEmpty(src: object): HostListEmpty | undefined { return HOST_EMPTY.get(src) }
