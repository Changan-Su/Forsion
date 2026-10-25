/**
 * 附件磁贴(10-17,借鉴 Claude 第二轮 B2):输入卡里待发的附件、已发消息气泡上方的附件共用。
 * 图片 = 方块缩略图(从左上角裁);其它 = 一条「类型色块 + 文件名 + 类型 · 大小」。
 * 移除钮压在右上角、平时藏着(悬停 / 键盘聚焦才出;触屏常显),点了先缩小淡出 130ms 再真删。
 * 方案页:docs/ToBeImproved/借鉴Claude设计系统方案_2026-10-17/round2.html
 */
import { useState } from 'react'
import { CircleAlert, RotateCw, X } from 'lucide-react'
import { reducedMotion } from '@lcl/engine'
import { UploadBar, UploadRing } from '@lcl/components'
import { extOf, fmtSize } from '../services/fileKinds'
import { retryUpload, uploadBusy, uploadBytesLabel, uploadFraction, useUploads } from '../services/uploads'
import { registerMessages, useI18n } from '../i18n'
import { viewableProps } from './ImageViewer'

registerMessages({
  'atttile.queued': { zh: '等待中', en: 'Waiting' },
  'atttile.reading': { zh: '读取中', en: 'Reading' },
  'atttile.uploading': { zh: '上传中', en: 'Uploading' },
  'atttile.failed': { zh: '上传失败 · 点按重试', en: 'Upload failed · Click to retry' },
  'atttile.retry': { zh: '重试上传', en: 'Retry upload' },
})

export interface TileFile { name: string; mimeType: string; data?: string; size?: number }

/** 点了移除、还在淡出的那 130ms:发送时当它已经删了(用户删掉的东西别发出去)。按对象认,草稿里的附件对象引用是稳的。 */
const leavingFiles = new WeakSet<TileFile>()
export const isLeaving = (f: TileFile): boolean => leavingFiles.has(f)
/** 磁贴的 key 按附件对象给:按「名字 + 下标」的话,同名两张图删掉第一张,第二张会接手它的淡出状态(Codex P1) */
const tileIds = new WeakMap<TileFile, number>()
let tileSeq = 0
export const tileKey = (f: TileFile): number => {
  let id = tileIds.get(f)
  if (id === undefined) tileIds.set(f, (id = ++tileSeq))
  return id
}

const KIND: Record<string, string> = {
  xlsx: 'sheet', xls: 'sheet', csv: 'sheet', tsv: 'sheet', numbers: 'sheet',
  pdf: 'pdf',
  doc: 'doc', docx: 'doc', pages: 'doc', rtf: 'doc',
}

/** 「周报发送记录…队汇总版.xlsx」:省略号落在中间,扩展名和它前面几个字留着,同名不同版本也分得清。 */
export function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const chars = [...base] // 按码点切:半个表情不落在两边
  if (chars.length <= 8) return [name, '']
  return [chars.slice(0, -4).join(''), chars.slice(-4).join('') + name.slice(base.length)]
}

export function AttachmentTile({ file, onRemove, removeTitle, note, view, uploadId, preview, sending }: {
  file: TileFile
  /** 上传台账里的那条(输入卡里刚加进来的附件):读 / 传期间画进度,失败画重试。 */
  uploadId?: string
  /** 还没读完时的本地预览(objectURL);读完就用 data。 */
  preview?: string
  /** 新对话按了发送、文件随建会话一起上传:画成上传中(报不了字节,条在走)。 */
  sending?: boolean
  /** 图片方块点开看图(A2);输入卡里待发的不开 */
  view?: boolean
  /** 不传 = 只读(已发消息里) */
  onRemove?: () => void
  removeTitle?: string
  /** 第二行末尾的补充说明(如「到工作区」);带说明的图片也排成文件条(缩略图当色块),方块里写不下这句话 */
  note?: string
}) {
  const { t } = useI18n()
  const [leaving, setLeaving] = useState(false)
  const [broken, setBroken] = useState(false)
  const up = useUploads((all) => (uploadId ? all[uploadId] : undefined))
  const busy = uploadBusy(up) || !!sending
  const failed = up?.phase === 'failed'
  const src = file.data ? `data:${file.mimeType};base64,${file.data}` : preview
  const isImage = file.mimeType?.startsWith('image/') && !!src && !broken
  const square = isImage && !note
  const ext = extOf(file.name)
  const label = (ext || (file.mimeType?.startsWith('image/') ? 'img' : 'file')).slice(0, 4).toUpperCase()
  const [head, tail] = splitName(file.name)
  const sub = failed ? t('atttile.failed')
    : up && uploadBusy(up) ? (up.phase === 'queued' ? t('atttile.queued') : `${t(up.phase === 'reading' ? 'atttile.reading' : 'atttile.uploading')} · ${uploadBytesLabel(up)}`)
    : sending ? t('atttile.uploading')
    : [label, file.size ? fmtSize(file.size) : '', note].filter(Boolean).join(' · ')
  const fraction = up && uploadBusy(up) ? uploadFraction(up) : null
  const retry = (): void => { if (uploadId && failed) retryUpload(uploadId) }
  const remove = (): void => {
    if (!onRemove || leaving) return
    if (reducedMotion()) { onRemove(); return }
    leavingFiles.add(file)
    setLeaving(true)
    window.setTimeout(onRemove, 130)
  }
  return (
    <span
      className={`att-tile${square ? ' att-tile--img' : ' att-tile--file'}${leaving ? ' is-leaving' : ''}${failed ? ' is-failed' : ''}`}
      title={file.name}
      onClick={!square && failed ? retry : undefined}
    >
      {square ? (
        <img src={src} alt={file.name} draggable={false} onError={() => setBroken(true)} {...(view && !busy ? viewableProps({ name: file.name }) : {})} />
      ) : (
        <>
          {failed
            ? <span className="att-tile-badge" aria-hidden><CircleAlert size={16} /></span>
            : isImage
            ? <img className="att-tile-badge" src={src} alt="" draggable={false} onError={() => setBroken(true)} />
            : <span className="att-tile-badge" data-kind={KIND[ext] || 'other'} aria-hidden>{label}</span>}
          <span className="att-tile-meta">
            <span className="att-tile-name"><span className="att-tile-head">{head}</span>{tail && <span className="att-tile-tail">{tail}</span>}</span>
            <span className="att-tile-sub">{sub}</span>
          </span>
          {busy && <UploadBar value={fraction} />}
        </>
      )}
      {square && (busy || failed) && <span className="att-tile-veil lcl-up-late" aria-hidden />}
      {square && busy && <UploadRing value={fraction} />}
      {square && failed && (
        <button type="button" className="att-tile-retry" title={t('atttile.retry')} aria-label={`${t('atttile.retry')} ${file.name}`} onClick={retry}>
          <RotateCw size={13} strokeWidth={2.25} />
        </button>
      )}
      {onRemove && (
        <button type="button" className="att-tile-x" title={removeTitle} aria-label={removeTitle ? `${removeTitle} ${file.name}` : file.name} onClick={(e) => { e.stopPropagation(); remove() }}>
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </span>
  )
}
