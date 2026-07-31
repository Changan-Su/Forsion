/** 删除笔记时的「附件怎么办」询问(askString 同款命令式弹窗 + Host 挂 AmadeusOverlays)。
 *
 *  只在这条笔记**独占**的附件不为空时才弹(判据在主进程 vaultIndex.exclusiveAssets:
 *  别的笔记也引用的一律不算)。勾「下次不再问」则把选择记进本机 localStorage,设置→笔记可改回「每次询问」。 */
import { useState } from 'react'
import { create } from 'zustand'
import { useEscape } from './Dialogs'

export type DeleteAssetsChoice = 'with' | 'only' | null

const KEY = 'amadeus_delete_assets'

/** 记住的选择:true=一并删,false=保留,null=每次询问。 */
export function deleteAssetsPref(): boolean | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'yes' ? true : v === 'no' ? false : null
  } catch {
    return null
  }
}

export function setDeleteAssetsPref(v: boolean | null): void {
  try {
    if (v === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, v ? 'yes' : 'no')
  } catch { /* 隐私模式等:记不住就每次问 */ }
}

interface Req {
  note: string
  assets: string[]
  resolve: (v: DeleteAssetsChoice) => void
}

const useStore = create<{ req: Req | null; open(r: Req): void; clear(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  clear: () => set({ req: null }),
}))

/** 弹窗询问;返回 'with'=连附件一起删,'only'=只删笔记,null=取消。 */
export function askDeleteAssets(note: string, assets: string[]): Promise<DeleteAssetsChoice> {
  return new Promise((resolve) => {
    useStore.getState().req?.resolve(null) // 单例:旧的先取消
    useStore.getState().open({ note, assets, resolve })
  })
}

export function DeleteAssetsHost() {
  const req = useStore((s) => s.req)
  if (!req) return null
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <Dialog key={req.note} req={req} />
    </div>
  )
}

function Dialog({ req }: { req: Req }) {
  const [remember, setRemember] = useState(false)
  const settle = (v: DeleteAssetsChoice): void => {
    if (useStore.getState().req !== req) return
    if (remember && v !== null) setDeleteAssetsPref(v === 'with')
    useStore.getState().clear()
    req.resolve(v)
  }
  useEscape(() => settle(null))
  const shown = req.assets.slice(0, 6)
  return (
    <div className="dialog-overlay" onMouseDown={() => settle(null)}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">删除「{req.note}」</div>
        <div className="dialog-msg">
          有 {req.assets.length} 个附件只被这条笔记引用，要一并删除吗？
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, opacity: 0.8 }}>
            {shown.map((a) => <li key={a}>{a}</li>)}
            {req.assets.length > shown.length && <li>…还有 {req.assets.length - shown.length} 个</li>}
          </ul>
        </div>
        <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          下次不再问（设置→笔记可改回）
        </label>
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={() => settle(null)}>取消</button>
          <button className="dialog-btn" onClick={() => settle('only')}>只删笔记</button>
          <button className="dialog-btn" data-danger autoFocus onClick={() => settle('with')}>一并删除</button>
        </div>
      </div>
    </div>
  )
}
