/**
 * 把 LLM 常输出的 \(…\) / \[…\] LaTeX 定界符归一化为 remark-math 认得的 $…$ / $$…$$。
 * remark-math 默认只认 $ 系定界符,不认 \( \[ —— 这是公式「渲染不出来」的常见根因。
 * 保护 ``` 围栏与 `行内代码` 不被改写。
 *
 * ponytail: \\( 双反斜杠转义、流式未闭合围栏是已知缺口,真咬人再换成 remark 插件。
 */
export function normalizeMath(src: string): string {
  if (!src.includes('\\(') && !src.includes('\\[')) return src // 快路径:绝大多数文本零成本
  // split 捕获组:奇数下标 = 代码段(原样保留),偶数下标 = 普通文本(才做替换)。
  return src
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) =>
      i % 2
        ? seg
        : seg
            .replace(/\\\[([\s\S]+?)\\\]/g, (_m, x) => `$$${x}$$`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_m, x) => `$${x}$`),
    )
    .join('')
}
