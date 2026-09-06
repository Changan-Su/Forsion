/**
 * 插件原生表挂载(2026-09-05):在插件自己的 DOM 容器里渲染**真** DbTable(只读、内存行),
 * **不依赖笔记库**。与 dashboardSurface 是同一路线的两件事(那件是仪表盘,这件是表格)。
 *
 * 为什么存在:远程系统面板(服务器管理台之流)的 18 张表各自手搓 `<table>`,搜索/筛选/隐藏列/
 * 排序/统计一样都没有,而应用里明明就有一张成熟的多维表。这里把「渲染」与「住在库里」解耦:
 * 规格(TableSpec)→ 内存 DbFile + cellMeta 边料 → 真 DatabaseEmbed(readOnly + db 内存源)。
 *
 * 四条纪律:
 *  ① 外层类名必须是 `amadeus-root am-app tangu-lovable` **且带 `data-mode`** —— 暗色芯片色板挂在
 *     `.am-app[data-mode='dark']` 上,照抄 dashboardSurface(它没有 data-mode)就会在暗色下渲出
 *     一片浅色粉彩芯片:纯观感缺陷,任何几何断言都抓不到。
 *  ② `import '../blocks'` 的 side effect 不能省:属性类型/块注册在那儿,独立挂载时不能指望编辑器先加载。
 *  ③ **弹层要逃出插件皮肤**:插件面板 `.fsa-adm` 带 `container-type: inline-size`,它于是成了
 *     `position:fixed` 后代的包含块 —— 列菜单/筛选层会锚到面板盒子并被 `overflow:auto` 裁掉。
 *     所以本表在 body 上自带一个零尺寸宿主 `.amx-plugtable-pops`,把 pop 传送过去(popHost)。
 *     dispose 要连它一起收。
 *  ④ `update(spec)` **原地重渲染**(mountHostReact 按容器复用同一个 React root,组件实例不变)——
 *     用户的排序/筛选/列宽住在 DbTable 自己的 state 里,重挂就全丢了。
 */
import { useLayoutEffect, useMemo, useRef } from 'react'
import '../blocks' // 属性类型/块注册 side-effect,独立挂载时不能指望编辑器先加载
import './tableSurface.css'
import { DatabaseEmbed } from '../blocks/database/DatabaseEmbed'
import type { DbRow } from '@amadeus-shared/db/schema'
import { useTheme } from '../../stores/themeStore'
import { mountHostReact } from './blockSurface'
import { safeAttrs, specToDb, tableCellMeta, validateTableSpec } from './tableSpec'
import type { TableRow, TableSpec } from './types'

function PluginTable({ pluginId, spec, popHost }: { pluginId: string; spec: TableSpec; popHost: HTMLElement }) {
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  const rootRef = useRef<HTMLDivElement>(null)
  // 表级错误 = 表体清空 + 表下一行红字(表头/工具条留着,与降级路径同构)。
  const db = useMemo(() => specToDb(spec.error ? { ...spec, rows: [] } : spec), [spec])
  const meta = useMemo(() => tableCellMeta(spec.error ? { ...spec, rows: [] } : spec), [spec])
  const rowsById = useMemo(() => new Map(spec.rows.map((r) => [r.id, r])), [spec])
  // 初始排序**只取首份规格**:之后用户在表头改的排序归表自己记,数据刷新不许把它冲回去。
  const initialSort = useRef(spec.sort ? { colId: spec.sort.key, dir: spec.sort.dir } : null)
  // 规格随刷新换身份,但回调要拿最新的一份(DatabaseEmbed 的 props 走的是下面这几个闭包)。
  const latest = useRef(spec)
  latest.current = spec

  // 弹层宿主与本表同步明暗:它住在 body 上,拿不到 .am-app 祖先的 data-mode。
  useLayoutEffect(() => {
    popHost.dataset.mode = mode
    popHost.dataset.flat = flat ? '1' : '0'
  }, [mode, flat, popHost])
  // 每次提交后回调(插件用它挂懒加载观察器一类只读逻辑)。故意不给 deps:update 后必须再来一发。
  useLayoutEffect(() => {
    if (rootRef.current) latest.current.onRender?.(rootRef.current)
  })

  const rowOf = (row: DbRow): TableRow | undefined => rowsById.get(row.id)
  return (
    <div className="amadeus-root am-app tangu-lovable amx-plugtable" data-mode={mode} data-flat={flat ? '1' : '0'} ref={rootRef}>
      {
        <>
          <DatabaseEmbed
            target={`plugin:${pluginId}/${spec.id}`}
            pagePath={`plugin:${pluginId}`}
            db={db}
            readOnly
            cellMeta={meta}
            hideHead
            hideTools={!!spec.partial} // 分页/截断数据:筛选·搜索·统计·导出只作用于本页,会给出错误的数据视图 —— 整条工具栏不给
            popHost={popHost}
            selectedRowId={spec.selectedId ?? null}
            initialSort={initialSort.current}
            onSort={(s) => latest.current.onSort?.(s ? { key: s.colId, dir: s.dir } : null)}
            onRowOpen={spec.onRowOpen ? (row) => {
              const r = rowOf(row)
              if (r) latest.current.onRowOpen?.(r)
            } : undefined} // 规格没给开行回调就不给:恒传一个函数会让每一行都变成 role=button + 手型光标的空承诺
            rowAttrs={(row) => {
              const r = rowOf(row)
              if (!r) return {}
              // row.className 走 `class` 键:DbTable 的行会把它并进自己的 className(与降级路径 `<tr class>` 同语义)。
              return { ...(r.className ? { class: r.className } : {}), ...(safeAttrs(r.attrs) ?? {}), ...(safeAttrs(latest.current.rowAttrs?.(r)) ?? {}) }
            }}
          />
          {/* ponytail: DbTable 没有「空状态 / 表级错误文案」这两个概念,在表**下面**补一行,
              而不是去改多维表本体。表头与工具条照留 —— 与降级路径的 `<tr><td colspan=N>` 同构
              (那边同样保着表头),两条路径的信息量才对得上。 */}
          {spec.error ? <div className="amx-plugtable-error">{spec.error}</div>
            : spec.rows.length === 0 && spec.empty ? <div className="amx-plugtable-empty">{spec.empty}</div>
            : null}
        </>
      }
    </div>
  )
}

/** 挂载;同步返回 `{ update, dispose }`。规格非法**同步抛**(调用方按抛 = 降级)。 */
export function mountPluginTable(pluginId: string, el: HTMLElement, spec: TableSpec): { update(spec: TableSpec): void; dispose(): void } {
  validateTableSpec(spec)
  const popHost = document.createElement('div')
  popHost.className = 'am-app tangu-lovable amx-plugtable-pops'
  document.body.appendChild(popHost)
  let disposeRoot = mountHostReact(el, <PluginTable pluginId={pluginId} spec={spec} popHost={popHost} />)
  let disposed = false
  return {
    update: (next) => {
      if (disposed) return
      validateTableSpec(next)
      // 同一容器再 render:mountHostReact 复用同一个 root(组件实例、DOM 身份都不变),
      // 旧 disposer 因代际校验作废 —— 只保留最新那份。
      disposeRoot = mountHostReact(el, <PluginTable pluginId={pluginId} spec={next} popHost={popHost} />)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeRoot()
      popHost.remove()
    },
  }
}
