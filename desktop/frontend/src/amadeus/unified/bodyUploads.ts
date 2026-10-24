/** 正文里的上传占位(方案 docs/ToBeImproved/附件上传进度方案_2026-10-24/r2.html §4 A「原地占位」)。
 *
 * 粘贴 / 拖入的文件、粘贴的图片、斜杠「图片」:一批文件钉**一个**锚(pendingInsert 的 widget —— 只在显示层,不进文档、
 * 不进撤销栈、不会被自动保存写进 .md;此前是一行真正文「上传中 xxx」,切走页面就留在文件里)。
 *  - 图片先用本地预览出来,盖纱 + 环;其余是一张文件卡(与嵌入层 `.embed-file` 同一张),写「上传中 · 已传 / 总共」+ 底边细条;
 *  - 失败的那张变红,给「重试 / 移除」;在传的给「取消」;
 *  - 全部传完(失败的被移除)→ 按原顺序一次插到锚处(insertAsync:锚没了 / 源码模式各有提示);一个都没成 → 撤锚。
 * 进度记在上传台账(services/uploads),画法是 `@lcl/components` 的环 / 细条。
 * ponytail: 取消只丢结果,不中止写盘(saveAttachment 不收 signal)—— 文件照样进了附件文件夹,只是不插进正文。
 */
import { createUploadBar, createUploadRing } from '@lcl/components'
import { cancelUpload, forgetUpload, retryUpload, startUpload, uploadBusy, uploadBytesLabel, uploadFraction, useUploads, type UploadEntry } from '../../services/uploads'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'bodyup.uploading': { zh: '上传中', en: 'Uploading' },
  'bodyup.waiting': { zh: '等待中', en: 'Waiting' },
  'bodyup.done': { zh: '已上传', en: 'Uploaded' },
  'bodyup.failed': { zh: '上传失败', en: 'Upload failed' },
  'bodyup.retry': { zh: '重试', en: 'Retry' },
  'bodyup.remove': { zh: '移除', en: 'Remove' },
  'bodyup.cancel': { zh: '取消', en: 'Cancel' },
})

/** 占位 widget 的 DOM;交给 beginPending 当锚的外形。 */
export interface UploadWidget { dom: HTMLElement }

interface Row {
  file: File
  id: string
  md: string | null
  removed: boolean
  preview: string | null
  el: HTMLElement
  status: HTMLElement
  actions: HTMLElement
  set: (v: number | null) => void
  phase?: string
}

const btn = (label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'amx-upph-act'
  b.textContent = label
  b.addEventListener('mousedown', (e) => e.preventDefault()) // 不把焦点从正文抢走
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
  return b
}

/**
 * 开一批正文上传。pin:用给的 widget 在光标处钉锚(编辑器不在 = null,照样传,结果交 finish 去报「插入点没了」);
 * save:存一个文件,回它的引用 markdown(落盘形);finish:全部落定后插入(md = null → 只撤锚)。
 */
export function startBodyUploads<A>(opts: {
  files: File[]
  pin: (w: UploadWidget) => A
  save: (f: File, onProgress: (sent: number, total: number) => void) => Promise<string>
  finish: (md: string | null, anchor: A) => void
}): void {
  const dom = document.createElement('span')
  dom.className = 'amx-upph'
  dom.contentEditable = 'false'
  dom.setAttribute('role', 'status')
  const rows: Row[] = []
  let ended = false

  const paint = (r: Row, e: UploadEntry | undefined): void => {
    if (!e) return
    const failed = e.phase === 'failed'
    r.el.classList.toggle('is-failed', failed)
    r.set(uploadBusy(e) ? uploadFraction(e) : e.phase === 'done' ? 1 : 0)
    r.status.textContent = failed ? translate('bodyup.failed')
      : e.phase === 'done' ? translate('bodyup.done') // 同一批里还有失败的在等:传好的先写「已上传」
      : e.phase === 'queued' ? translate('bodyup.waiting')
        : e.sent == null ? translate('bodyup.uploading') : `${translate('bodyup.uploading')} · ${uploadBytesLabel(e)}`
    if (r.phase === e.phase) return // 按钮只在换阶段时重建:进度事件很密,重建会吃掉按到一半的点击
    r.phase = e.phase
    r.actions.replaceChildren(...(failed
      ? [btn(translate('bodyup.retry'), () => retryUpload(r.id)), btn(translate('bodyup.remove'), () => drop(r))]
      : uploadBusy(e) ? [btn(translate('bodyup.cancel'), () => drop(r))] : []))
  }
  const repaint = (): void => { const all = useUploads.getState(); for (const r of rows) if (!r.removed) paint(r, all[r.id]) }
  const unsub = useUploads.subscribe(repaint)

  const settle = (): void => {
    if (ended || rows.some((r) => !r.removed && r.md == null)) return
    ended = true
    unsub()
    for (const r of rows) { forgetUpload(r.id); if (r.preview) URL.revokeObjectURL(r.preview) }
    const mds = rows.filter((r) => !r.removed && r.md != null).map((r) => r.md!)
    opts.finish(mds.length ? mds.join('\n\n') : null, anchor)
  }
  /** 取消在传的 / 移除失败的:那一张从占位里拿掉,不插进正文。 */
  const drop = (r: Row): void => {
    r.removed = true
    cancelUpload(r.id)
    r.el.remove()
    settle()
  }

  for (const f of opts.files) {
    const image = f.type.startsWith('image/')
    const preview = image ? URL.createObjectURL(f) : null
    const el = document.createElement('span')
    const status = document.createElement('span')
    status.className = 'amx-upph-status'
    const actions = document.createElement('span')
    actions.className = 'amx-upph-acts'
    let set: (v: number | null) => void
    if (image) {
      el.className = 'amx-upph-img'
      const img = document.createElement('img')
      img.src = preview!
      img.alt = ''
      const veil = document.createElement('span')
      veil.className = 'amx-upph-veil'
      const ring = createUploadRing(28)
      set = ring.set
      const foot = document.createElement('span')
      foot.className = 'amx-upph-foot'
      foot.append(status, actions)
      el.append(img, veil, ring.el, foot)
    } else {
      el.className = 'embed-file amx-upph-file'
      const ic = document.createElement('span')
      ic.className = 'embed-file-ic'
      ic.setAttribute('aria-hidden', 'true')
      ic.textContent = '📄'
      const name = document.createElement('span')
      name.className = 'embed-file-name'
      name.textContent = f.name
      const bar = createUploadBar()
      set = bar.set
      el.append(ic, name, status, actions, bar.el)
    }
    dom.append(el)
    const row: Row = { file: f, id: '', md: null, removed: false, preview, el, status, actions, set }
    rows.push(row)
    row.id = startUpload(f.name, f.size, async ({ stage, progress }) => {
      stage('uploading') // 报不了进度的宿主(本机写盘)一直转圈;云端 XHR 报了才有数字
      const md = await opts.save(f, (sent, total) => progress(total > 0 ? (sent / total) * f.size : null))
      if (row.removed) return
      row.md = md
      settle()
    })
  }
  const anchor = opts.pin({ dom })
  repaint()
}
