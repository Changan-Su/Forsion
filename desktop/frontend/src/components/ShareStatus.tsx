// 编辑器工具条状态指示(字数统计左边):本页正在「协作共享」或「公开发布」时露出小标记,
// 点击打开 ShareCard。发布态含「被上级文件夹发布覆盖」(与 ShareCard 共用 publishStateFor)。
// 无 collab(纯本地/无云)或两态皆无 → 不渲染。

import { useEffect, useState, type MouseEvent } from 'react'
import { Users, Globe2 } from 'lucide-react'
import { publishStateFor, type PublishState } from '../amadeus/lib/shareState'

const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

export function ShareStatus({ path, refreshKey, onOpen }: {
  path: string
  refreshKey?: number // ShareCard 关闭后 bump 一下重新拉取
  onOpen: (x: number, y: number) => void
}) {
  const collab = window.amadeusCollab
  const [shared, setShared] = useState(false)
  const [pub, setPub] = useState<PublishState>({ kind: 'none' })

  useEffect(() => {
    if (!collab || !path) { setShared(false); setPub({ kind: 'none' }); return }
    let alive = true
    // pageShare/publishes 都要 owner;非 owner(参与者页)会 404 → 静默不显示。
    void collab.pageShare(path).then((r) => alive && setShared(!!r.share)).catch(() => alive && setShared(false))
    void collab.publishes().then((r) => alive && setPub(publishStateFor(path, r.shares))).catch(() => alive && setPub({ kind: 'none' }))
    return () => { alive = false }
  }, [collab, path, refreshKey])

  if (!collab) return null
  const isPub = pub.kind !== 'none'
  if (!shared && !isPub) return null

  const open = (e: MouseEvent): void => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    onOpen(r.right, r.bottom)
  }
  return (
    <span className="amx-sharestat">
      {shared && (
        <button className="amx-sharestat-chip is-collab" title="本页正在协作共享 · 点击管理" onClick={open}>
          <Users size={12} /> 协作中
        </button>
      )}
      {isPub && (
        <button
          className="amx-sharestat-chip is-pub"
          title={pub.kind === 'inherited' ? `已通过上级《${baseName(pub.via)}》发布 · 点击查看` : '本页已公开发布 · 点击管理'}
          onClick={open}
        >
          <Globe2 size={12} /> {pub.kind === 'inherited' ? '已随文件夹发布' : '已发布'}
        </button>
      )}
    </span>
  )
}
