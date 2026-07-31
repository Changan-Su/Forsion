/** 新建白板:名字和纸张在同一个弹窗里问掉(askString 只能问名字,新建白板不该连弹两次)。
 *  纸张之后随时能在画布菜单里改,这里只是出生时的缺省。Host 挂在 AmadeusOverlays(三端共用)。 */
import { useState } from 'react'
import { create } from 'zustand'
import { useEscape } from './Dialogs'
import { PAPER_IDS, type PaperId } from '@amadeus-shared/excalidraw/board'

export interface NewDrawing {
  name: string
  paper: PaperId | null
  landscape: boolean
}

interface Req {
  title: string
  initial: string
  resolve: (v: NewDrawing | null) => void
}

const useStore = create<{ req: Req | null; open(r: Req): void; clear(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  clear: () => set({ req: null }),
}))

export function askNewDrawing(title: string, initial = ''): Promise<NewDrawing | null> {
  return new Promise((resolve) => {
    useStore.getState().req?.resolve(null) // 单例,与 askString 同款
    useStore.getState().open({ title, initial, resolve })
  })
}

export function NewDrawingHost(): React.JSX.Element | null {
  const req = useStore((s) => s.req)
  if (!req) return null
  const settle = (v: NewDrawing | null): void => {
    if (useStore.getState().req !== req) return
    useStore.getState().clear()
    req.resolve(v)
  }
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <Dialog req={req} settle={settle} />
    </div>
  )
}

function Dialog({ req, settle }: { req: Req; settle: (v: NewDrawing | null) => void }): React.JSX.Element {
  const [name, setName] = useState(req.initial)
  const [paper, setPaper] = useState<PaperId | null>(null)
  const [landscape, setLandscape] = useState(false)
  useEscape(() => settle(null))
  const submit = (): void => {
    const v = name.trim()
    settle(v ? { name: v, paper, landscape } : null)
  }
  return (
    <div className="dialog-overlay" onMouseDown={() => settle(null)}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{req.title}</div>
        <input
          className="dialog-input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="dialog-msg">纸张</div>
        <div className="amx-bs-row">
          <button className="amx-bs-chip" data-on={!paper || undefined} onClick={() => setPaper(null)}>
            无限画布
          </button>
          {PAPER_IDS.map((p) => (
            <button key={p} className="amx-bs-chip" data-on={paper === p || undefined} onClick={() => setPaper(p)}>
              {p}
            </button>
          ))}
        </div>
        {paper && (
          <div className="amx-bs-row" style={{ marginTop: 6 }}>
            <button className="amx-bs-chip" data-on={!landscape || undefined} onClick={() => setLandscape(false)}>
              纵向
            </button>
            <button className="amx-bs-chip" data-on={landscape || undefined} onClick={() => setLandscape(true)}>
              横向
            </button>
          </div>
        )}
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={() => settle(null)}>
            取消
          </button>
          <button className="dialog-btn" data-primary onClick={submit}>
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
