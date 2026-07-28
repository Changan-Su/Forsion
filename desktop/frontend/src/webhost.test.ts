/**
 * 网页宿体防线 —— 结构性地挡住「iframe 静默削能力」这一类回归。
 *
 * 起因(2026-07-27 实报):Coding Space 用 `<iframe sandbox="…">` 承载 agent 生成的项目,
 * sandbox 少一个 `allow-pointer-lock`,FPS 项目就锁不上鼠标;报错指着**用户项目的代码行**,
 * agent 于是把游戏改成「兼容模式」绕开 —— 宿体缺陷被当成项目缺陷,改坏了用户的产出。
 *
 * 规则(只有一条):
 *   **你不知道它会用什么 Web API 的内容(用户/agent 生成的 HTML、第三方网页)→ 必须 `<webview>`。**
 *   `<iframe>` 只允许承载**固定、已知**的嵌入(YouTube、我们自己的 PDF 阅读器),且要显式写 `allow=`。
 *   `srcDoc` 一律不行:它继承宿主 CSP + 不透明源。
 *
 * 为什么不能靠"记得加 token":sandbox 是**枚举式开洞**,漏掉哪个能力在写代码时根本看不出来
 * (pointer lock / downloads / fullscreen / gamepad / file picker 各有各的闸),只有用户撞上才知道。
 * 所以这里不检查 token 全不全,直接禁掉这种宿体。
 *
 * 新增用途请先想清楚它属于哪一类;确实是"固定已知嵌入"再加 `// webhost-ok: 理由` 豁免。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// 覆盖到 JSX 标签、字符串形式的标签名(`const F = 'iframe' as any` 这种别名写法)、以及同类宿体
// `<embed>/<object>`。**这是防误用的护栏,不是沙箱** —— 铁了心要绕(动态拼标签名、innerHTML、
// 插件运行时自己 mount)绕得过去;它的职责是让**顺手写下的** iframe 在 CI 里立刻变红。
const SRC = join(__dirname)
const BAD = /<iframe|<embed[\s/>]|<object[\s/>]|srcDoc=|['"]iframe['"]/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('网页宿体', () => {
  it('渲染层不得新增未豁免的 <iframe> / srcDoc', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!BAD.test(line)) return
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return // 注释里提到 <iframe> 不算宿体(这些规则本身就写在注释里)
        // 同行或前三行里有豁免注释即放行(注释里要写清为什么这是"固定已知嵌入")
        const ctx = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
        if (ctx.includes('webhost-ok:')) return
        offenders.push(`${relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 90)}`)
      })
    }
    expect(offenders, [
      '发现未豁免的 <iframe>/srcDoc。任意/agent 生成的网页内容必须用 <webview>(见 builtins/browserView.tsx 的 Webview),',
      '否则 sandbox 会静默削掉 pointer lock / 下载 / 全屏 / 文件选择器等能力,而报错会指向用户自己的代码。',
      '确属固定已知嵌入(YouTube、自家 PDF 阅读器)→ 加 `// webhost-ok: 理由` 豁免。',
    ].join('\n')).toEqual([])
  })
})
