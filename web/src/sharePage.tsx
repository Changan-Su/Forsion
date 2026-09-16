/**
 * P3/P4 公开分享 viewer 入口(/share/<token>):无鉴权、不加载主应用。
 * 2026-09-07 起正文由生产 UnifiedPage(readOnly)渲染(shareViewer),本文件只做三件事、顺序不可换:
 *   ① 拉 meta + tree(一次网络往返)→ ② 装只读桥 window.amadeus(amadeus/shareBridge)→ ③ 动态 import shareViewer 挂载。
 * ⚠️ ②必须先于③:shareViewer 的 import 图会拉到 amadeus/api.ts(模块级抓 window.amadeus)与 dbStore(模块级订阅事件),
 *    抓到 undefined 之后再往 window 上补就晚了(与 web/src/main.tsx 主线「先装桥再 import('@/main')」同一条纪律)。
 */
import { getApiBase } from './webShim'
import { installShareBridge, type ShareTree } from './amadeus/shareBridge'
import { registerMessages, translate } from '@/i18n'

registerMessages({
  'sharepage.rateLimited': { zh: '访问过于频繁,稍后再试', en: 'Too many requests — please try again later' },
  'sharepage.gone': { zh: '分享不存在或已撤销', en: 'This share does not exist or has been revoked' },
  'sharepage.loadFailed': { zh: '加载失败', en: 'Failed to load' },
})

interface ShareMeta { mode: 'page' | 'subtree'; path: string; title: string }

function showMessage(text: string): void {
  const el = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'))
  el.innerHTML = ''
  const d = document.createElement('div')
  d.style.cssText = 'padding:48px;text-align:center;font:15px/1.6 -apple-system,"PingFang SC","Segoe UI",Roboto,sans-serif;opacity:.75'
  d.textContent = text
  el.appendChild(d)
}

async function boot(token: string, api = getApiBase()): Promise<void> {
  const base = `${api}/amadeus/public/shares/${encodeURIComponent(token)}`
  let meta: ShareMeta
  try {
    const r = await fetch(base)
    if (!r.ok) {
      showMessage(r.status === 429 ? translate('sharepage.rateLimited') : translate('sharepage.gone'))
      return
    }
    meta = (await r.json()) as ShareMeta
  } catch {
    showMessage(translate('sharepage.loadFailed'))
    return
  }
  // page 模式也拿 /tree(根页 + <stem>.fd 子页):[[链接]] / 跨笔记嵌入 / 悬停预览都靠这份名册解析。
  // 点开头路径段 = 内部件(.forsion-vault.md、.trash…),对外一律隐身,与三端树同尺子。
  let tree: ShareTree = { root: meta.path, pages: [meta.path], folders: [] }
  try {
    const tr = await fetch(`${base}/tree`)
    if (tr.ok) {
      const raw = (await tr.json()) as ShareTree
      const vis = (p: string): boolean => !p.split('/').some((seg) => seg.startsWith('.'))
      tree = { root: raw.root, pages: raw.pages.filter(vis), folders: raw.folders.filter(vis) }
    }
  } catch { /* 树拿不到只渲染根页 */ }
  if (meta.mode === 'page' && !tree.pages.includes(meta.path)) tree.pages.unshift(meta.path)
  const shared = { tree, current: meta.path as string | null }
  installShareBridge({ apiBase: api, token, tree: () => shared.tree, currentPage: () => shared.current })
  const m = await import('./shareViewer')
  m.mountShareViewer({ token, base, meta, tree, onCurrentChange: (p) => { shared.current = p } })
}

export function mountSharePage(token: string, options?: { apiBase: string }): void {
  boot(token, options?.apiBase).catch((e) => {
    console.error('[share] boot failed:', e)
    showMessage(translate('sharepage.loadFailed'))
  })
}
