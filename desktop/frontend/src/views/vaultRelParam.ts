import { useEffect } from 'react'
import { useWorkspace, type ViewProps } from '@lcl/engine'
import { usePageStore } from '@amadeus/store/pageStore'
import { slashRel } from '@amadeus/lib/vaultFiles'

/** leaf 参数里的库内路径。老版本在 Windows 上存下的标签是 `a\b.md`:读到就把 `/` 的写法写回 leaf(随布局存盘,只改这一次),
 *  此后改名跟随、「已经开着就切过去」才比得上 —— 主进程现在一律给 `/`。
 *  仪表盘卡片不是工作区 leaf(参数写在仪表盘笔记的源码里):只在读的时候换,不为这个去改用户的文件。 */
export function useVaultRelParam(leaf: ViewProps['leaf'], key: string): string {
  const raw = typeof leaf.params[key] === 'string' ? (leaf.params[key] as string) : ''
  const rel = slashRel(raw, usePageStore((s) => s.vaultRoot))
  useEffect(() => {
    if (rel === raw) return
    const cur = useWorkspace.getState().leafById(leaf.id)
    if (cur) leaf.setParams({ ...cur.params, [key]: rel })
  }, [rel, raw]) // eslint-disable-line react-hooks/exhaustive-deps
  return rel
}
