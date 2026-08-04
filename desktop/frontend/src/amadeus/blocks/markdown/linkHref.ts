/** 行内链接地址的归一 + 安全闸。用户手打的地址会原样落进 `[文字](href)` 并渲染成 `<a href>`,
 *  笔记还会被分享页独立渲染 —— 所以 `javascript:` 这类可执行 scheme 必须在入口就挡掉,不能只靠渲染层。 */

/** 允许出现在 `<a href>` 里的 scheme(小写)。其余带 scheme 的一律拒绝。
 *
 *  ⚠️ 只留 http(s) 是**故意的**,别再往里加 `mailto:` / `tel:` / `file:` / 自定义协议:
 *  桌面端打开外链的唯一出口是主进程的 `shell:openExternal`,而它明确只放 http(s)
 *  (「别的 scheme 经 openExternal 等于让页面唤起任意本机协议处理器」)。这里放行、那里拒绝,
 *  结果就是用户能插进去、点了却毫无反应的死链接。要支持 mailto 得先改主进程那条闸,是另一件事。 */
const SAFE_SCHEMES = ['http:', 'https:']

/**
 * 归一用户输入的链接地址;不可接受则回 null(调用方按「不加链接」处理)。
 * - 裸域名 `example.com/x` → 补 `https://`(同 Obsidian/Notion 的手感)
 * - 站内相对路径 `./a.md`、`/a`、`#锚点` 原样放行
 * - `javascript:` / `data:` / `vbscript:` 等一律拒绝(含 tab/换行插在 scheme 中间的绕过写法)
 */
export function normalizeHref(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  // scheme 判定前先剥掉所有空白与控制字符:`java<TAB>script:alert(1)` 浏览器照样认得。
  const probe = Array.from(s)
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join('')
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(probe)
  if (m) return SAFE_SCHEMES.includes(m[1].toLowerCase() + ':') ? s : null
  if (s.startsWith('//')) return 'https:' + s // 协议相对
  if (s.startsWith('/') || s.startsWith('#') || s.startsWith('./') || s.startsWith('../')) return s
  // 无 scheme 且形似域名(含点、首段非空)→ 补 https://;否则当站内相对路径原样留。
  return /^[^\s/]+\.[^\s/]/.test(s) ? 'https://' + s : s
}
