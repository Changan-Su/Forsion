/**
 * 列表源的空态(2026-10-25 第四轮 4.1;2026-10-26 走查续八 8.18 起插件也能登记:`ListSourceContribution.empty`)。
 *
 * 规则(DESIGN §6 空态):主区的空态说清「这里会出现什么」,侧栏不再重复一句「暂无内容」。
 *  - 桌面:当前 Space 是 `space`(主区开着那份空态)、没在搜索、没选分类 → 列表那句不画;
 *    在别的 Space 的工作区里手动切到这个源时,主区不是它,照旧写「暂无内容」。插件源的 `space` = 这个插件自己的任一 Space。
 *  - 手机整屏列表(flat):列表就是这一页,主区要点进去才看得到 → 列表里直接画同一个 EmptyState。
 */
import type { LucideIcon } from 'lucide-react'
import { ListChecks } from 'lucide-react'
import type { EmptyStateAction } from '../components/EmptyState'
import type { PluginEmptyState } from '../amadeus/plugins/types'
import { pluginText } from '../amadeus/plugins/pluginText'
import { checkPluginIcon, vocabIcon } from '../amadeus/plugins/pluginIcon'
import { pluginSpaceOwner } from '../stores/spaceProgress'

export interface HostListEmpty {
  /** 主区负责讲空的那个 Space(或判它的函数)。 */
  space: string | ((spaceId: string | null) => boolean)
  icon: LucideIcon
  title: () => string
  line?: () => string
  /** 手机整屏列表里那份空态的按钮。 */
  action?: () => EmptyStateAction | null
  /** 数据真拉到过才算「空」(没拉到之前的空数组只是还没拉):不给 = 一直算拉到了。没拉到时手机列表照旧写「暂无内容」。 */
  ready?: () => boolean
}

const HOST_EMPTY = new WeakMap<object, HostListEmpty>()

export function setHostListEmpty(src: object, empty: HostListEmpty): void { HOST_EMPTY.set(src, empty) }
export function hostListEmpty(src: object): HostListEmpty | undefined { return HOST_EMPTY.get(src) }
export const isEmptySpace = (e: HostListEmpty, spaceId: string | null): boolean => (typeof e.space === 'function' ? e.space(spaceId) : spaceId === e.space)

/** 插件的 `empty` → 宿主那份。`alive`:插件停用后按钮不再调它。 */
export function pluginListEmpty(pluginId: string, empty: PluginEmptyState, alive: () => boolean): HostListEmpty {
  if (empty.icon) checkPluginIcon(pluginId, empty.icon, 'list empty')
  const act = empty.action
  return {
    space: (id) => !!id && pluginSpaceOwner.get(id) === pluginId,
    icon: (vocabIcon(empty.icon) as unknown as LucideIcon | undefined) ?? ListChecks,
    title: () => pluginText(empty.title),
    line: empty.line ? () => pluginText(empty.line) : undefined,
    action: act && typeof act.run === 'function' ? () => ({
      label: pluginText(act.label),
      icon: vocabIcon(act.icon) as unknown as LucideIcon | undefined,
      onClick: () => { if (alive()) { try { act.run() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" empty-state action threw`, e) } } },
    }) : undefined,
  }
}
