import { useMemo, useRef, useState } from 'react'
import { FolderOpen, Images, Plus, Search } from 'lucide-react'
import { useI18n } from '../../i18n'
import { formatListTime } from '../../format/time'
import { useImageStudio } from '../../stores/imageStudioStore'
import { ImageThumbnail } from './LayerPreview'
import { importProject } from './files'
import { boardItems, coverImages, imageSize, type ImageBoard } from './model'
import './messages'
import './imageStudio.css'
import '../coding/launchpad.css' // 页头、搜索、空态与 Coding 的启动台同一份(csl-*);只有封面网格是这里自己的

const COVER_RATIO = 4 / 3
const COVER_GAP = 0.05 // 两张图之间留框宽的 5%(与 .ims-cover-in 的 gap 一致)

/** 封面:画布上最靠左的两张可见图,等高并排,整体等比缩进 4:3 的框(百分比宽 + aspect-ratio,不量 DOM)。
 *  ponytail: 直接画原图;项目多、图又大时首屏解码会慢 —— 到那时在保存时另存一张缩略图。 */
function BoardCover({ board }: { board: ImageBoard }) {
  const images = coverImages(board, 2)
  if (!images.length) return <span className="ims-cover is-empty"><span className="ims-cover-in"><Images size={22} strokeWidth={1.4} /></span></span>
  const ratios = images.map(image => { const size = imageSize(image); return size.w / size.h })
  const height = Math.min(1, (1 - COVER_GAP * (images.length - 1)) * COVER_RATIO / ratios.reduce((sum, ratio) => sum + ratio, 0))
  return <span className="ims-cover"><span className="ims-cover-in">{images.map((image, index) =>
    <span key={image.id} className="ims-cover-img" style={{ width: `${ratios[index] * height / COVER_RATIO * 100}%`, aspectRatio: String(ratios[index]) }}><ImageThumbnail image={image} /></span>)}</span></span>
}

/** 没打开项目时的主区:项目列表(封面网格)。新建直接进一张空画布。 */
export function ImageLaunchpad() {
  const { t, locale } = useI18n()
  const boards = useImageStudio(s => s.boards)
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const all = useMemo(() => Object.values(boards).sort((a, b) => b.updatedAt - a.updatedAt), [boards])
  const needle = query.trim().toLocaleLowerCase()
  const shown = needle ? all.filter(board => board.name.toLocaleLowerCase().includes(needle)) : all
  const restore = async (file: File) => {
    setBusy(true); setError('')
    try {
      const imported = await importProject(file)
      const id = useImageStudio.getState().create(imported.name)
      useImageStudio.getState().update(id, board => ({ ...imported, id: board.id }))
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <div className="csl-launchpad ims-launch"><div className="csl-inner"><main className="csl-catalog">
    <header className="csl-catalog-header">
      <div><h1>{t('imageStudio.projects')}</h1><p>{t('imageStudio.launch.subtitle')}</p></div>
      <div className="csl-catalog-actions">
        <button type="button" className="csl-import" disabled={busy} onClick={() => picker.current?.click()}><FolderOpen size={15} />{t('imageStudio.restore')}</button>
        <button type="button" className="csl-new" onClick={() => useImageStudio.getState().create(t('imageStudio.untitled'))}><Plus size={16} />{t('imageStudio.new')}</button>
      </div>
    </header>
    {error && <div className="ims-error" role="alert">{t('imageStudio.error', { error })}</div>}
    {all.length > 0 && <div className="csl-catalog-toolbar"><label className="csl-search"><Search size={15} /><input type="search" aria-label={t('imageStudio.launch.search')} placeholder={t('imageStudio.launch.search')} value={query} onChange={e => setQuery(e.target.value)} /></label></div>}
    {shown.length ? <div className="ims-launch-grid" role="group" aria-label={t('imageStudio.projects')}>{shown.map(board =>
      <button key={board.id} type="button" className="ims-launch-card" data-project-id={board.id} onClick={() => useImageStudio.getState().open(board.id)}>
        <BoardCover board={board} />
        <span className="ims-launch-meta"><strong>{board.name}</strong><small>{t('imageStudio.itemCount', { count: boardItems(board).length })} · {formatListTime(board.updatedAt, { locale })}</small></span>
      </button>)}</div>
      : <div className="csl-empty"><strong>{t(all.length ? 'imageStudio.launch.noMatch' : 'imageStudio.launch.empty')}</strong>{!all.length && <p>{t('imageStudio.launch.emptyHint')}</p>}</div>}
    <input ref={picker} type="file" accept=".json" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void restore(file) }} />
  </main></div></div>
}
