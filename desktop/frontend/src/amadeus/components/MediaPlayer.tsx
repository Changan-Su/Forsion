import { useEffect, useRef, useState, type ReactElement } from 'react'
import { buildMediaLink, mediaLabel, type MediaLoc } from '@amadeus-shared/pdfLink'
import { usePageStore } from '../store/pageStore'
import { resolveFileName, isAmbiguousFileRef } from '../lib/vaultFiles'
import { getAttachmentPrefs } from '../lib/attachments'
import { amadeus } from '../api'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'mediaplayer.grabTitle': { zh: '把当前画面存成图片,并在下方插入回源时间戳', en: 'Save the current frame as an image and insert a timestamp link back to this moment' },
  'mediaplayer.grabUnavailable': { zh: '本端拿不到帧(视频以无跨源模式加载)', en: 'Frames are unavailable here — the video loaded without cross-origin access' },
  'mediaplayer.grabbing': { zh: '截帧中…', en: 'Capturing…' },
  'mediaplayer.grab': { zh: '✂ 截这一帧', en: '✂ Capture this frame' },
  'mediaplayer.errCrossOrigin': { zh: '跨源视频无法截帧', en: 'Cannot capture a frame from a cross-origin video' },
  'mediaplayer.errFailed': { zh: '截帧失败', en: 'Frame capture failed' },
})

/** 本地音视频播放器 —— 时间锚点的**唯一**消费点(v3/Inbox 两份也复用本组件)。
 *
 *  三条会静默失效的坑,逐条对应下面的实现:
 *  1. `loadedmetadata` **只触发一次**。只挂它 = 用户把源码里的 `#t=95` 改成 `#t=120` 时画面纹丝不动
 *     (src 没变 → 不重新加载元数据)。所以用 effect 依赖 loc,且 readyState 够了就直接 seek。
 *  2. **同名歧义时不认领**:resolveVaultPath 撞名取字典序首项,拿它认领 goto = 静默 seek 到另一份
 *     同名视频,而时间码看着还挺合理。纪律与聊天引用条一致 —— 宁可不认领,让派发方走回落。
 *  3. **连点同一条引用要能再跳**:goto 处理器无条件 seek,**不做「和上次一样就跳过」的去重** ——
 *     去重会让「读了一半往回跳同一条引用」失灵。 */
export function MediaPlayer({ kind, url, name, pagePath, loc, insertAfter }: {
  kind: 'video' | 'audio'
  url: string
  name: string
  pagePath: string
  loc: MediaLoc | null
  insertAfter?: (md: string) => void
}): ReactElement {
  const { t } = useI18n()
  const files = usePageStore((s) => s.files)
  const ref = useRef<HTMLMediaElement | null>(null)
  // ⚠️ 存的是**键**不是文案:存翻译好的字符串会在切换语言时冻在旧语言里。
  const [shot, setShot] = useState<string | null>(null)
  // crossOrigin 是**截帧**要的(canvas 不被污染);协议端已回 ACAO:*。万一某端没这个头,
  // 视频会直接 load 失败 —— onError 里降级重挂一次无 crossOrigin 的,宁可丢截帧也不能丢播放。
  const [anon, setAnon] = useState(kind === 'video')

  /** 就位即 seek;元数据还没到就押后一次。返回撤销函数(押后的监听必须能撤 —— 否则 loc 连变
   *  几次会堆叠出好几个 once 监听,元数据一到按注册序依次赋值,中间那些是**过期时刻**)。 */
  const seek = (at: number): (() => void) => {
    const el = ref.current
    if (!el) return () => {}
    const go = (): void => { try { el.currentTime = at } catch { /* 源未就绪,忽略 */ } }
    if (el.readyState >= 1 /* HAVE_METADATA */) { go(); return () => {} }
    el.addEventListener('loadedmetadata', go, { once: true })
    return () => el.removeEventListener('loadedmetadata', go)
  }

  useEffect(() => {
    if (!loc) return
    return seek(loc.at)
  }, [loc?.at, loc?.to, url])

  // ⚠️ goto 带来的区间终点必须有**自己的一份状态**:props 的 `loc` 是冷挂载那一次的锚,已挂载的
  //    播放器再收到一条带区间的引用时 props 不会变(Agent Desk 的 leaf 只按 key memo,params 到不了
  //    已挂载的视图)—— 只 seek 不更新 to = 到点不暂停,静默(Codex 二审)。
  //    收到不带 to 的 goto 时要清掉,否则上一条区间引用的暂停点会赖着不走。
  const [gotoTo, setGotoTo] = useState<number | undefined>(undefined)
  useEffect(() => { setGotoTo(undefined) }, [loc?.at, loc?.to, url]) // props 的锚变了 → 以 props 为准

  // 区间锚 `#t=95,120`:到点暂停。原生 `loop` 不认片段(W3C bug 12426 WONTFIX),只能自己看。
  const stopAt = gotoTo ?? loc?.to
  useEffect(() => {
    const el = ref.current
    if (!el || !stopAt) return
    const onTime = (): void => { if (el.currentTime >= stopAt) el.pause() }
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [stopAt])

  // `amadeus:media-goto` 认领:本笔记内有这个播放器 → 原地 seek,置 handled 让派发方别再回落。
  const vaultPath = resolveFileName(name, files, pagePath)
  const ambiguous = isAmbiguousFileRef(name, files)
  useEffect(() => {
    if (!vaultPath || ambiguous) return
    const onGoto = (e: Event): void => {
      const d = (e as CustomEvent).detail as { path?: string; at?: number; to?: number; clear?: boolean; handled?: boolean } | undefined
      if (!d) return
      if ((d.path ?? '').replace(/\\/g, '/').toLowerCase() !== vaultPath.replace(/\\/g, '/').toLowerCase()) return
      // 普通打开(不带锚)同一份媒体:只清掉上一条区间锚的暂停点,**不动播放位置** ——
      // 用户没要求跳,别把他正在看的地方冲掉(WsFileView 的 `clear` 同款语义,Codex 四审)。
      if (d.clear) { setGotoTo(undefined); d.handled = true; return }
      if (typeof d.at !== 'number') return
      seek(d.at)
      setGotoTo(typeof d.to === 'number' && d.to > d.at ? d.to : undefined)
      void (ref.current as HTMLVideoElement | null)?.play?.().catch(() => {})
      d.handled = true
    }
    window.addEventListener('amadeus:media-goto', onGoto)
    return () => window.removeEventListener('amadeus:media-goto', onGoto)
  }, [vaultPath, ambiguous])

  /** 截这一帧 → 存进附件目录,并在本块后插入「图片 + 回源锚点」两段。
   *  照 Media Extended:一帧图片单独存在是死的,配上回源锚点才是活的。 */
  const grab = async (): Promise<void> => {
    const el = ref.current as HTMLVideoElement | null
    if (!el || !insertAfter) return
    setShot('working')
    try {
      const c = document.createElement('canvas')
      c.width = el.videoWidth
      c.height = el.videoHeight
      const g = c.getContext('2d')
      if (!g || !c.width) throw new Error('no frame')
      g.drawImage(el, 0, 0)
      // toBlob 在画布被污染时抛 SecurityError —— 这是「跨源拿不到帧」的确切信号,原样报给用户。
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
      if (!blob) throw new Error('encode failed')
      const at = Math.round(el.currentTime)
      const stamp = mediaLabel(at).replace(/:/g, '-')
      const base = name.replace(/\.[^.]+$/, '')
      const { opts } = await getAttachmentPrefs()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const saved = await amadeus.saveAttachment(pagePath, `${base}--${stamp}.png`, bytes, opts)
      insertAfter(`![[${saved.base}]]\n\n${buildMediaLink(name, { at })}`)
      setShot(null)
    } catch (err) {
      setShot(err instanceof DOMException && err.name === 'SecurityError' ? 'mediaplayer.errCrossOrigin' : 'mediaplayer.errFailed')
      setTimeout(() => setShot(null), 3000)
    }
  }

  const common = {
    ref: ref as never,
    src: url,
    controls: true,
    preload: 'metadata' as const,
    ...(anon ? { crossOrigin: 'anonymous' as const } : {}),
    onError: () => { if (anon) setAnon(false) }, // 见上:丢截帧也不能丢播放
  }
  return (
    <>
      {kind === 'video' ? <video className="embed-video" {...common} /> : <audio className="embed-audio" {...common} />}
      {kind === 'video' && insertAfter && (
        <div className="embed-media-foot">
          <button className="embed-media-btn" onClick={() => void grab()} disabled={shot === 'working' || !anon}
            title={anon ? t('mediaplayer.grabTitle') : t('mediaplayer.grabUnavailable')}>
            {shot === 'working' ? t('mediaplayer.grabbing') : t('mediaplayer.grab')}
          </button>
          {shot && shot !== 'working' && <span className="embed-media-warn">{t(shot)}</span>}
        </div>
      )}
    </>
  )
}
