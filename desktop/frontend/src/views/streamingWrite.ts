/** 从「流式、可能被截断」的工具调用 arguments JSON 里,容错抽取写文件的 path 与 content。
 *  用于 Coding Space 主区「边写边显示代码」(AI Studio 式流式):写文件工具的 content 参数
 *  正是被生成的源码,tool_stream 逐段累积 arguments,故这里对半截的 JSON 字符串做增量解码。 */

/** 从 s[openQuote]('"')起解码一个 JSON 字符串,遇到未转义 '"' 收尾;字符串未闭合(仍在流式)则返回已解码部分。 */
export function decodeJsonStringAt(s: string, openQuote: number): string {
  let out = ''
  let i = openQuote + 1
  while (i < s.length) {
    const c = s[i]
    if (c === '"') return out // 闭合
    if (c === '\\') {
      const n = s[i + 1]
      if (n === undefined) break // 截断的转义 → 停
      switch (n) {
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case '/': out += '/'; break
        case '"': out += '"'; break
        case '\\': out += '\\'; break
        case 'u': {
          const hex = s.slice(i + 2, i + 6)
          if (hex.length < 4 || /[^0-9a-fA-F]/.test(hex)) return out // 截断/非法 unicode → 停
          out += String.fromCharCode(parseInt(hex, 16)); i += 4; break
        }
        default: out += n // 未知转义:原样保留转义后字符
      }
      i += 2
    } else { out += c; i++ }
  }
  return out // 截断(仍在流式)
}

const KEY_RE = new Map<string, RegExp>()
function keyRe(k: string): RegExp {
  let re = KEY_RE.get(k)
  if (!re) { re = new RegExp(`"${k}"\\s*:\\s*"`); KEY_RE.set(k, re) } // key 均为常量,无 ReDoS
  return re
}
function findKeyString(s: string, keys: string[]): string | undefined {
  for (const k of keys) {
    const m = keyRe(k).exec(s)
    if (m) return decodeJsonStringAt(s, m.index + m[0].length - 1) // m[0] 以开引号结尾
  }
  return undefined
}

const PATH_KEYS = ['path', 'file_path', 'filename']
const CONTENT_KEYS = ['content', 'file_text', 'text', 'new_str', 'new_string']

/** 容错解析写文件工具的流式参数 → { path?, content? }(任一缺失即未出现在已到达的片段里)。 */
export function parseStreamingWrite(args: string): { path?: string; content?: string } {
  if (!args) return {}
  return { path: findKeyString(args, PATH_KEYS), content: findKeyString(args, CONTENT_KEYS) }
}
