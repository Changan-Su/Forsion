/**
 * sketch 草稿卡(2026-10-09,对标 ChatGPT Intelligent UI「边生成边渲染」):工具参数还在流式生成时,
 * 就把已到达的 html 画出来 —— 结构先于行为。
 * - 只去掉**行为脚本**:写了一半的 JS 每次重绘都会抛错、也可能把半截 DOM 改坏;收口后的终稿才带脚本跑一次。
 * - `<script type="application/json">` 是 fs-chart / fs-flow 的数据,留着(半截 JSON 解析失败 = 空图,收口即好)。
 * - 结尾没闭合的 `<script …>` 与写到一半的 `<scr` 一律切掉(浏览器会把后面全部当脚本正文)。
 * - 标签里的内联事件处理器(`onload` / `onerror` / `onbegin` …)也去掉:它们不用点击就会跑(Codex 10-09)。
 * ⚠️ 只认真正的 `type=` 属性:`data-type="application/json"` 是可执行脚本,不是数据(Codex 10-09)。
 * 安全边界与终稿完全一致:同一个 sandbox + 内层 CSP,草稿只是少了脚本。
 */
const NOT_JSON = '(?![^>]*\\stype\\s*=\\s*["\']?application/json\\b)'
const SCRIPT_BLOCK_RE = new RegExp(`<script\\b${NOT_JSON}[^>]*>[\\s\\S]*?</script\\s*>`, 'gi')
const SCRIPT_TAIL_RE = new RegExp(`<script\\b${NOT_JSON}[^>]*>[\\s\\S]*$`, 'i')
const TAG_TAIL_RE = /<script\b[^>]*$/i
/** 标签(含结尾没闭合的那个)里的 on* 属性;只在标签内替换,正文里的「online=」不动。
 *  ponytail: 正则不是 HTML 解析器 —— 属性值里带 `>`(`title="a>b" onerror=x`)会让 OPEN_TAG_RE 提前收口、漏掉后面的处理器。
 *  这层只是草稿期的「别自己乱动」稳定措施,安全边界始终是 sandbox + 内层 CSP(终稿本来就会跑这些脚本);真要严丝合缝再换 DOMParser。 */
const OPEN_TAG_RE = /<[a-zA-Z][^>]*(?:>|$)/g
const HANDLER_ATTR_RE = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

export function draftHtml(partial: string): string {
  return partial
    .replace(SCRIPT_BLOCK_RE, '')
    .replace(SCRIPT_TAIL_RE, '')
    .replace(TAG_TAIL_RE, '')
    .replace(OPEN_TAG_RE, (tag) => tag.replace(HANDLER_ATTR_RE, ''))
}
