/**
 * 笔记里的交互块(对标 ChatGPT Pages 的交互组件,2026-10-01):磁盘上就是一个普通围栏代码块
 *
 *   ```forsion-sketch
 *   <div>…HTML / <script>…</div>
 *   ```
 *
 * 纯 md 不变(Obsidian 里看到的是一段 HTML 代码);v4 编辑器的嵌入层(unified/embedLayer)把它交给对话 sketch 卡
 * 同一个沙箱渲染(SketchCard:JS 可跑、无网络无宿主 API、原生壳拒渲染),能力包络与对话里完全一致,不为笔记放宽。
 */
export const SKETCH_LANG = 'forsion-sketch'

/** HTML → 整个围栏。正文里有 ``` 就加长围栏(CommonMark:闭合围栏不短于开启围栏)。 */
export function sketchFence(html: string): string {
  const longest = Math.max(0, ...(html.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${SKETCH_LANG}\n${html.replace(/\s+$/, '')}\n${fence}`
}
