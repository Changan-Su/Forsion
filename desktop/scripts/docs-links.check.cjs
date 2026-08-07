#!/usr/bin/env node
/**
 * 用户文档体检:../docs 下的 md 是否还能当文档中心用。
 *
 *   node scripts/docs-links.check.cjs      (= npm run check:docs)
 *
 * 查四件会真正坑到读者的事:
 *   1. frontmatter 缺 title / description(目录页和未来的站点靠它取标题与摘要)
 *   2. 相对链接死链
 *   3. 有页面没被 docs/README.md 收录(写了等于没写)
 *   4. 过期说法复活(下线的功能、改过名的术语)
 *
 * ponytail: 纯正则 + fs,不引 markdown 解析器;文档量级(几十页)不值得。
 */
const fs = require('fs')
const path = require('path')

const DOCS = path.resolve(__dirname, '../../docs')
const INDEX = path.join(DOCS, 'README.md')

// 过期说法 → 现在该怎么说。命中即失败。
const STALE = [
  [/Claude\s*(\/\s*ChatGPT\s*)?订阅.{0,6}(登录|OAuth)/, '「Claude 订阅登录」已于 2.7.4 移除,改写成 Anthropic API key 直连 / 外部引擎跑本机 Claude Code'],
  [/云同步/, '正式名称是「在线同步」'],
  [/定时发送/, '收件箱定时发送已下线,定时提醒统一走自动化'],
  [/按月(计|算)|每月额度|月度额度/, '额度按周计'],
  [/Forsion Desktop 2\.6/, '文档已对齐 2.7+'],
]

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return e.isFile() && e.name.endsWith('.md') ? [p] : []
  })

const rel = (p) => path.relative(DOCS, p)
const fail = []
const warn = []

const pages = walk(DOCS).sort()
if (!pages.length) fail.push('docs/ 下一个 md 都没有')

const indexSrc = fs.readFileSync(INDEX, 'utf8')

for (const file of pages) {
  const src = fs.readFileSync(file, 'utf8')
  const id = rel(file)

  // 1. frontmatter
  const fm = src.startsWith('---') ? src.slice(3, src.indexOf('\n---', 3)) : ''
  if (!/^title:\s*\S/m.test(fm)) fail.push(`${id}: frontmatter 缺 title`)
  if (!/^description:\s*\S/m.test(fm)) fail.push(`${id}: frontmatter 缺 description`)

  // 2. 相对链接。跳过行内代码与代码块里的内容。
  const body = src.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = m[1].trim()
    if (/^(https?:|mailto:|#)/.test(href)) continue
    const target = path.resolve(path.dirname(file), href.split('#')[0])
    if (!fs.existsSync(target)) fail.push(`${id}: 死链 -> ${href}`)
  }

  // 3. 被首页收录
  if (file !== INDEX && !indexSrc.includes(id)) fail.push(`${id}: 没有出现在 docs/README.md,读者找不到`)

  // 4. 过期说法。同一行里带否定词的放行 —— FAQ 里"没有『用 X 登录』这条路"是正确答案,不是复活。
  for (const line of body.split('\n')) {
    if (/没有|不支持|不再|已移除|已下线/.test(line)) continue
    for (const [re, why] of STALE) {
      const hit = line.match(re)
      if (hit) fail.push(`${id}: 出现过期说法「${hit[0]}」—— ${why}`)
    }
  }

  // 篇幅只警告:用户文档写成发布说明就没人读了
  const lines = src.split('\n').length
  if (file !== INDEX && lines > 130) warn.push(`${id}: ${lines} 行,偏长,考虑拆页或砍罗列`)
  if (file !== INDEX && lines < 20) warn.push(`${id}: ${lines} 行,偏薄`)
}

for (const w of warn) console.log(`  ⚠ ${w}`)
if (fail.length) {
  console.error(`\n✗ 文档体检不通过(${fail.length} 项):`)
  for (const f of fail) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ 文档体检通过:${pages.length} 页,frontmatter / 链接 / 索引 / 术语均正常`)
