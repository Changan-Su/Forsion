/** 独立图片视图:树上点 .png/.jpg 等 / 笔记里点图片文件 在应用内查看(参考 PDF 视图,无批注)。
 *  经 amadeus-asset:// 协议直出(桌面主进程按 vault 解析 / web 走 HTTP),无需手动读字节。
 *  多实例(params.imagePath 认领文件、随布局持久化)。点击图片在「适应窗口 ↔ 原始尺寸」间切换。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ViewProps } from '@lcl/engine'
import { useVisualTheme as useTheme } from '../stores/themeStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { toAssetUrl } from '@amadeus-shared/assets'
import { useVaultRelParam } from './vaultRelParam'
import { fileViewKey, readFileView, writeFileView } from '@amadeus/lib/fileViewMemory'

const imgBase = (p: string): string => p.split(/[\\/]/).pop() || p

export function AmadeusImageView({ leaf }: ViewProps) {
  const imagePath = useVaultRelParam(leaf, 'imagePath')
  const mode = useTheme((s) => s.mode)
  // 同 PDF:asset:// 协议按「当前打开的 vault」解析,启动恢复 tab 时 vault 可能还没 open →
  // 先不挂 <img>(否则碎图,且 vault 就绪后 src 不变不会自愈)。vaultRoot 落地即重渲挂载。
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const vaultReady = !!vaultRoot
  return <ImageFile key={fileViewKey('image', vaultRoot, imagePath)} {...{ leaf, imagePath, mode, vaultReady, vaultRoot }} />
}

function ImageFile({ leaf, imagePath, mode, vaultReady, vaultRoot }: { leaf: ViewProps['leaf']; imagePath: string; mode: string; vaultReady: boolean; vaultRoot: string | null }) {
  const memoryKey = fileViewKey('image', vaultRoot, imagePath)
  const [saved] = useState(() => readFileView('image', memoryKey))
  const [actual, setActual] = useState(saved?.actual ?? false)
  const scroll = useRef<HTMLDivElement>(null)
  const restoring = useRef(!!saved)
  const restore = (): void => {
    if (!restoring.current || !scroll.current) return
    scroll.current.scrollTop = saved?.top ?? 0
    scroll.current.scrollLeft = saved?.left ?? 0
    restoring.current = false
  }
  useLayoutEffect(() => {
    if (scroll.current?.querySelector('img')?.complete) restore()
  }, [])
  // navigateLeaf 会把标题重置为 displayName,挂载/换文件后设回图片名(AmadeusPdfView 同款);换文件回到适应窗口。
  useEffect(() => {
    if (imagePath) leaf.setTitle(imgBase(imagePath))
  }, [imagePath]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!imagePath) return <div className="amx-db amx-db-state">未指定图片文件。</div>
  return (
    <div className="am-app tangu-lovable amx-pane amx-imgview" data-mode={mode}>
      {vaultReady ? (
        <div ref={scroll} className={`amx-imgview-scroll${actual ? ' actual' : ''}`}
          onScroll={(e) => { if (!restoring.current && e.currentTarget.isConnected) writeFileView('image', memoryKey, { actual, top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft }) }}>
          <img
            className="amx-imgview-img"
            src={toAssetUrl(imagePath)}
            alt={imgBase(imagePath)}
            onLoad={restore}
            onClick={() => { restoring.current = false; setActual(!actual); writeFileView('image', memoryKey, { actual: !actual, top: 0, left: 0 }) }}
            draggable={false}
          />
        </div>
      ) : (
        <div style={{ padding: 24, color: 'var(--text-muted, #888)' }}>等待 Vault 打开…</div>
      )}
    </div>
  )
}
