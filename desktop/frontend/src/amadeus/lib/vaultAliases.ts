// 全库 fm 别名表(path → aliases;L-13 `[[` 补全)。真源是主进程索引(amadeus.pageAliases,可选接口:缺位端恒空表)。
// 不进 pageStore 的仓库级镜像:只有补全面板读它,挂载时按「库根 + 链接图版本」懒取、模块级缓存,改了 fm 后
// linkGraphVersion 一跳就会重取。非笔记库宿主(PlainMarkdownEditor 传空页面表)的调用方按页面表过滤,不会串进来。
import { useEffect, useState } from 'react'
import { amadeus } from '../api'
import { usePageStore } from '../store/pageStore'

let cache: { key: string; map: Record<string, string[]> } | null = null

export function useVaultAliases(): Record<string, string[]> {
  const root = usePageStore((s) => s.vaultRoot)
  const version = usePageStore((s) => s.linkGraphVersion)
  const key = `${root ?? ''}\u0000${version}`
  const [map, setMap] = useState<Record<string, string[]>>(() => cache?.map ?? {})
  useEffect(() => {
    if (cache?.key === key) { setMap(cache.map); return }
    let live = true
    void amadeus?.pageAliases?.().then((m) => {
      cache = { key, map: m ?? {} }
      if (live) setMap(cache.map)
    }).catch(() => {})
    return () => { live = false }
  }, [key])
  return map
}
