/**
 * Muse Space 主视图:Muse 的 Library(~/.tangu/agents/muse/Library,库外绝对路径)浏览器。
 * 左=文件清单(引擎 GET /agent/special/muse/library 递归列出;Journal 置顶、新在前),右=只读 Markdown 预览;
 * 「在编辑器中打开」= 走既有 wsfile 视图(库外 md 的编辑/原子写回/mtime 冲突保护都在那里,不重做)。
 * 活更新 = **串行**轮询清单(上一轮结束后再等 5s,不与 30s 超时的请求重叠),选中文件 mtime 变了就重读;
 * 读取带代数号,切换文件后迟到的旧读取不会盖住新文件。
 * 预览 = 真 Amadeus 渲染器(2026-09-11 起):`<UnifiedPage readOnly initial={text}>` 吃的是 initial 文本,**不经 pageStore /
 * vault 桥**;库外路径的挂载补读经 vault 桥返回 null 被 UnifiedPage 忽略(保持现状),readOnly 挡住所有写。
 * 仍**不走** pageStore/软链那条:vault 桥是单根硬钳制(vaultManager.resolveInVault),软链进库会被 collectFiles 静默跳过且
 * pageIO 会注入块标记污染 agent 的文件。已知缺口:图片走 amadeus-asset:// 单根协议 → 库外文件的相对图片 403;`[[wikilink]]`
 * 按当前 vault 解析。远程图片一律先换成占位文本 —— agent 写的 md 里一个 `![](https://…)` 就是追踪像素。非 .md 文本仍走轻量 Markdown。
 */
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, FileText, RefreshCw, ExternalLink, Sparkles } from 'lucide-react'
import { useWorkspace } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine/types'
import { Markdown } from '../components/Markdown'
import { lazyRetry } from '../lazyRetry'
import { getMuseLibrary } from '../services/backendService'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import type { MuseLibraryEntry } from '../types'

/** 真 Amadeus 只读渲染(懒加载:Milkdown 很重,不进 Muse Space 不付这笔账)。 */
const UnifiedPageLazy = lazyRetry(() => import('@amadeus/unified/UnifiedPage').then((m) => ({ default: m.UnifiedPage })))

const TEXT_EXT = /\.(md|markdown|txt|json|yaml|yml|toml|csv|log)$/i
const POLL_MS = 5000
/** 远程图片 → 占位文本(不发网络请求)。本地/相对图片路径在库外本就渲染不出,一并占位。 */
const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

/** 清单排序:Journal/ 目录里的按名倒序(新日期在前)且整组置顶;其余按路径。目录项不列(用文件路径自带层级)。 */
export function orderFiles(files: MuseLibraryEntry[]): MuseLibraryEntry[] {
  const list = files.filter((f) => !f.dir)
  const isJ = (p: string): boolean => p.startsWith('Journal/')
  return list.sort((a, b) => {
    if (isJ(a.path) !== isJ(b.path)) return isJ(a.path) ? -1 : 1
    if (isJ(a.path)) return b.path.localeCompare(a.path)
    return a.path.localeCompare(b.path)
  })
}

/** fs:readFile 回的是 base64(二进制/文本同一条路),文本要按 UTF-8 解回来(atob 只到 Latin-1)。 */
function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8').decode(bytes)
  } catch { return '' }
}

export function neutralizeRemoteImages(md: string): string {
  return md.replace(IMG_RE, (_m, alt: string, url: string) => `[image${alt ? `: ${alt}` : ''} — ${url}]`)
}

export const MuseLibraryView: React.FC<ViewProps> = () => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const [root, setRoot] = useState('')
  const [files, setFiles] = useState<MuseLibraryEntry[]>([])
  const [sel, setSel] = useState('')
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const selRef = useRef('')
  /** 上次**成功**读到的 {path, mtime}:只在成功后记,失败下一轮自然重试。 */
  const loadedRef = useRef<{ path: string; mtime: number } | null>(null)
  const genRef = useRef(0)
  const ordered = useMemo(() => orderFiles(files), [files])

  const read = async (base: string, f: MuseLibraryEntry): Promise<void> => {
    const gen = ++genRef.current
    if (!TEXT_EXT.test(f.path)) { setText(''); loadedRef.current = { path: f.path, mtime: f.mtime }; return }
    const readHost = window.tangu?.readHostFile
    if (!readHost) { setText(''); return } // 无 host 桥(Web)本视图本就不注册;类型上仍要兜
    try {
      const r = await readHost(`${base}/${f.path}`)
      if (gen !== genRef.current) return // 期间切了文件/来了新一轮:这份是旧的
      setText(r.tooLarge ? `(${r.size} bytes)` : decodeBase64Utf8(String(r.content || '')))
      setErr('')
      loadedRef.current = { path: f.path, mtime: f.mtime }
    } catch (e: any) {
      if (gen === genRef.current) setErr(e?.message || String(e))
    }
  }
  const load = async (): Promise<void> => {
    try {
      const r = await getMuseLibrary(cfg)
      setRoot(r.root)
      setFiles(r.files)
      setErr('')
      const list = orderFiles(r.files)
      const cur = list.find((f) => f.path === selRef.current)
      if (cur) {
        const done = loadedRef.current
        if (!done || done.path !== cur.path || done.mtime !== cur.mtime) await read(r.root, cur) // 首读 / Muse 刚写过 → 重读
      } else if (list.length) {
        selRef.current = list[0].path
        setSel(list[0].path)
        await read(r.root, list[0])
      } else {
        selRef.current = ''
        setSel('')
        setText('')
        loadedRef.current = null
      }
    } catch (e: any) {
      setErr(e?.message || String(e))
    }
  }
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const loop = async (): Promise<void> => {
      if (!alive) return
      await load()
      if (alive) timer = setTimeout(() => void loop(), POLL_MS)
    }
    void loop()
    return () => { alive = false; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg])

  const pick = (f: MuseLibraryEntry): void => { selRef.current = f.path; setSel(f.path); void read(root, f) }
  const openInEditor = (): void => {
    if (!root || !sel) return
    useWorkspace.getState().openView('wsfile', { path: `${root}/${sel}`, name: sel.split(/[\\/]/).pop() || sel }, 'main', { newTab: true })
  }
  const shown = useMemo(() => neutralizeRemoteImages(text), [text])

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, minWidth: 0 }}>
      <div style={{ width: 240, flex: 'none', borderRight: 'var(--border-width, 1px) solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', fontWeight: 600, fontSize: 13 }}>
          <Sparkles size={14} /> {t('view.museLibrary')}
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title={t('muse.lib.refresh')} onClick={() => void load()}><RefreshCw size={13} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '0 6px 8px' }}>
          {ordered.length === 0 && <div className="hint" style={{ padding: '4px 6px' }}>{err || t('muse.lib.empty')}</div>}
          {ordered.map((f) => (
            <div
              key={f.path}
              className="file-row"
              onClick={() => pick(f)}
              style={{ alignItems: 'center', background: f.path === sel ? 'var(--overlay-light, rgba(127,127,127,.1))' : undefined, borderRadius: 'var(--radius-sm)' }}
            >
              {f.path.startsWith('Journal/') ? <FileText size={13} /> : <FolderOpen size={13} />}
              <span className="file-name" style={{ flex: 1, fontSize: 12.5 }}>{f.path}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: 'var(--border-width, 1px) solid var(--border)', fontSize: 12.5, color: 'var(--text-muted)' }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sel ? `${root}/${sel}` : ''}>{sel}</span>
          {sel && <button className="btn ghost sm" onClick={openInEditor}><ExternalLink size={12} /> {t('muse.lib.openEditor')}</button>}
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '14px 24px 40px' }}>
          {err && <div className="hint" style={{ color: 'var(--danger)' }}>{err}</div>}
          {sel && shown && (/\.md$/i.test(sel) ? (
            <div className="am-app tangu-lovable amx-pane amx-editor" data-muse-lib-preview="amadeus">
              <Suspense fallback={<div className="hint">{sel}</div>}>
                <UnifiedPageLazy key={`${root}/${sel}`} path={`${root}/${sel}`} initial={shown} readOnly />
              </Suspense>
            </div>
          ) : <Markdown content={shown} />)}
          {sel && !shown && !err && <div className="hint">{sel}</div>}
        </div>
      </div>
    </div>
  )
}
