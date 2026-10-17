/**
 * 附件磁贴(10-17,借鉴 Claude 第二轮 B2):输入卡里待发的附件、已发消息气泡上方的附件共用。
 * 图片 = 方块缩略图(从左上角裁);其它 = 一条「类型色块 + 文件名 + 类型 · 大小」。
 * 移除钮压在右上角、平时藏着(悬停 / 键盘聚焦才出;触屏常显),点了先缩小淡出 130ms 再真删。
 * 方案页:docs/ToBeImproved/借鉴Claude设计系统方案_2026-10-17/round2.html
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { reducedMotion } from '@lcl/engine'
import { extOf, fmtSize } from '../services/fileKinds'

export interface TileFile { name: string; mimeType: string; data?: string; size?: number }

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

export function AttachmentTile({ file, onRemove, removeTitle, note }: {
  file: TileFile
  /** 不传 = 只读(已发消息里) */
  onRemove?: () => void
  removeTitle?: string
  /** 第二行末尾的补充说明(如「到工作区」);带说明的图片也排成文件条(缩略图当色块),方块里写不下这句话 */
  note?: string
}) {
  const [leaving, setLeaving] = useState(false)
  const [broken, setBroken] = useState(false)
  const isImage = file.mimeType?.startsWith('image/') && !!file.data && !broken
  const square = isImage && !note
  const ext = extOf(file.name)
  const label = (ext || (file.mimeType?.startsWith('image/') ? 'img' : 'file')).slice(0, 4).toUpperCase()
  const [head, tail] = splitName(file.name)
  const sub = [label, file.size ? fmtSize(file.size) : '', note].filter(Boolean).join(' · ')
  const remove = (): void => {
    if (!onRemove || leaving) return
    if (reducedMotion()) { onRemove(); return }
    setLeaving(true)
    window.setTimeout(onRemove, 130)
  }
  return (
    <span className={`att-tile${square ? ' att-tile--img' : ' att-tile--file'}${leaving ? ' is-leaving' : ''}`} title={file.name}>
      {square ? (
        <img src={`data:${file.mimeType};base64,${file.data}`} alt={file.name} draggable={false} onError={() => setBroken(true)} />
      ) : (
        <>
          {isImage
            ? <img className="att-tile-badge" src={`data:${file.mimeType};base64,${file.data}`} alt="" draggable={false} onError={() => setBroken(true)} />
            : <span className="att-tile-badge" data-kind={KIND[ext] || 'other'} aria-hidden>{label}</span>}
          <span className="att-tile-meta">
            <span className="att-tile-name"><span className="att-tile-head">{head}</span>{tail && <span className="att-tile-tail">{tail}</span>}</span>
            <span className="att-tile-sub">{sub}</span>
          </span>
        </>
      )}
      {onRemove && (
        <button type="button" className="att-tile-x" title={removeTitle} aria-label={removeTitle ? `${removeTitle} ${file.name}` : file.name} onClick={remove}>
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </span>
  )
}
