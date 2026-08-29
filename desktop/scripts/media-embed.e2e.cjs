/**
 * 媒体锚点 × 网页嵌入的**真 Electron** e2e。用法:npm run build && npm run e2e:mediaembed
 *
 * 为什么非真机不可(harness/无头 Chromium 结构性照不到的三件事):
 *   E1 `amadeus-asset://` 协议只在主进程注册 —— 台架里视频根本 load 不了,
 *      「起播落在 95 秒」在那儿只能靠桩 data: URL 近似,这里量的是**真协议 + 真 Range 分段读**。
 *   E2 `<webview>` 在普通 Chromium 里只是个未知标签(不加载、无进程)。冻结→唤醒→**冻结再唤醒**
 *      这条路只有真机能验:PM 装饰层会复用/重挂 widget DOM,而 webview 一旦被摘出 DOM 就是销毁重建。
 *   E3 截帧要 canvas 读像素 —— 跨源污染只在真协议下才成立/不成立(我们给协议加了 ACAO,
 *      并在 <video> 上开 crossOrigin;错了的话失败形态是**视频压根不加载**,台架看不出来)。
 *
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先 pkill -f "node_modules/electron/dist/Electron.app"。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${!!ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 200 秒 8kHz 静音 wav —— 免 ffmpeg,Chromium 一定认,且够 seek 到 95 秒。 */
function silentWav(seconds) {
  const rate = 8000
  const n = rate * seconds
  const buf = Buffer.alloc(44 + n)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34)
  buf.write('data', 36); buf.writeUInt32LE(n, 40)
  buf.fill(128, 44)
  return buf
}

/** 200 秒纯色静音 mp4。ffmpeg 缺席 → 返回 null,视频档断言整体 SKIP(本仓做转录本来就依赖 ffmpeg,
 *  有它的机器能拿到全量覆盖;没有的机器至少音频档仍然真跑)。 */
function makeMp4(dst) {
  try {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:d=200:r=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dst], { stdio: 'ignore' })
    return fs.existsSync(dst) ? dst : null
  } catch { return null }
}

/** 最小合法 PNG(8×8 纯色)—— 用来探同协议资源画进 canvas 会不会被跨源污染。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64')

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mediaembed-'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(path.join(vaultDir, '素材'), { recursive: true })
  fs.writeFileSync(path.join(vaultDir, '素材', 'lecture.wav'), silentWav(200))
  fs.writeFileSync(path.join(vaultDir, '素材', 'probe.png'), TINY_PNG)
  const mp4 = makeMp4(path.join(vaultDir, '素材', 'clip.mp4'))
  if (!mp4) console.log('  (没有 ffmpeg → 视频档 SKIP,音频档照跑)')
  fs.writeFileSync(path.join(vaultDir, '媒体.md'), [
    '# 媒体', '',
    '开篇一句。', '',
    '![[lecture.wav#t=95]]', '',
    ...(mp4 ? ['![[clip.mp4#t=95]]', ''] : []),
    '![[probe.png]]', '',
    '![[https://example.com/page]]', '',
  ].join('\n'))
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(path.join(udDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }))

  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.waitForTimeout(1500)

    // 确定性打开那篇笔记。⚠️ 别指望「上次 Space」—— dev 模式 userData 恒为 forsion-desktop-dev,
    // e2e 与用户 dev 实例**共用 renderer 存储**,谁最后用谁说了算(e2e:pdfcite 为此三连红过)。
    // 打开走 `amadeus:open-file` 事件(渲染层不 import 宿主 openFile 的既定解耦口)。
    for (let i = 0; i < 3 && !(await win.locator('.embed-media').count().catch(() => 0)); i++) {
      await win.evaluate(() => window.dispatchEvent(new CustomEvent('amadeus:open-file', { detail: { path: '媒体.md' } })))
        .catch(() => {})
      await win.waitForTimeout(2000)
      if (await win.locator('.embed-media').count().catch(() => 0)) break
      // 退路:切到有 Amadeus 的 Space,再从文件树点开
      const sp = win.locator('.rb-space').nth(i)
      if (await sp.count().catch(() => 0)) { await sp.click().catch(() => {}); await win.waitForTimeout(1500) }
      const row = win.locator('[class*="row"]', { hasText: '媒体' }).first()
      if (await row.count().catch(() => 0)) {
        await row.click().catch(() => {})
        await win.waitForTimeout(800)
        await row.dblclick().catch(() => {})
      }
      await win.waitForTimeout(2000)
    }
    if (!(await win.locator('.embed-media').count().catch(() => 0))) {
      if (process.env.SHOT) await win.screenshot({ path: path.join(process.env.SHOT, 'mediaembed-FAIL.png') })
      const diag = await win.evaluate(() => ({
        pm: document.querySelectorAll('.ProseMirror').length,
        rows: [...document.querySelectorAll('[class*=row], [class*=tree]')].slice(0, 6).map((e) => e.className),
        text: (document.querySelector('.ProseMirror')?.textContent || '').slice(0, 80),
      })).catch((e) => ({ err: String(e) }))
      console.log('  打不开笔记 —— 先看失败截图/诊断再改代码(别先怀疑被测代码):', JSON.stringify(diag))
    }
    await win.waitForSelector('.embed-media', { timeout: 20_000 })
    await win.waitForTimeout(1200)

    // ── E1:真协议 + 真 Range 下起播落在 95 秒 ──────────────────────────────────
    const seek = await win.evaluate(async () => {
      const el = document.querySelector('.embed-media video, .embed-media audio')
      if (!el) return { err: 'no media element' }
      for (let i = 0; i < 100 && el.readyState < 1; i++) await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 500))
      return { ready: el.readyState, at: el.currentTime, dur: el.duration, src: String(el.currentSrc || el.src).slice(0, 40), anon: el.crossOrigin }
    })
    check('E1 amadeus-asset:// 真协议下元数据可加载(Range 分段读没把它读裂)',
      seek.ready >= 1 && seek.dur > 190, JSON.stringify(seek))
    check('E1 `![[lecture.wav#t=95]]` 起播真的落在 95 秒', Math.abs(seek.at - 95) < 1.5, `at=${seek.at}`)
    // 音频**故意**不开 crossOrigin(没有帧可截,开了只是白白多一道 CORS 闸)。视频才开。
    check('E1 音频档不开 crossOrigin(截帧只对视频有意义)', seek.anon == null, `crossOrigin=${seek.anon}`)
    if (mp4) {
      const v = await win.evaluate(async () => {
        const el = [...document.querySelectorAll('.embed-media video')][0]
        if (!el) return { err: 'no video' }
        for (let i = 0; i < 100 && el.readyState < 1; i++) await new Promise((r) => setTimeout(r, 100))
        await new Promise((r) => setTimeout(r, 500))
        // 截帧真链路:canvas.drawImage(video) → toDataURL。跨源污染会在这一步抛 SecurityError。
        let shot = null
        try {
          const c = document.createElement('canvas')
          c.width = el.videoWidth; c.height = el.videoHeight
          c.getContext('2d').drawImage(el, 0, 0)
          shot = c.toDataURL('image/png').slice(0, 22)
        } catch (e) { shot = 'ERR:' + e.name }
        return { ready: el.readyState, at: el.currentTime, anon: el.crossOrigin, w: el.videoWidth, shot }
      })
      check('E1v 视频档:crossOrigin=anonymous 没把加载搞挂(挂了 onError 会退成 null)',
        v.anon === 'anonymous' && v.ready >= 1, JSON.stringify({ anon: v.anon, ready: v.ready }))
      check('E1v 视频档起播也落在 95 秒', Math.abs(v.at - 95) < 1.5, `at=${v.at}`)
      check('E3v **截帧真链路**:drawImage + toDataURL 不抛 SecurityError(画布没被污染)',
        typeof v.shot === 'string' && v.shot.startsWith('data:image/png'), String(v.shot))
    }

    // ── E3:同协议资源在**声明了 crossOrigin 时**不污染画布(截帧的前提)──────────
    // ⚠️ 这里必须自己新建一个带 crossOrigin 的 Image:页面里那些 `![[pic.png]]` 是**普通 <img>**
    // (没声明 crossOrigin),按规范它们本来就会污染画布 —— 拿它们探等于测了个必然结论。
    const taint = await win.evaluate(async () => {
      const el = document.querySelector('.embed-image, .am-app img')
      const url = el?.getAttribute('src') || ''
      if (!/^amadeus-asset:/.test(url)) return { skipped: true, url: url.slice(0, 40) }
      const img = new Image()
      img.crossOrigin = 'anonymous'
      const ok = await new Promise((res) => {
        img.onload = () => res(true); img.onerror = () => res(false); img.src = url
      })
      if (!ok) return { loadFailed: true } // corsEnabled 缺席时的**另一种**失败形态:压根加载不了
      try {
        const c = document.createElement('canvas')
        c.width = 8; c.height = 8
        c.getContext('2d').drawImage(img, 0, 0)
        return { tainted: false, head: c.toDataURL().slice(0, 15) }
      } catch (e) { return { tainted: true, name: e.name } }
    })
    check('E3 声明 crossOrigin 的同协议资源不污染画布(corsEnabled 缺席时这条必红)',
      taint.tainted === false || taint.skipped === true, JSON.stringify(taint))

    // ── E2:网页嵌入 冻结 → 唤醒 → 再冻结 → 再唤醒 ───────────────────────────
    await win.waitForSelector('.amx-web', { timeout: 15_000 })
    const beforeWake = await win.locator('.amx-web webview').count()
    check('E2 默认冻结:真机上也没有活 <webview>', beforeWake === 0, `webview=${beforeWake}`)

    await win.locator('.amx-web-frozen .embed-media-btn', { hasText: '唤醒' }).first().click()
    await win.waitForTimeout(2500)
    const woke = await win.evaluate(() => {
      const wv = document.querySelector('.amx-web-live webview')
      return { present: !!wv, tag: wv?.tagName, url: wv?.getAttribute?.('src') || '', part: wv?.getAttribute?.('partition') || '' }
    })
    check('E2 唤醒后挂上真 <webview>,且 partition 钉死(空 partition 会落回权限全放行的 defaultSession)',
      woke.present && /persist:|browser/i.test(woke.part), JSON.stringify(woke))

    // 冻结再唤醒:webview 被摘出 DOM = 销毁重建,这条验的是**恢复得回来**(而不是留下一块死白)
    await win.locator('.amx-web-live .embed-media-btn', { hasText: '冻结' }).first().click()
    await win.waitForTimeout(800)
    const refrozen = await win.locator('.amx-web webview').count()
    check('E2 冻结后 <webview> 真的摘掉(进程回收)', refrozen === 0, `webview=${refrozen}`)
    await win.locator('.amx-web-frozen .embed-media-btn', { hasText: '唤醒' }).first().click()
    await win.waitForTimeout(2000)
    const again = await win.locator('.amx-web-live webview').count()
    check('E2 再次唤醒仍挂得起来(重挂路径没坏)', again === 1, `webview=${again}`)

    // ── 编辑契约:光标进那一段 → 装饰让位露源码,活页随之下线(这是 D3 的代价,要能复原) ──
    await win.evaluate(() => {
      const p = [...document.querySelectorAll('.ProseMirror p')].find((e) => e.textContent.includes('example.com'))
      if (!p) return
      const r = document.createRange(); r.setStart(p.firstChild || p, 0); r.collapse(true)
      const s = getSelection(); s.removeAllRanges(); s.addRange(r)
      p.closest('.ProseMirror')?.dispatchEvent(new Event('focus'))
    })
    await win.waitForTimeout(900)

    if (process.env.SHOT) {
      const f = path.join(process.env.SHOT, 'media-embed-electron.png')
      await win.screenshot({ path: f })
      console.log(`  截图 → ${f}`)
    }
  } finally {
    await app.close().catch(() => {})
  }
  const bad = results.filter((r) => !r).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
