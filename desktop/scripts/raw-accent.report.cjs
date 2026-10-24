#!/usr/bin/env node
// 报告式（不阻断）：列出仍把主题色本色当「指示 / 悬停」用的地方（DESIGN §1「主题色色阶与强调色」）。
// 命中 = 一行里 border / outline / box-shadow / stroke / fill / accent-color 用了 var(--accent) / var(--accent-ink)，
// 或 :hover 规则里出现它们。氛围淡底与文字色（color:）不算 —— 它们本该跟主题色。
// 用法：node scripts/raw-accent.report.cjs [子目录…]（缺省 frontend/src 与 ../lcl）
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['frontend/src', '../lcl']
const SKIP = /node_modules|[\\/]theme[\\/](skins|themes)|styles[\\/]base\.css|tanguSoft\.css|\.test\./
const RAW = /var\(--accent(-ink)?[,)]/
const PROP = /(border(-[a-z]+)?-?(color)?|outline|box-shadow|stroke|fill|accent-color)\s*:[^;]*var\(--accent(-ink)?[,)]/

const hits = {}
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (SKIP.test(p)) continue
    if (e.isDirectory()) walk(p)
    else if (/\.(css|tsx)$/.test(e.name)) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
        if (RAW.test(l) && (PROP.test(l) || /:hover/.test(l))) (hits[path.relative(root, p)] ||= []).push(i + 1)
      })
    }
  }
}
for (const d of dirs) walk(path.join(root, d))
const files = Object.entries(hits).sort((a, b) => b[1].length - a[1].length)
for (const [f, ls] of files) console.log(`${String(ls.length).padStart(3)}  ${f}:${ls.join(',')}`)
console.log(`\n${files.reduce((n, [, ls]) => n + ls.length, 0)} hits in ${files.length} files (report only)`)
