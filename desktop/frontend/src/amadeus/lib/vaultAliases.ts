// 全库 fm 别名表(path → aliases;快速查找与 `[[` 补全)。真源是主进程索引(amadeus.pageAliases,可选接口:缺位端恒空表)。
// 不进 pageStore 的仓库级镜像:面板挂载时按「库根 + 链接图版本」懒取、模块级缓存,改了 fm 后
// linkGraphVersion 一跳就会重取。非笔记库宿主(PlainMarkdownEditor 传空页面表)的调用方按页面表过滤,不会串进来。
import { useEffect, useState } from 'react'
import { amadeus } from '../api'
import { usePageStore } from '../store/pageStore'

type Snapshot = { key: string; map: Record<string, string[]> }
const empty: Record<string, string[]> = {}
let cache: Snapshot | null = null

export function useVaultAliases() {
  const root = usePageStore((s) => s.vaultRoot)
  const version = usePageStore((s) => s.linkGraphVersion)
  const key = `${root ?? ''}\u0000${version}`
  const [snapshot, setSnapshot] = useState(cache)
  const source = snapshot?.key === key ? snapshot : cache?.key === key ? cache : null
  const supported = !!amadeus?.pageAliases
  useEffect(() => {
    if (!supported) return
    if (cache?.key === key) { setSnapshot(cache); return }
    let live = true
    void amadeus.pageAliases!().then((m) => {
      if (!live) return
      cache = { key, map: m ?? empty }
      setSnapshot(cache)
    }).catch(() => { if (live) setSnapshot({ key, map: empty }) })
    return () => { live = false }
  }, [key, supported])
  return { aliases: supported ? source?.map ?? empty : empty, pending: supported && !source }
}
