/** 独立 PDF 视图:树上点 .pdf / 笔记里点 [[x.pdf#page=N]] 在应用内打开可批注阅读器。
 *  多实例(params.pdfPath 认领文件、随布局持久化);批注写进 PDF 本身,见 PdfAnnotator。
 *  PdfAnnotator 懒加载 —— pdf.js viewer 较重,只在真的打开 PDF 时才拉那块 chunk(不进主包)。 */
import { Suspense, useEffect } from 'react'
import { Skeleton } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { lazyRetry } from '../lazyRetry'
import { useTheme } from '../stores/themeStore'
import { usePageStore } from '@amadeus/store/pageStore'

const PdfAnnotator = lazyRetry(() => import('@amadeus/pdf/PdfAnnotator').then((m) => ({ default: m.PdfAnnotator })))

const pdfBase = (p: string): string => p.split(/[\\/]/).pop() || p

export function AmadeusPdfView({ leaf }: ViewProps) {
  const pdfPath = typeof leaf.params.pdfPath === 'string' ? leaf.params.pdfPath : ''
  const page = typeof leaf.params.page === 'number' ? leaf.params.page : undefined
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  // Vault 是否已打开(root 落地)。启动时 dockview 会恢复上次的 PDF tab,而 restoreVault 是 void 异步调用——
  // 若在 root 落地前就读字节 → 主进程「No vault is open」。gate 住:vault ready 前不挂 PdfAnnotator(不读字节)。
  const vaultReady = usePageStore((s) => !!s.vaultRoot)
  // navigateLeaf 会把标题重置为 displayName,挂载/换文件后设回 PDF 名(AmadeusDbView 同款)。
  useEffect(() => {
    if (pdfPath) leaf.setTitle(pdfBase(pdfPath))
  }, [pdfPath]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!pdfPath) return <div className="amx-db amx-db-state">未指定 PDF 文件。</div>
  return (
    // 内联 height 兜底:懒加载 fallback 阶段 pdfAnnotator.css 尚未到,先保证外壳撑满面板。
    <div className="am-app tangu-lovable amx-pane amx-pdfview" data-mode={mode} data-flat={flat ? '1' : '0'} style={{ height: '100%' }}>
      {vaultReady ? (
        <Suspense fallback={<Skeleton variant="document" />}>
          <PdfAnnotator pdfPath={pdfPath} initialPage={page} />
        </Suspense>
      ) : (
        <div style={{ padding: 24, color: 'var(--text-muted, #888)' }}>等待 Vault 打开…</div>
      )}
    </div>
  )
}
