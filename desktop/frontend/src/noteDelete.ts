/**
 * 删除库内笔记 / 文件 / 文件夹的那几步(原在 amadeusViews.tsx,LCL 对象层第一期搬出来,好让对象动作 note.delete 与
 * 树上的 swipe / 文件夹菜单共用同一份)。逻辑原样搬,只多了 `confirmed`:执行层已经问过一次就别再问。
 */
import { usePageStore, trashVaultFiles } from '@amadeus/store/pageStore'
import { amadeus } from '@amadeus/api'
import { askDeleteAssets, deleteAssetsPref } from '@amadeus/components/askDeleteAssets'
import { fdDirOf } from '@amadeus/lib/fd'
import { useRecentViews } from './recentViews'
import { registerMessages, translate } from './i18n'

registerMessages({
  'amxv.confirm.deleteNote': { zh: '删除笔记「{name}」？此操作不可撤销。', en: 'Delete the note “{name}”? This cannot be undone.' },
  'amxv.confirm.deleteNoteWithChildren': { zh: '删除笔记「{name}」？其中包含 {n} 个子文件，将一并删除。此操作不可撤销。', en: 'Delete the note “{name}”? It contains {n} sub-file(s) that will be deleted with it. This cannot be undone.' },
  'amxv.confirm.deleteFile': { zh: '删除文件「{name}」？此操作不可撤销。', en: 'Delete the file “{name}”? This cannot be undone.' },
  'amxv.confirm.deleteFolder': { zh: '删除文件夹「{name}」及其全部内容？不可撤销。', en: 'Delete the folder “{name}” and everything in it? This cannot be undone.' },
  'amxv.confirm.deleteSelected': { zh: '删除选中的 {n} 项？', en: 'Delete the {n} selected items?' },
})

const ps = () => usePageStore.getState()
const baseName = (p: string): string => p.split(/[\\/]/).pop()!.replace(/\.md$/, '')

/** 有回收站(桌面端)→ 删除免确认(可恢复);无 → 弹原確认。 */
export const canTrash = (): boolean => !!amadeus.trashEntry

/** 删除确认文案:笔记带 .fd 子文件时点明「N 个子文件一并删除」(级联在 pageStore.deletePage)。 */
export function deleteNoteMsg(p: string): string {
  const fd = fdDirOf(p)
  const n = [...ps().pages, ...ps().files].filter((x) => x.startsWith(`${fd}/`)).length
  return n > 0
    ? translate('amxv.confirm.deleteNoteWithChildren', { name: baseName(p), n })
    : translate('amxv.confirm.deleteNote', { name: baseName(p) })
}
export const deleteFileMsg = (p: string): string => translate('amxv.confirm.deleteFile', { name: p.split(/[\\/]/).pop() })

/**
 * 删除笔记的完整流程:确认 → 问「只被它引用的附件」怎么办 → 删笔记(+ 按选择清附件)。
 * 独占判据在主进程 vaultIndex.exclusiveAssets(别的笔记也引用的一律保留);没有独占附件就
 * 一句话不问,和从前一样静默移入回收站。选择可勾「下次不再问」,设置→笔记能改回。
 * 返回删没删(确认或附件对话框里取消 = false)。`confirmed`:调用方已经确认过(对象动作的执行层)。
 */
export async function deleteNoteFlow(p: string, store: typeof ps = ps, opts: { confirmed?: boolean } = {}): Promise<boolean> {
  if (!opts.confirmed && !confirmedDelete('note', p)) return false
  const assets = (await amadeus.exclusiveAssets?.(p).catch(() => [] as string[])) ?? []
  let withAssets = assets.length > 0 ? deleteAssetsPref() : false
  if (assets.length > 0 && withAssets === null) {
    const choice = await askDeleteAssets(baseName(p), assets)
    if (choice === null) return false
    withAssets = choice === 'with'
  }
  useRecentViews.getState().remove(`note:${p}`)
  await store().deletePage(p)
  if (!withAssets) return true
  await trashVaultFiles(assets)
  await store().refreshStructure()
  return true
}

/** 删除笔记/文件/文件夹的统一入口:回收站可用即静默移入(toast 在 pageStore),否则确认后硬删。 */
export function confirmedDelete(kind: 'note' | 'file' | 'folder', path: string): boolean {
  if (canTrash()) return true
  if (kind === 'note') return window.confirm(deleteNoteMsg(path))
  if (kind === 'file') return window.confirm(deleteFileMsg(path))
  return window.confirm(translate('amxv.confirm.deleteFolder', { name: path.split(/[\\/]/).pop() }))
}
