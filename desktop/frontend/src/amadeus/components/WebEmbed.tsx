import { useState, type ReactElement } from 'react'
import { webviewUrlAllowed } from '@amadeus-shared/dashboard'
import { Webview } from '../../builtins/browserView'
import { BROWSER_PARTITION } from '../../../../shared/browser'
import { BookmarkCard, VideoIframe, youtubeId, bilibiliRef } from './BookmarkCard'

/** 网页嵌入 `![[https://…]]` —— **默认冻结**(封面卡),点「唤醒」才挂 <webview>。
 *
 *  为什么不默认活:① 光标进入本段落时装饰整体让位(见文件头交互契约)→ widget 销毁 →
 *  guest 进程被杀,"默认活"在本宿主里做不到持续;② 一个 webview = 一个 OS 渲染进程,
 *  一篇笔记五个嵌入就是五个进程。冻结默认把进程数降到「用户此刻真在看的那一个」。
 *  讲给用户的说法是**「编辑时自动暂停」**,不是"嵌入会掉"。
 *
 *  ⚠️ 任意第三方网页**必须** <webview>,不许 iframe:sandbox 是枚举式开洞,漏掉哪个能力
 *  在写代码时看不出来,而报错会指向网页自己(见 webhost.test.ts)。固定已知的播放器
 *  (YouTube / B 站)走下面那道分流去 `VideoIframe`。 */
export function WebEmbed({ url, toCard }: { url: string; toCard: () => void }): ReactElement {
  const [live, setLive] = useState(false)
  // 视频平台分流放在**最前**:iframe 播放器不需要 <webview>,web/移动端同样能放
  //(2026-08-29 起裸 URL 只渲书签卡,播放器只在这条嵌入形态上出现)。
  if (youtubeId(url) || bilibiliRef(url)) return <VideoIframe url={url} toCard={toCard} />
  // 正文里的 URL 是不可信输入(笔记可能是同步/导入/别人分享来的),而 <webview src> 一挂就自动
  // 导航。默认拒:非 http(s)、localhost、私网、云元数据段。判据与仪表盘网页卡片同一份。
  if (!webviewUrlAllowed(url)) {
    return (
      <div className="amx-web amx-web-blocked">
        <div className="amx-web-note">已拦截:网页嵌入只允许公网 http(s) 地址（拒绝 file/data/javascript、localhost 与内网）。</div>
        <code className="amx-web-url">{url.slice(0, 160)}</code>
        <button className="embed-media-btn" onClick={toCard}>转为书签卡</button>
      </div>
    )
  }
  // web/移动端没有 <webview>(要主进程开 webviewTag)→ 降级书签卡,别渲染个空洞。
  if (!window.tangu) {
    return (
      <div className="amx-web amx-web-degraded">
        <BookmarkCard url={url} />
        <div className="amx-web-note">此端不支持内嵌网页，已降级为书签卡。</div>
      </div>
    )
  }
  if (!live) {
    return (
      <div className="amx-web amx-web-frozen">
        <BookmarkCard url={url} />
        <div className="amx-web-foot">
          <button className="embed-media-btn" onClick={() => setLive(true)}>▶ 唤醒网页</button>
          <span className="amx-web-note">编辑本段时会自动暂停</span>
          <button className="embed-media-btn" onClick={toCard} title="改回裸 URL 一行(书签卡)">转为书签卡</button>
        </div>
      </div>
    )
  }
  // partition 必须钉死:空 partition 会落回权限全放行的 defaultSession。guest 的安全边界在主进程
  // (will-attach-webview 剥 preload/nodeIntegration + 该分区默认拒权限)。
  return (
    <div className="amx-web amx-web-live">
      <div className="amx-web-bar">
        <span className="amx-web-host">{hostOf(url)}</span>
        <button className="embed-media-btn" onClick={() => setLive(false)}>⏸ 冻结</button>
        <button className="embed-media-btn" onClick={() => void window.tangu?.openExternal?.(url)}>在浏览器打开 ↗</button>
      </div>
      <Webview src={url} partition={BROWSER_PARTITION} className="amx-web-view" />
    </div>
  )
}

const hostOf = (u: string): string => {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}
