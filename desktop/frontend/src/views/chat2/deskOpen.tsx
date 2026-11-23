/** Desk 一格里那样东西「是什么、怎么拿出去」的共用件(11-23 Desk 视图与标签栏互通方案,用户定全部按建议):
 *  名字胶囊的图标、⋯ 里的四项打开、名字胶囊拖出去。Agent Desk 与 Human Desk 共用,别各写一份。
 *  这里不 import AgentDesk(它反过来用这里):库内相对路径由调用方算好传进来(rel)。 */
import React from 'react'
import { FileText, Loader2, Puzzle } from 'lucide-react'
import { getView } from '@lcl/engine'
import type { DeskItem } from '../../stores/appStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { findFileType, usePluginStore } from '@amadeus/plugins/pluginStore'
import { resolveIcon } from '@amadeus/components/icons'
import { iconForPath } from '../../services/fileKinds'

/** 视图参数里认作「这是哪份文件」的键(amadeus-* 视图是库内相对路径,wsfile / 媒体是 path)。 */
const FILE_KEYS = ['notePath', 'drawingPath', 'dbPath', 'pdfPath', 'imagePath', 'dashPath', 'filePath', 'path'] as const
const isAbsPath = (p: string): boolean => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)

/** 条目对应的那份文件:条目路径,或视图参数里的文件键;没有文件的(网页、插件视图……)回空串。 */
export function deskItemFile(it: DeskItem): string {
  if (it.path) return it.path
  const p = (it.view?.params ?? {}) as Record<string, unknown>
  for (const k of FILE_KEYS) {
    const v = p[k]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

/** 名字胶囊的图标(方案 ③ 的表):直播 → 转圈;插件结果卡 → 拼图;有文件的 → 页面 emoji > 插件文件类型的图标 >
 *  按种类(白板 / 数据库 / 仪表盘 / PDF 书本 / 扩展名);没有文件的 → 它注册时给的标签图标;都认不出 → 一张纸。不再给星
 *  (星是卡片头「Agent Desk」的牌子)。rel = 条目路径在当前库里的相对路径(调用方算,库外为 null)。 */
export function DeskItemIcon({ item, rel, size, className }: { item: DeskItem; rel: string | null; size: number; className?: string }): React.ReactElement {
  const file = deskItemFile(item)
  // amadeus-* 视图参数里的文件本来就是库内相对路径;条目自己的路径由调用方相对化
  const key = rel ?? (item.view && file && !isAbsPath(file) ? file : null)
  const emoji = usePageStore((s) => (key ? s.icons[key] ?? null : null))
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const cls = className ?? ''
  if (item.live) return <Loader2 size={size} className={`${cls} spin`} />
  if (item.tool) return <Puzzle size={size} className={cls} />
  const Kind = file ? iconForPath(file) : (item.view && getView(item.view.type)?.icon) || FileText
  if (emoji) return <span className={`${cls} desk-cap-emoji`} aria-hidden="true">{emoji}</span>
  const ft = key ? findFileType(fileTypes, key) : undefined
  // resolveIcon 对不认识的键名回兜底 —— 兜底必须给,否则插件写了个新键这一格就空了(同文件树)
  if (ft?.icon) return <span className={`${cls} desk-cap-emoji`} aria-hidden="true">{resolveIcon(ft.icon, <Kind size={size} />)}</span>
  return <Kind size={size} className={cls} />
}
