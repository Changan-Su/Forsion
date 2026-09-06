/**
 * 钉住的 RTC SDK 在**生产 CSP + new Function 装载姿势**下还活着吗 —— 联网体检。
 *
 * 与 `check:rtc` 分开的原因:那条是离线的、进得了 CI;这条要真去 CDN 拉几百 KB,
 * 只在「升级 SDK」「通话忽然连不上」时手动跑。别把它塞进 npm test。
 *
 * 为什么必须有这条:通话插件不打包 SDK,而是运行时 fetch + `new Function` 求值。这个姿势下
 * **没有 script base URL** —— SDK 内部任何靠相对路径拿 worker / wasm 的写法都会解析失败,
 * 而且是静默降级(音频变差、功能不生效),不报错、不崩、日志里什么都没有。
 *
 * 2026-09-06 从腾讯 TRTC 换到 LiveKit。两者在这条闸上的差别值得记:
 *  · TRTC 的 dist 有 3 个 `new Worker`(走 blob,靠 CSP 的 worker-src blob: 兜住)
 *    和一处 `document.currentScript.src` 取基址(懒调用,只服务美颜/虚拟背景那族 wasm);
 *  · LiveKit 的 UMD 实测 worker / wasm / currentScript / import.meta **全为 0** —— 没有这类隐患。
 * 所以下面 C6 的断言方向是「必须为 0」:哪天厂商改了构建方式引入这些东西,要当场知道。
 *
 * 用法:npm run check:rtcsdk
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { createHash } = require('node:crypto')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
// 与插件里钉的两个常量保持一致。升级 SDK = 三处同改(插件的 SDK_VERSION / SDK_SHA256 + 这里)。
const SDK_VERSION = '2.22.2'
const SDK_SHA256 = 'f4a1987c5b480b734bf1593e6aa9feecfe027ba826fecc2f867943f9b8830366'
const GLOBAL_NAME = 'LivekitClient' // ⚠️ 小写 k,实测确认;写成 LiveKitClient 会拿到 undefined
const URLS = [
  `https://cdn.jsdelivr.net/npm/livekit-client@${SDK_VERSION}/dist/livekit-client.umd.js`,
  `https://unpkg.com/livekit-client@${SDK_VERSION}/dist/livekit-client.umd.js`,
]

const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const note = (name, detail) => console.log(`INFO  ${name}${detail ? '  | ' + detail : ''}`)

const indexHtml = readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8')
const CSP = (/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml) || [])[1] || ''
check('S1 connect-src 放行 wss:(LiveKit 的信令走 WebSocket,没这条一步都走不了)',
  /connect-src[^;]*\bwss:/.test(CSP), (/connect-src [^;]+/.exec(CSP) || [])[0] || '(无 connect-src)')

// 插件与本脚本必须钉同一个版本/哈希,否则「体检绿了、用户装的还是旧的」。
const pluginMain = path.join(os.homedir(), '.forsion-dev/plugins/callroom/main.js')
try {
  const src = readFileSync(pluginMain, 'utf8')
  const v = (/const SDK_VERSION = '([^']+)'/.exec(src) || [])[1]
  const h = (/const SDK_SHA256 = '([0-9a-f]{64})'/.exec(src) || [])[1]
  check('S2 已安装插件钉的版本/哈希与本脚本一致(不一致=体检守的不是用户实际加载的那份)',
    v === SDK_VERSION && h === SDK_SHA256, `插件 ${v} / ${(h || '').slice(0, 12)}…`)
} catch {
  note('S2 跳过', `未安装插件(${pluginMain})`)
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rtcsdk-'))
const page = path.join(tmp, 'p.html')
writeFileSync(page, `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="${CSP}"><body>probe`)

async function main() {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false } })
  await win.loadFile(page)

  const fetched = await win.webContents.executeJavaScript(`(async () => {
    const out = []
    for (const u of ${JSON.stringify(URLS)}) {
      try {
        const res = await fetch(u, { cache: 'no-store' })
        out.push({ u, status: res.status, text: await res.text() })
      } catch (e) { out.push({ u, err: String(e).slice(0, 140) }) }
    }
    return out
  })()`)

  let good = null
  for (const f of fetched) {
    if (f.err || f.status !== 200) { note(`源不可达 ${f.u}`, f.err || `HTTP ${f.status}`); continue }
    const hash = createHash('sha256').update(f.text).digest('hex')
    const ok = hash === SDK_SHA256
    note(`源 ${f.u}`, `${f.text.length} 字节, sha256 ${ok ? '一致' : '**不一致** ' + hash.slice(0, 16) + '…'}`)
    if (ok && !good) good = f.text
  }
  check(`C1 至少一个 CDN 供出与钉住哈希一致的 livekit-client@${SDK_VERSION}(全不一致 = 厂商换版了,三处常量要同步更新)`,
    !!good, good ? '' : `期望 ${SDK_SHA256.slice(0, 16)}…`)

  if (good) {
    const probe = await win.webContents.executeJavaScript(`(async () => {
      const viol = []
      document.addEventListener('securitypolicyviolation', e => viol.push(e.blockedURI + ' / ' + e.effectiveDirective))
      const src = await (await fetch(${JSON.stringify(URLS[0])}, { cache: 'force-cache' })).text()
      let err = null, globalType = 'none', room = false, supported = null
      try {
        new Function(src)()          // 与插件逐字同一种装载姿势
        const G = window.${GLOBAL_NAME}
        globalType = typeof G
        if (G) {
          room = !!new G.Room()
          supported = typeof G.isBrowserSupported === 'function' ? G.isBrowserSupported() : 'n/a'
        }
      } catch (e) { err = String(e).slice(0, 240) }
      await new Promise(r => setTimeout(r, 500))
      return { err, globalType, room, supported, viol }
    })()`)

    check('C2 new Function 求值不抛(抛了说明 SDK 改成了依赖 script 上下文的构建方式)',
      probe.err === null, probe.err || '')
    check(`C3 求值后暴露 ${GLOBAL_NAME} 全局,且 new Room() 可用`,
      probe.globalType === 'object' && probe.room, `typeof=${probe.globalType}, room=${probe.room}`)
    check('C4 isBrowserSupported() 在真 Electron + 生产 CSP 下为 true',
      probe.supported === true || probe.supported === 'n/a', String(probe.supported))
    check('C5 整个装载过程零 CSP 违规', probe.viol.length === 0, JSON.stringify(probe.viol))

    // 静态闸:基址/worker 依赖必须保持为 0 —— 见文件头
    for (const pat of ['currentScript', 'import.meta', '.wasm', 'new Worker', 'importScripts']) {
      const n = good.split(pat).length - 1
      check(`C6 dist 里不含 \`${pat}\`(new Function 求值没有 script 基址,含了会静默降级)`, n === 0, `出现 ${n} 处`)
    }
  }

  win.destroy()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  app.exit(failed.length ? 1 : 0)
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1) })
