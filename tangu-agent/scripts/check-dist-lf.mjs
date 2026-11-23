#!/usr/bin/env node
// 引擎产物里不许有 CR(\r)。引擎热更新(src/boot/overlay.ts checkOverlay)逐字节比对安装包自带的建表文件(SCHEMA_FILES),
// npm 上的热更新包在 Linux 上打,是 LF。Windows runner 的 git 缺省 core.autocrlf=true,检出成 CRLF 时 tsc 会把模板串 / 注释里的
// \r 原样编进 dist —— 2.14.2 的 Windows 安装包就是这样拒收了所有引擎热更新(2026-11-20:遥测 engine incompatible 全是 win32,
// 实包里 dist/db/migrate.js 带 204 个 \r,去掉后与 npm 上的 2.14.7 逐字节相同)。源码里本来一个 \r 都没有,所以这条闸不留例外。
// 用法:node scripts/check-dist-lf.mjs [dist]
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TEXT = /\.(?:[cm]?js|json|md|ts|map)$/

/** dir 下含 \r 的文本文件(相对路径,/ 分隔,排好序)。 */
export function filesWithCR(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && TEXT.test(e.name) && readFileSync(p).includes(13)) out.push(path.relative(dir, p).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir = process.argv[2] ?? 'dist'
  const bad = filesWithCR(dir)
  if (bad.length) {
    console.error(`::error::${bad.length} file(s) under ${dir} contain CR (\\r): the checkout was converted to CRLF, so this build's engine would reject every engine hot update. ${bad.slice(0, 10).join(', ')}`)
    process.exit(1)
  }
  console.log(`${dir}: no CR in the engine build output`)
}
