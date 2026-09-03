/**
 * `.dashboard.md` 的入口:按文件自己声明的布局模式分派。
 *
 *  · 缺省 / `dashLayout: grid` → **结构化网格**(DashboardGridView):卡片按顺序流进 12 列参考网格,
 *    随窗口重排。这是 2026-08-27 拍板的默认 —— 「用户只决定放什么、多大,不决定放哪」。
 *  · `dashLayout: canvas`      → **自由摆位**(DashboardCanvasView):原画布版原样保留,一个字没改,
 *    连同 `dashboard2:` 布局键与它那 121 条仪器。它现在是「高级」,不是默认。
 *
 * 分派要读 frontmatter,所以本文件负责装载页面;两个子视图各自的 loadPage 是幂等的(路径相同即跳过),
 * 不会重复拉盘。骨架屏而不是空白/转圈 —— 加载分支的既有纪律。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ViewProps } from '@lcl/engine'
import { Skeleton } from '@lcl/engine'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { PageScopeCtx, disposePageScope, usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { readDash2Layout } from '@amadeus-shared/dashboard'
import { readDash3Layout, readDashMode } from '@amadeus-shared/dashboard3'
import { DashboardCanvasView } from './DashboardCanvasView'
import { DashboardGridView } from './DashboardGridView'

export function DashboardView(props: ViewProps) {
  return (
    <PageScopeCtx.Provider value={props.leaf.id}>
      <DashboardRouter {...props} />
    </PageScopeCtx.Provider>
  )
}

function DashboardRouter(props: ViewProps) {
  const dashPath = typeof props.leaf.params.dashPath === 'string' ? props.leaf.params.dashPath : ''
  const store = useScopedPageStore()
  const activePage = usePageStore((s) => s.activePage)
  const loadError = usePageStore((s) => s.error)
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  const reduceMotion = useReducedMotion()
  /** ⚠️ vaultRoot 必须进 deps:启动时 vault 是**懒引导 + 异步**的,而本视图一挂载就读盘 ——
   *  库还没打开那一发 loadPage 必失败(主进程 requireRoot 抛),activePage 永远落不了地,
   *  于是下面那句 Skeleton 就成了**永久骨架屏**(用户实报:一进 ERP Space 就一直显示在加载)。
   *  库落地/切库都会让这支重跑,拿到内容。同族:多维表走 dbStore 的 gen。 */
  const vaultRoot = usePageStore((s) => s.vaultRoot)

  /** 「**本页**这一发装载失败了」——绑到具体路径,不能直接看 pageStore.error:那是本 scope 的通用错误
   *  (上一页的保存/改名也会留下),正常切页时会在 effect 跑起来之前先闪一帧「打不开新页:旧错误」
   *  (codex 2026-09-02 [medium])。 */
  const [failedPath, setFailedPath] = useState<string | null>(null)
  useEffect(() => {
    if (!dashPath || dashPath === store.getState().activePage) return
    setFailedPath(null)
    // loadPage 自己吞异常(失败时只置 error/status),所以判成败看它有没有把 activePage 换过来。
    void store.getState().loadPage(dashPath).then(() => {
      // 库还没落地那一发**不算失败**(它必失败,且落地后本 effect 会重跑)—— 否则启动时先闪一帧红。
      if (vaultRoot && store.getState().activePage !== dashPath) setFailedPath(dashPath)
    })
  }, [dashPath, vaultRoot]) // eslint-disable-line react-hooks/exhaustive-deps

  // ⚠️ scope 的销毁**只在这一层**。放在两个子视图里的话,grid ↔ canvas 互换时旧视图的 cleanup
  //    会把新视图已经取到手的那份 store 摘成孤儿 —— 之后全局访问会另建一份空 store,保存/广播/
  //    界面状态当场分叉(Codex 2026-08-27 评审 P1)。路由在则 scope 在,这是唯一的生命周期。
  useEffect(() => () => disposePageScope(props.leaf.id), [props.leaf.id])

  /** 没有显式声明时,按**文件里已经有哪把布局键**判 —— 老的自由摆位仪表盘打开后必须还是它自己
   *  的样子(升级由画布版里的横幅让用户点,绝不自动换)。空文件/新建 → 网格,这是新的默认。 */
  const mode = useMemo(() => {
    const explicit = readDashMode(fmExtra)
    if (explicit) return explicit
    const g = readDash3Layout(fmExtra)
    if (g.ok && Object.keys(g.layout).length) return 'grid'
    const c = readDash2Layout(fmExtra)
    if (c.ok && Object.keys(c.layout).length) return 'canvas'
    return 'grid'
  }, [fmExtra])

  // ⚠️ 装载完成前不能先渲染缺省分支:老的自由摆位仪表盘会先闪一帧网格版再跳回去。
  // 但**失败要说出来**:骨架屏是「在加载」,不是「加载不出来」——把错误吞进无尽骨架屏正是
  // 骨架屏纪律要防的那件事(文件被删/改名时也走这里)。
  if (dashPath && activePage !== dashPath) {
    return failedPath === dashPath
      ? <div className="amx-db amx-db-state">打不开仪表盘 <code>{dashPath}</code>{loadError ? `:${loadError}` : ''}</div>
      : <Skeleton variant="document" />
  }
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        key={mode}
        className="dash-router-page"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.992, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.992, y: -3 }}
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        {mode === 'canvas' ? <DashboardCanvasView {...props} /> : <DashboardGridView {...props} />}
      </motion.div>
    </AnimatePresence>
  )
}
