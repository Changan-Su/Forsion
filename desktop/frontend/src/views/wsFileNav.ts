/** 工作区文件「打开预览标签页」统一门面(替代原 chatbox 上方的浮层预览,浮层暂时停用)。
 *  - 有本机路径(target.path)→ 参数只存 {path,name},随布局持久化,重启可恢复;同路径已开则聚焦。
 *  - 无路径(云沙箱/对话内联,load 是闭包不可序列化)→ 存进内存注册表,params 只带注册键;
 *    重启后注册表为空 → WsFileView 显示「内容已过期」占位,从来源重新打开即可。 */
import { useWorkspace } from '@lcl/engine'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'
import { b64ToBytes } from '../services/fileKinds'
import { openLocalHtml } from '../builtins'

interface PanelLike { id: string; params?: Record<string, unknown> }

/** 在途写盘登记:MdFileEditor 的(冲刷)保存挂在这里,读端先等同路径的写完成再读,
 *  防「关标签/收侧栏重挂 → 冲刷未落盘就重读 → 编辑器拿到陈旧内容」的写读竞态。 */
export const pendingWrites = new Map<string, Promise<unknown>>()

/** 本机路径 → PreviewTarget(主进程 readHostFile;download=在文件管理器显示)。 */
export function hostTargetFor(path: string, name: string): PreviewTarget {
  return {
    name,
    path,
    load: async () => {
      const pending = pendingWrites.get(path)
      if (pending) await pending.catch(() => {})
      const r = await window.tangu?.readHostFile?.(path)
      if (!r) return null
      if (r.tooLarge) return { tooLarge: true, size: r.size }
      return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size, mtimeMs: r.mtimeMs }
    },
    // 设备页无 revealHostPath:给 undefined 藏掉下载位(哑弹不如没有);浏览器侧真下载属 A 类快赢另做。
    download: window.tangu?.revealHostPath ? () => { void window.tangu?.revealHostPath?.(path) } : undefined,
  }
}

const transient = new Map<string, PreviewTarget>()
let seq = 0

export function getTransientTarget(key: string): PreviewTarget | undefined {
  return transient.get(key)
}

/** opts.newTab(⌘/Ctrl 单击)= 强开一个新标签页,跳过「同路径已开就聚焦过去」——语义同 openNote。
 *  opts.line/endLine(聊天行号引用条)= 打开后滚到该行并高亮;已开的同路径页走 goto 事件就地跳
 *  (WsFileView 自己听 amadeus:wsfile-goto,pdf-goto 同款通路)。
 *  opts.t / opts.tTo(**库外**音视频的时刻引用条 `[[/abs/a.mp4#t=95,120]]`)= 打开后 seek 到那一秒,
 *  有终点就到点暂停(区间锚;原生 loop 不认片段,W3C bug 12426 WONTFIX)。
 *  ⚠️ 库内媒体不走这里 —— WsFileView 把整份文件读成 base64 再 Blob(还带 tooLarge 上限),
 *     GB 级视频当场变「文件过大」;库内走 amadeusNav.openMedia(amadeus-asset:// 流式)。 */
export function openWsFile(target: PreviewTarget, opts?: { newTab?: boolean; line?: number; endLine?: number; t?: number; tTo?: number }): void {
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  if (target.path) {
    // 本地 .html 交给内置浏览器(file:// 直开,页面里的相对资源/跳转都对);wsfile 预览器只会把它
    // 当文本渲染。内置浏览器被关掉 → openLocalHtml 返 false,照旧落 wsfile 预览。
    // 带行锚(引用条)例外:浏览器渲染页里没有「第 N 行」,进 wsfile 源码视图才有落点。
    if (!opts?.line && /\.html?$/i.test(target.path) && openLocalHtml(target.path)) return
    const hit = opts?.newTab ? null : api?.panels.find((p) => p.params?.__type === 'wsfile' && p.params?.path === target.path)
    if (hit) {
      ws.activateLeaf(hit.id)
      // 带行锚 → 就地跳;**不带** → 发 clear:上一次引用把 csv/diff 锁在源码高亮态,普通方式
      // 重开同一文件必须能回到表格/对比视图(Codex 二审:focus 只设不清 = 永久锁死)。
      window.dispatchEvent(new CustomEvent('amadeus:wsfile-goto', opts?.line
        ? { detail: { path: target.path, line: opts.line, endLine: opts.endLine } }
        : typeof opts?.t === 'number'
          ? { detail: { path: target.path, t: opts.t, tTo: opts.tTo } }
          : { detail: { path: target.path, clear: true } }))
      return
    }
    const params: Record<string, unknown> = { path: target.path, name: target.name }
    if (opts?.line) { params.line = opts.line; if (opts.endLine) params.endLine = opts.endLine }
    if (typeof opts?.t === 'number') { params.t = opts.t; if (typeof opts.tTo === 'number') params.tTo = opts.tTo }
    ws.openView('wsfile', params, 'main', { newTab: true })
    return
  }
  // 清掉不再被任何已开 panel 引用的瞬态目标(闭包可能持有整份文件字节,别让它随关闭的标签滞留)。
  const alive = new Set(api?.panels.map((p) => p.params?.tkey).filter(Boolean) ?? [])
  for (const k of transient.keys()) if (!alive.has(k)) transient.delete(k)
  const key = `t${++seq}`
  transient.set(key, target)
  ws.openView('wsfile', { tkey: key, name: target.name }, 'main', { newTab: true })
}
