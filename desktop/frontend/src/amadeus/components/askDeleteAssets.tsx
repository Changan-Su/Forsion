/** 删除笔记时的「附件怎么办」询问(askString 同款命令式弹窗 + Host 挂 AmadeusOverlays)。
 *
 *  只在这条笔记**独占**的附件不为空时才弹(判据在主进程 vaultIndex.exclusiveAssets:
 *  别的笔记也引用的一律不算)。勾「下次不再问」则把选择记进本机 localStorage,设置→笔记可改回「每次询问」。 */
import { useState } from 'react'
import { create } from 'zustand'
import { useEscape } from './Dialogs'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'delassets.blockTitle': { zh: '引用块已删除', en: 'Reference block deleted' },
  'delassets.noteTitle': { zh: '删除「{name}」', en: 'Delete "{name}"' },
  'delassets.blockMsg': { zh: '这 {n} 个文件只被这条笔记引用，要一并从磁盘删除吗？', en: 'These {n} files are only referenced by this note. Delete them from disk too?' },
  'delassets.noteMsg': { zh: '有 {n} 个附件只被这条笔记引用，要一并删除吗？', en: '{n} attachments are only referenced by this note. Delete them too?' },
  'delassets.more': { zh: '…还有 {n} 个', en: '…and {n} more' },
  'delassets.remember': { zh: '下次不再问（设置→笔记可改回）', en: "Don't ask again (change it back in Settings → Notes)" },
  'delassets.keepFiles': { zh: '保留文件', en: 'Keep files' },
  'delassets.cancel': { zh: '取消', en: 'Cancel' },
  'delassets.noteOnly': { zh: '只删笔记', en: 'Delete note only' },
  'delassets.deleteAll': { zh: '一并删除', en: 'Delete them too' },
})

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
  /** 删的是笔记里的一个**引用块**(块已经删了,这里只处置文件):换文案、不给「下次不再问」
   *  —— 那个偏好记的是「删笔记时附件怎么办」,两个决定不该互相顶。 */
  block?: boolean
  resolve: (v: DeleteAssetsChoice) => void
}

const useStore = create<{ req: Req | null; open(r: Req): void; clear(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  clear: () => set({ req: null }),
}))

/** 弹窗询问;返回 'with'=连附件一起删,'only'=只删笔记,null=取消。 */
export function askDeleteAssets(note: string, assets: string[], opts?: { block?: boolean }): Promise<DeleteAssetsChoice> {
  return new Promise((resolve) => {
    useStore.getState().req?.resolve(null) // 单例:旧的先取消
    useStore.getState().open({ note, assets, block: opts?.block, resolve })
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
  const { t } = useI18n()
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
        <div className="dialog-title">{req.block ? t('delassets.blockTitle') : t('delassets.noteTitle', { name: req.note })}</div>
        <div className="dialog-msg">
          {req.block
            ? t('delassets.blockMsg', { n: req.assets.length })
            : t('delassets.noteMsg', { n: req.assets.length })}
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, opacity: 0.8 }}>
            {shown.map((a) => <li key={a}>{a}</li>)}
            {req.assets.length > shown.length && <li>{t('delassets.more', { n: req.assets.length - shown.length })}</li>}
          </ul>
        </div>
        {!req.block && (
          <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('delassets.remember')}
          </label>
        )}
        <div className="dialog-actions">
          {req.block
            ? <button className="dialog-btn" autoFocus onClick={() => settle('only')}>{t('delassets.keepFiles')}</button>
            : (
              <>
                <button className="dialog-btn" onClick={() => settle(null)}>{t('delassets.cancel')}</button>
                <button className="dialog-btn" onClick={() => settle('only')}>{t('delassets.noteOnly')}</button>
              </>
            )}
          <button className="dialog-btn" data-danger autoFocus={!req.block} onClick={() => settle('with')}>{t('delassets.deleteAll')}</button>
        </div>
      </div>
    </div>
  )
}
