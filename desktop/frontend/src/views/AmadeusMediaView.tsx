/** 独立音视频视图(方案「媒体锚点与网页嵌入」§2 档2 的 P1):聊天里的时刻引用条 `[[a.mp4#t=95]]`、
 *  以及笔记里点了但**本页没有播放器**的媒体锚,都落在这里 —— 在应用内打开并停在那一秒。
 *  在此之前这两条路都回落系统播放器,时间戳静默丢失。
 *
 *  载体刻意用 `amadeus-asset://`(主进程 fd 区间流式读,支持 Range)而**不是** WsFileView ——
 *  后者把整份文件读成 base64 再 Blob,还带 tooLarge 上限,GB 级课程视频当场变成「文件过大」。
 *  代价:本视图只服务**库内**媒体(该协议只有 `v/<vaultRel>` 一个面)。库外绝对路径仍走 WsFileView。
 *
 *  播放器本体复用 `MediaPlayer` —— 时间锚点的唯一消费点(区间锚暂停、押后 seek、
 *  `amadeus:media-goto` 认领三件事都在里面,别在这儿另写一份)。
 *  多实例:`params.path` 认领文件(**字段名必须是 path**:appStore.deskShowFile 的 fileKeyOf
 *  只认 `pdfPath ?? path`,换个名字 Agent Desk 里每次点都会重挂一个新播放器)。 */
import { useEffect } from 'react'
import type { ViewProps } from '@lcl/engine'
import { VIDEO_EXT_RE, type MediaLoc } from '@amadeus-shared/pdfLink'
import { toAssetUrl } from '@amadeus-shared/assets'
import { useTheme } from '../stores/themeStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { MediaPlayer } from '@amadeus/components/MediaPlayer'

const baseOf = (p: string): string => p.split(/[\\/]/).pop() || p

export function AmadeusMediaView({ leaf }: ViewProps) {
  const path = typeof leaf.params.path === 'string' ? leaf.params.path : ''
  const at = typeof leaf.params.at === 'number' ? leaf.params.at : null
  const to = typeof leaf.params.to === 'number' ? leaf.params.to : undefined
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  // 同 PDF/图片:asset:// 按「当前打开的 vault」解析,启动恢复 tab 时 vault 可能还没 open →
  // 先不挂播放器(否则加载失败,且 vault 就绪后 src 不变不会自愈)。vaultRoot 落地即重渲。
  const vaultReady = usePageStore((s) => !!s.vaultRoot)
  useEffect(() => { if (path) leaf.setTitle(baseOf(path)) }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!path) return <div className="amx-db amx-db-state">未指定媒体文件。</div>
  // ⚠️ loc 必须是**新对象也无所谓、但 at 变了要能重跳**:MediaPlayer 的 seek effect 依赖 loc?.at,
  //    冷挂载走这里,已挂载后的第二条引语走 amadeus:media-goto(params 到不了已挂载的视图)。
  const loc: MediaLoc | null = at != null ? { at, ...(to ? { to } : {}) } : null
  return (
    <div className="am-app tangu-lovable amx-pane amx-mediaview" data-mode={mode} data-flat={flat ? '1' : '0'}>
      {vaultReady ? (
        <div className="amx-mediaview-box">
          {/* 音频档给一行文件名:一条 40px 的控制条独自浮在整格中央,看着像界面没加载出来
              (真截图自查发现的;视频有画面,不需要)。视图标题只在标签页/Desk 卡头上,格子里是空的。 */}
          {!VIDEO_EXT_RE.test(path) && <div className="amx-mediaview-name">{baseOf(path)}</div>}
          <MediaPlayer
            kind={VIDEO_EXT_RE.test(path) ? 'video' : 'audio'}
            url={toAssetUrl(path)}
            name={path}
            pagePath=""
            loc={loc}
          />
        </div>
      ) : (
        <div style={{ padding: 24, color: 'var(--text-muted, #888)' }}>等待 Vault 打开…</div>
      )}
    </div>
  )
}
