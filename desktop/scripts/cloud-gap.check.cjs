#!/usr/bin/env node
/**
 * check:cloudgap —— Web / 移动端云桥断线补课(评审 G2-01)。
 *
 * 症状:手机切后台 / 换网络回来,开着的 v4 笔记不显示别处的修改;打一个字,那些修改就从云端消失(409 → 强写)。
 * 根因两半:① cloudEvents 重连不带 ?since=,服务端的增量重放用不上,只能靠「见缺口就补课」;② 补课只回灌
 * lastLoadedPage(v3 loadPage 设的),v4 笔记只经 readTextFile 打开 → 漏补。
 *
 * 做法:esbuild 把 scripts/cloud-gap.entry.ts(生产 web/src/amadeus/cloudBridge + cloudEvents + unified lifecycle,
 * 外加按服务端契约建模的假服务端)打成一个 node 包真跑,不起浏览器、不连网。
 *   node scripts/cloud-gap.check.cjs
 * 负对照(修复时实跑):重连不带 since → G1–G4、G7/G8 红;兜底只补 lastLoadedPage → G5/G6 红;
 *   hello 就把 lastSeq 推到服务端 seq → G7/G8 红。
 * G9–G13 = writeTextFile 带 base 的比对交换写(Codex g3#1):409 分支不比指纹、改回强写 → G9 红;
 *   摘掉写前的本端指纹预检 → G10 红(G9 仍绿);G11 是不带 base 老语义的阳性对照。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgap-')), 'cloud-gap.bundle.cjs')
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'cloud-gap.entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // 与 web 构建同一套别名(@ / @amadeus-shared / @lcl …);cloudBridge 与 entry 引的 lifecycle 因此是同一个模块实例。
  tsconfig: path.join(ROOT, '../web/tsconfig.json'),
  outfile: out,
  logLevel: 'warning',
})

;(async () => {
  const results = await require(out).run()
  let failed = 0
  for (const r of results) {
    if (!r.ok) failed++
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`)
  }
  console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nall ${results.length} passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('CHECK CRASHED', e); process.exit(2) })
