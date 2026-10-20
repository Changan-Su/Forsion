import type { SettingsViewContribution } from '../amadeus/plugins/types'

export interface CloudSettingsView { pluginId: string; item: SettingsViewContribution }
export const cloudViewKey = (view: CloudSettingsView): string => `fx:${view.pluginId}:${view.item.id}`
export const cloudViewTitle = (view: CloudSettingsView): string =>
  (typeof view.item.title === 'function' ? view.item.title() : view.item.title) || view.item.id
export const cloudTabTitle = (view: CloudSettingsView): string =>
  (typeof view.item.tabTitle === 'function' ? view.item.tabTitle() : view.item.tabTitle) || cloudViewTitle(view)

/** Exact IDs win over aliases, including when an older Extend is installed. */
export function resolveCloudSettingsKey(views: readonly CloudSettingsView[], key: string): string {
  if (views.some((view) => cloudViewKey(view) === key)) return key
  const alias = views.find((view) => view.item.aliases?.some((id) => `fx:${view.pluginId}:${id}` === key))
  return alias ? cloudViewKey(alias) : key
}

/** Only one level, in the same plugin. Missing or cyclic parents stay visible as standalone pages. */
export function cloudSettingsParent(views: readonly CloudSettingsView[], key: string): string {
  const view = views.find((view) => cloudViewKey(view) === key)
  const parent = view?.item.parent && views.find((candidate) => candidate.pluginId === view.pluginId && candidate.item.id === view.item.parent && !candidate.item.parent)
  return parent ? cloudViewKey(parent) : key
}

export function cloudSettingsTabs(views: readonly CloudSettingsView[], key: string): CloudSettingsView[] {
  const parent = cloudSettingsParent(views, key)
  const root = views.find((view) => cloudViewKey(view) === parent)
  if (!root) return []
  const children = views.filter((view) => cloudViewKey(view) !== parent && cloudSettingsParent(views, cloudViewKey(view)) === parent)
  return children.length ? [root, ...children] : []
}

/** The long-standing account search includes login; grouped hosts should open its actual controls. */
export function cloudAccountSearchKey(views: readonly CloudSettingsView[], fallback: string): string {
  const details = views.find((view) => view.pluginId === 'forsion-extend' && view.item.id === 'account-details')
  return details ? cloudViewKey(details) : fallback
}
