/**
 * 内置浏览器 / 内置终端 / HTML 预览宿主的**真 Electron** 契约检查
 * (纯函数单测覆盖不到的边界;共用一次 Electron 启动):
 *  ① 窗口 webPreferences.webviewTag = true —— 关掉的话 <webview> 静默变成空元素,整个内置浏览器白屏;
 *  ② will-attach-webview 硬化 —— 渲染层就算给 <webview> 写上 preload / nodeintegration,
 *     主进程也必须剥掉(否则等于把 window.tangu 的 PTY / 文件读写送给任意第三方站点);
 *  ③ PTY 往返 —— spawn → write → onData 能收到自己 echo 的字节(node-pty 原生模块 + spawn-helper
 *     执行位一起验;spawn-helper 少了执行位就是 posix_spawnp failed);
 *  ④ HTML 预览宿主 —— 预览页必须落在**真实 http 源**上,且能 `fetch('./sibling')`。
 *     退回 srcdoc 就会继承宿主 CSP + 不透明源 → three.js 那类页面直接空白(这条钉的就是那个回归)。
 *
 * 跑:node scripts/builtins.check.cjs   (先 npm run build;用隔离的 TANGU_HOME,不碰真实数据)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-builtins-'))
  let app
  try {
    app = await electron.launch({
      // ⚠️必须给独立 userData:与开发者自己的 dev 实例共用目录时,Chromium 的进程单例
      // (SingletonLock/Socket)会让本次启动**卡死在 requestSingleInstanceLock**——没有窗口、
      // 没有日志、evaluate 也不回,极难诊断。main.ts 会再补一个 `-dev` 后缀,无所谓。
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        TANGU_HOME: home,                       // 隔离数据目录,不碰 ~/.forsion
        TANGU_BACKEND_URL: 'http://127.0.0.1:1', // external 模式 → 不 spawn 托管后端
        ELECTRON_ENABLE_LOGGING: '1',
      },
    })
  } catch (e) {
    // 单实例锁:已有 dev 版 Electron 在跑时,新实例 requestSingleInstanceLock 失败 → 静默 exit(0),
    // playwright 只会说「进程没了」。先说清楚,别让人去查代码。
    console.error('启动失败。若已有 dev 版 Electron 在跑,先 pkill -f "node_modules/electron/dist/Electron.app"(单实例锁)。')
    throw e
  }
  // CHECK_VERBOSE=1:把 App 主进程的 stdout/stderr 接出来(启动卡在哪一步只有它说得清)。
  if (process.env.CHECK_VERBOSE) {
    app.process().stdout?.on('data', (b) => process.stdout.write('[app] ' + b))
    app.process().stderr?.on('data', (b) => process.stdout.write('[app!] ' + b))
  }
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30_000 })

  // ① 主窗开了 webviewTag
  const wvTag = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return !!w && w.webContents.getLastWebPreferences()?.webviewTag === true
  })
  check('主窗 webPreferences.webviewTag = true', wvTag)

  // ② 渲染层把能想到的危险属性全写上(preload / nodeintegration / 空 partition /
  //    disablewebsecurity / webpreferences=sandbox=no…)→ 主进程必须逐条覆写成安全值
  await win.evaluate(() => {
    const wv = document.createElement('webview')
    wv.setAttribute('src', 'about:blank')
    wv.setAttribute('partition', '') // 空 partition = 想落回权限全放行的 defaultSession
    wv.setAttribute('preload', 'file:///tmp/evil.js')
    wv.setAttribute('nodeintegration', 'true')
    wv.setAttribute('nodeintegrationinsubframes', 'true')
    wv.setAttribute('disablewebsecurity', 'true')
    wv.setAttribute('webpreferences', 'sandbox=no,contextIsolation=no,allowRunningInsecureContent=yes,nodeIntegrationInWorker=yes')
    wv.id = '__check_wv'
    wv.style.cssText = 'width:200px;height:120px'
    document.body.appendChild(wv)
  })
  const guest = await (async () => {
    for (let i = 0; i < 40; i++) {
      const r = await app.evaluate(({ webContents, session }) => {
        const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview')
        if (!g) return null
        const p = g.getLastWebPreferences() || {}
        return {
          preload: p.preload || null,
          nodeIntegration: !!p.nodeIntegration,
          nodeIntegrationInWorker: !!p.nodeIntegrationInWorker,
          contextIsolation: p.contextIsolation !== false,
          sandbox: p.sandbox !== false,
          webSecurity: p.webSecurity !== false,
          allowRunningInsecureContent: !!p.allowRunningInsecureContent,
          // partition 不一定回显在 webPreferences 上 —— 直接比 session 实例(真正决定 cookie
          // 与权限策略的是它),顺带确认没落回 defaultSession(那条是权限全放行的)。
          browserSession: g.session === session.fromPartition('persist:forsion-browser'),
          defaultSession: g.session === session.defaultSession,
        }
      })
      if (r) return r
      await new Promise((res) => setTimeout(res, 250))
    }
    return null
  })()
  check('<webview> 已附着(拿得到 guest webContents)', !!guest)
  check('guest 的 preload 被剥掉', !!guest && guest.preload === null, guest ? String(guest.preload) : '')
  check('guest 的 nodeIntegration = false', !!guest && guest.nodeIntegration === false)
  check('guest 的 nodeIntegrationInWorker = false', !!guest && guest.nodeIntegrationInWorker === false)
  check('guest 的 contextIsolation 保持开启', !!guest && guest.contextIsolation === true)
  check('guest 被强制 sandbox', !!guest && guest.sandbox === true)
  check('disablewebsecurity 无效(webSecurity 仍开)', !!guest && guest.webSecurity === true)
  check('allowRunningInsecureContent = false', !!guest && guest.allowRunningInsecureContent === false)
  check('空 partition 被改写回内置浏览器专用会话', !!guest && guest.browserSession === true)
  check('guest 没落回权限全放行的 defaultSession', !!guest && guest.defaultSession === false)

  // ③ PTY 往返:写一行 echo,应在 onData 里收到带标记的输出
  const pty = await win.evaluate(async () => {
    const api = window.tangu && window.tangu.pty
    if (!api) return { error: 'window.tangu.pty 未暴露' }
    const r = await api.spawn({ cols: 80, rows: 24 })
    if (!r || !r.id) return { error: r && r.error ? r.error : 'spawn 无 id' }
    let out = ''
    const off = api.onData(r.id, (d) => { out += d })
    api.write(r.id, 'echo FORSION_PTY_OK\n')
    const ok = await new Promise((res) => {
      const t0 = Date.now()
      const tick = () => {
        if (out.includes('FORSION_PTY_OK')) return res(true)
        if (Date.now() - t0 > 8000) return res(false)
        setTimeout(tick, 100)
      }
      tick()
    })
    off()
    api.kill(r.id)
    return { ok, tail: out.slice(-160) }
  })
  check('PTY spawn → write → onData 往返', !!pty && pty.ok === true, pty && (pty.error || pty.tail))

  // ③.5 <webview> 换掉 <iframe> 后不能塌:两处预览宿体的 class 在 flex 容器里都得撑满
  //     (webview 的 UA 默认 display 与 iframe 不同,漏了 display:flex 就是一片空白)
  const sizes = await win.evaluate((classes) => {
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:-9999px;top:0;width:600px;height:400px;display:flex;flex-direction:column'
    document.body.appendChild(box)
    const out = {}
    for (const c of classes) {
      const w = document.createElement('webview')
      w.className = c
      w.style.display = 'flex'
      w.src = 'about:blank'
      box.appendChild(w)
      const r = w.getBoundingClientRect()
      out[c] = [Math.round(r.width), Math.round(r.height)]
      w.remove()
    }
    box.remove()
    return out
  }, ['wsfile-frame', 'csx-frame'])
  for (const [c, [w, h]] of Object.entries(sizes)) {
    check(`.${c} 的 <webview> 撑满 600×400 容器`, w === 600 && h === 400, `${w}×${h}`)
  }

  // ④ HTML 预览宿主:同目录写一个 html + 一个兄弟资源,断言预览页跑在 http 源上且 fetch 得到兄弟文件
  const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-preview-'))
  fs.writeFileSync(path.join(previewDir, 'asset.json'), '{"ok":true}')
  // 页面**自己**验完再把结论写进 document.title —— webview 是独立顶层文档,parent.postMessage
  // 到不了宿主,只能靠主进程 getTitle() 读回来。内联 <script> 能跑本身也证明没继承宿主 CSP。
  fs.writeFileSync(path.join(previewDir, 'scene page.html'), [
    '<!doctype html><meta charset=utf-8><title>pending</title><script>',
    '(async () => {',
    '  const r = { top: window.top === window, secure: window.isSecureContext };',
    '  try { const j = await fetch("./asset.json").then(x => x.json()); r.fetched = !!(j && j.ok) }',
    '  catch (e) { r.fetched = false; r.err = String(e && e.message || e) }',
    // 无手势必抛;要看的是抛哪一种:跨源子框架 = 硬禁(iframe 宿体的病),缺手势 = 真人点就能用
    '  try { await window.showOpenFilePicker(); r.picker = "opened" }',
    '  catch (e) { r.picker = /Cross origin sub frames/i.test(String(e.message)) ? "cross-origin-blocked" : "needs-gesture" }',
    '  document.title = "RES" + JSON.stringify(r);',
    // 指针锁必须有真实手势 —— 主进程 sendInputEvent 打一次真点击进来触发这个 handler。
    // 挂 window 不挂 body:这页 body 高度为 0,点在 (40,40) 命中的是 <html>,冒泡到不了 body。
    '  window.addEventListener("click", async () => {',
    '    let v; try { await document.documentElement.requestPointerLock(); v = "locked" } catch (e) { v = String(e && e.message || e) }',
    '    document.title = "PLK" + JSON.stringify({ v });',
    '  });',
    '})();',
    '</scr' + 'ipt>',
  ].join('\n'))
  const prev = await win.evaluate(async (dir) => {
    const serve = window.tangu && window.tangu.codePreviewServePath
    if (!serve) return { error: 'codePreviewServePath 未暴露' }
    const r = await serve(dir + '/scene page.html')
    return { url: r && r.url }
  }, previewDir)
  const url = prev && prev.url
  check('预览 URL 是每令牌独立源的本地 http(不是 file:/srcdoc)', typeof url === 'string' && /^http:\/\/[0-9a-f]{32}\.localhost:\d+\//.test(url), prev && (prev.error || url))
  if (typeof url === 'string') {
    // 用**与 HtmlPreview 同款的 <webview>** 加载(不是 iframe):预览必须是顶层文档,
    // 否则 Chromium 对跨源子框架硬禁 file picker,页面的「导入文件」整类功能全废。
    await win.evaluate((u) => {
      const w = document.createElement('webview')
      w.id = '__check_prev'
      w.style.cssText = 'position:fixed;left:-9999px;width:300px;height:200px'
      w.setAttribute('partition', 'persist:forsion-browser')
      w.src = u
      document.body.appendChild(w)
    }, url)
    let res = null
    for (let i = 0; i < 40 && !res; i++) {
      const t = await app.evaluate(({ webContents }) => {
        const g = webContents.getAllWebContents().filter((c) => c.getType() === 'webview').map((c) => c.getTitle()).find((x) => x && x.startsWith('RES'))
        return g || null
      })
      if (t) { try { res = JSON.parse(t.slice(3)) } catch { res = { parseError: t } } }
      else await new Promise((r) => setTimeout(r, 250))
    }
    check('预览页是顶层文档(跨源子框架会被硬禁 file picker)', !!res && res.top === true, res && JSON.stringify(res))
    check('预览页内 fetch 同目录资源成功(三维模型/贴图靠这条)', !!res && res.fetched === true, res && (res.err || ''))
    check('file picker 未被「跨源子框架」拦死(真人点击即可用)', !!res && res.picker !== 'cross-origin-blocked', res && res.picker)
    // 指针锁:3D/FPS 类项目的命门。iframe sandbox 少 allow-pointer-lock 会硬禁;分区权限 handler
    // 无差别 callback(false) 也会拒。打一次真实点击(sendInputEvent 带手势)看它到底锁不锁得上。
    let plk = null
    if (res && res.top === true) {
      await app.evaluate(({ webContents }, u) => {
        const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(new URL(u).origin))
        if (!g) return
        g.focus() // 指针锁要求文档处于聚焦态,离屏的 guest 默认没焦点
        for (const type of ['mouseDown', 'mouseUp']) g.sendInputEvent({ type, x: 40, y: 40, button: 'left', clickCount: 1 })
      }, url)
      for (let i = 0; i < 40 && !plk; i++) {
        const t = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((c) => c.getTitle()).find((x) => x && x.startsWith('PLK')) || null)
        if (t) { try { plk = JSON.parse(t.slice(3)) } catch { plk = { v: t } } }
        else await new Promise((r) => setTimeout(r, 250))
      }
    }
    check('预览页可 requestPointerLock(FPS/3D 项目命门)', !!plk && plk.v === 'locked', plk && plk.v)
    await win.evaluate(() => { const e = document.getElementById('__check_prev'); if (e) e.remove() })
    // 不带令牌主机名(裸 127.0.0.1:port)什么都拿不到
    const bare = await win.evaluate((u) => {
      const p = new URL(u).port
      return fetch(`http://127.0.0.1:${p}/`).then((r) => r.status).catch(() => 'blocked')
    }, url)
    check('裸 127.0.0.1:port(无令牌主机名)不吐内容', bare === 404 || bare === 'blocked', String(bare))
    // 无本机路径的 HTML(云沙箱/对话内联)同样要拿到真实源 —— 退回 srcdoc 就继承宿主 CSP + 不透明源
    const inline = await win.evaluate(async () => {
      const serve = window.tangu && window.tangu.codePreviewServeHtml
      if (!serve) return { error: 'codePreviewServeHtml 未暴露' }
      const a = await serve('<!doctype html><title>INLINE_OK</title>')
      const b = await serve('<!doctype html><title>INLINE_OK</title>') // 同内容应复用同一 token,不无限发放
      // ⚠️别从宿主 fetch:令牌源与宿主跨源,且 main 只给 127.0.0.1/localhost 补 ACAO,子域名不在内。
      // 用真实宿体(webview)加载,靠标题回报——和 HtmlPreview 的实际路径一致。
      const w = document.createElement('webview')
      w.id = '__check_inline'
      w.style.cssText = 'position:fixed;left:-9999px;width:200px;height:120px;display:flex'
      w.setAttribute('partition', 'persist:forsion-browser')
      w.src = a.url
      document.body.appendChild(w)
      return { url: a.url, same: a.url === b.url }
    })
    check('无路径 HTML 也落在令牌源上(不退回 srcdoc)', !!inline && /^http:\/\/[0-9a-f]{32}\.localhost:\d+\/index\.html$/.test(inline.url || ''), inline && (inline.error || inline.url))
    let inlineTitle = null
    for (let i = 0; i < 40 && !inlineTitle; i++) {
      inlineTitle = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((c) => c.getTitle()).find((x) => x === 'INLINE_OK') || null)
      if (!inlineTitle) await new Promise((r) => setTimeout(r, 250))
    }
    check('内联预览真的加载得出来且同内容复用同一令牌', inlineTitle === 'INLINE_OK' && !!inline && inline.same === true, `title=${inlineTitle} same=${inline && inline.same}`)
    await win.evaluate(() => { const e = document.getElementById('__check_inline'); if (e) e.remove() })

    // 两个不同目录 → 两个不同源(否则两个预览之间可经 parent.frames[i] 互读 DOM / 共享 localStorage)
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-preview2-'))
    fs.writeFileSync(path.join(other, 'a.html'), '<!doctype html>b')
    const url2 = await win.evaluate((d) => window.tangu.codePreviewServePath(d + '/a.html').then((r) => r.url), other)
    check('不同预览目录 = 不同源(互相隔离)', new URL(url).origin !== new URL(url2).origin, `${new URL(url).host} vs ${new URL(url2).host}`)
    fs.rmSync(other, { recursive: true, force: true })
  }
  fs.rmSync(previewDir, { recursive: true, force: true })

  await app.close()
  fs.rmSync(home, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
