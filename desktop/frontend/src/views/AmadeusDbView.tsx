/** 独立 .db 数据库视图:树上点 .db 在应用内打开表格(多实例,params.dbPath 认领文件并随布局持久化)。
 *  ref = 完整 vault 相对路径 —— 与 dbAggregateStore 的 load(p,p) 同一约定,与嵌入/聚合共享同一 dbStore entry。 */
import { useEffect } from 'react'
import type { ViewProps } from '@lcl/engine'
import { useTheme } from '../stores/themeStore'
import { useDbStore } from '@amadeus/store/dbStore'
import { DatabaseEmbed } from '@amadeus/blocks/database/DatabaseEmbed'
import '@amadeus/blocks' // 属性类型/块注册 side-effect,独立挂载时不能指望编辑器先加载

const dbBase = (p: string): string => (p.split(/[\\/]/).pop() || p).replace(/\.db$/i, '')

export function AmadeusDbView({ leaf }: ViewProps) {
  const dbPath = typeof leaf.params.dbPath === 'string' ? leaf.params.dbPath : ''
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  const name = useDbStore((s) => (dbPath ? s.entries[dbPath]?.data?.name : undefined))
  useEffect(() => {
    if (dbPath) void useDbStore.getState().load(dbPath, dbPath)
  }, [dbPath])
  // navigateLeaf 会把标题重置为 displayName,挂载/参数/名称变化后设回 db 名(WsFileView 同款)。
  useEffect(() => {
    if (dbPath) leaf.setTitle(name || dbBase(dbPath))
  }, [dbPath, name]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!dbPath) return <div className="amx-db amx-db-state">未指定数据库文件。</div>
  return (
    /* 编辑器同款契约域(.am-app+bridge 取色,镜像 mode/flat),外层滚动由 .amx-dbview 管 */
    <div className="am-app tangu-lovable amx-pane amx-dbview" data-mode={mode} data-flat={flat ? '1' : '0'}>
      <DatabaseEmbed target={dbPath} pagePath={dbPath} />
    </div>
  )
}
