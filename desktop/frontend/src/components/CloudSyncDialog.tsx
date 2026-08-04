/** 「开启云同步」弹窗:递归关联勾选(关联笔记/附件分组、默认全选)+ 云名冲突两路处理
 *  (换名重试 / 显式合并进现有云文件夹)。命令式打开(openCloudSyncDialog),
 *  Host 挂 AmadeusOverlays(askString 同款模式);数据面 = window.amadeusSync.entrySync*。 */
import { useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Cloud, FileText, ListTree, Paperclip } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { isExcludedPath, useEntrySync } from '../stores/entrySyncStore'

interface Req {
  path: string
  kind: 'page' | 'folder' | 'asset'
}

const useDialogStore = create<{ req: Req | null; open(r: Req): void; close(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  close: () => set({ req: null }),
}))

export function openCloudSyncDialog(path: string, kind: 'page' | 'folder' | 'asset'): void {
  useDialogStore.getState().open({ path, kind })
}

const base = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')

export function CloudSyncDialogHost() {
  const req = useDialogStore((s) => s.req)
  if (!req) return null
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <Dialog key={`${req.kind}:${req.path}`} req={req} onClose={() => useDialogStore.getState().close()} />
    </div>
  )
}

function Dialog({ req, onClose }: { req: Req; onClose: () => void }) {
  const [closure, setClosure] = useState<{ pages: string[]; files: string[]; subPages: string[] } | null>(null)
  const [pagesOn, setPagesOn] = useState<Set<string>>(new Set())
  const [filesOn, setFilesOn] = useState<Set<string>>(new Set())
  const [subOn, setSubOn] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')

  useEffect(() => {
    let alive = true
    if (req.kind === 'asset') {
      setClosure({ pages: [], files: [], subPages: [] }) // 附件无出链,闭包恒空(entrySyncClosure 只吃 page|folder)
      return
    }
    void window.amadeusSync
      ?.entrySyncClosure?.(req.path, req.kind)
      .then((r) => {
        if (!alive) return
        setClosure({ ...r, subPages: r.subPages ?? [] }) // subPages:旧主进程构建没有 → 当空
        setPagesOn(new Set(r.pages)) // 默认全选:用户要的是「保留相对位置的完整同步」,少勾是例外
        setFilesOn(new Set(r.files))
        // 子页面同样默认全选,但上次剔除过的保持未勾选 —— 否则重开弹窗会显示「全含」而实际仍排除。
        const root = useEntrySync.getState().activeRoot
        setSubOn(new Set((r.subPages ?? []).filter((p) => !isExcludedPath(root, p))))
      })
      .catch(() => alive && setClosure({ pages: [], files: [], subPages: [] }))
    return () => {
      alive = false
    }
  }, [req.path, req.kind])

  const submit = async (opts?: { cloudName?: string; merge?: boolean }): Promise<void> => {
    const api = window.amadeusSync
    if (!api?.entrySyncEnable || busy) return
    setBusy(true)
    const entries = [
      { path: req.path, kind: req.kind },
      ...[...pagesOn].map((p) => ({ path: p, kind: 'page' as const })),
      ...[...filesOn].map((p) => ({ path: p, kind: 'asset' as const })),
    ]
    // 子页面本来就随页进 scope:取消勾选的显式剔除,勾上的显式解除剔除(可能是上次剔的,不送就一直排除着)。
    const subPages = closure?.subPages ?? []
    const exclude = subPages.filter((p) => !subOn.has(p))
    const include = subPages.filter((p) => subOn.has(p))
    type EnableResp = { ok?: boolean; cloudName?: string; conflict?: string; error?: string }
    const r: EnableResp = await api.entrySyncEnable({ entries, exclude, include, ...opts }).catch((e: unknown) => ({ error: String(e) }))
    setBusy(false)
    if (r?.conflict) {
      setConflict(r.conflict)
      setNameDraft(`${r.conflict} 2`)
      return
    }
    if (r?.error || !r?.ok) {
      useApp.getState().toast(r?.error || '开启云同步失败', true)
      return
    }
    useApp.getState().toast(`已开启云同步:云端「${r.cloudName}」`)
    void useEntrySync.getState().refresh()
    onClose()
  }

  /** `A.fd/B.fd/C.md` 的上级子页面链(近→远:A.fd/B.md、A.md);种子页不在 subPages 里,自然被滤掉。 */
  const subAncestors = (p: string): string[] => {
    const out: string[] = []
    for (let cur = p; ; ) {
      const i = cur.lastIndexOf('.fd/')
      if (i < 0) return out
      cur = `${cur.slice(0, i)}.md`
      out.push(cur)
    }
  }

  /** 子页面勾选级联:exclude 是子树语义 —— 取消勾选连带子树(父级排除了孩子留着勾也没用),
   *  勾上则连带上级(祖先还排除着,单独勾孩子同样不生效)。不级联的话界面会撒谎。 */
  const toggleSub = (p: string): void =>
    setSubOn((s) => {
      const on = !s.has(p)
      const all = closure?.subPages ?? []
      const sub = `${p.replace(/\.md$/i, '')}.fd/`
      const n = new Set(s)
      for (const k of all) {
        if (k !== p && !k.startsWith(sub)) continue
        on ? n.add(k) : n.delete(k)
      }
      if (on) for (const a of subAncestors(p)) if (all.includes(a)) n.add(a)
      return n
    })

  const toggleIn = (set0: Set<string>, p: string): Set<string> => {
    const n = new Set(set0)
    n.has(p) ? n.delete(p) : n.add(p)
    return n
  }

  const group = (
    icon: ReactNode,
    label: string,
    items: string[],
    on: Set<string>,
    flip: (p: string) => void,
    flipAll: (all: boolean) => void,
  ): ReactNode =>
    items.length > 0 && (
      <div className="amx-csd-group">
        <div className="amx-csd-head">
          {icon}
          <span>
            {label}({on.size}/{items.length})
          </span>
          <button className="amx-csd-all" onClick={() => flipAll(on.size < items.length)}>
            {on.size < items.length ? '全选' : '全不选'}
          </button>
        </div>
        <div className="amx-csd-list">
          {items.map((p) => (
            <label key={p} className="amx-csd-item" title={p}>
              <input type="checkbox" checked={on.has(p)} onChange={() => flip(p)} />
              <span>{base(p)}</span>
              <span className="amx-csd-path">{p}</span>
            </label>
          ))}
        </div>
      </div>
    )

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog amx-csd" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          <Cloud size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
          开启云同步
        </div>
        {conflict ? (
          <>
            <div className="dialog-msg">
              云端工作区根目录已有「{conflict}」。可以换一个云端文件夹名,或把本 Vault 的同步内容合并进现有文件夹
              (换机后重新开启同步时选「合并」)。
            </div>
            <input
              className="dialog-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="新的云端文件夹名"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nameDraft.trim()) void submit({ cloudName: nameDraft.trim() })
                if (e.key === 'Escape') onClose()
              }}
            />
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={onClose}>取消</button>
              <button className="dialog-btn" disabled={busy} onClick={() => void submit({ cloudName: conflict, merge: true })}>
                合并进「{conflict}」
              </button>
              <button className="dialog-btn" data-primary disabled={busy || !nameDraft.trim()} onClick={() => void submit({ cloudName: nameDraft.trim() })}>
                用新名字开启
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-msg">
              「{base(req.path)}」将带完整相对路径同步到云端工作区(双向)。子页面与库内关联默认一并纳入,
              保留 Vault 里的相对位置;取消勾选即不同步:
            </div>
            {closure === null ? (
              <div className="dialog-msg">正在分析关联…</div>
            ) : (
              <>
                {group(<ListTree size={12} />, '子页面', closure.subPages, subOn, toggleSub, (all) => setSubOn(all ? new Set(closure.subPages) : new Set()))}
                {group(<FileText size={12} />, '关联笔记', closure.pages, pagesOn, (p) => setPagesOn((s) => toggleIn(s, p)), (all) => setPagesOn(all ? new Set(closure.pages) : new Set()))}
                {group(<Paperclip size={12} />, '附件', closure.files, filesOn, (p) => setFilesOn((s) => toggleIn(s, p)), (all) => setFilesOn(all ? new Set(closure.files) : new Set()))}
                {!closure.pages.length && !closure.files.length && !closure.subPages.length && (
                  <div className="dialog-msg" style={{ opacity: 0.6 }}>没有子页面与库内关联,仅同步此条目。</div>
                )}
              </>
            )}
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={onClose}>取消</button>
              <button className="dialog-btn" data-primary disabled={busy || closure === null} onClick={() => void submit()}>
                {busy ? '开启中…' : '开启同步'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
