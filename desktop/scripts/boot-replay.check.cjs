/**
 * check:boot —— P0-a 的主进程侧仪器(preload 是主进程侧产物,HMR 不生效,vitest 也碰不到):
 *   B1 preload 的 onBackendStatus **注册即回放**当前状态:external 模式(不 spawn 引擎)下新订阅者 3s 内收到 'stopped';
 *   B2 退订后不回放(off 守卫):注册后立刻 off,3s 内不得收到任何状态;
 *   B3 全程无 pageerror。
 * 真 Electron(需先 `npm run build`),临时 userData/家目录,不碰 ~/.forsion-dev。
 * 负对照:`--nc=noreplay` 把 out/preload/preload.mjs 里的回放 invoke 临时改坏(备份 → 跑 → 恢复),期望 B1 变红。
 * 用法:npm run check:boot [-- --nc=noreplay]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const PRELOAD = path.join(ROOT, 'out', 'preload', 'preload.mjs')
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js')) || !fs.existsSync(PRELOAD)) throw new Error('缺 out/ 产物 —— 先跑 npm run build')
  let preloadBackup = null
  if (NC === 'noreplay') {
    const src = fs.readFileSync(PRELOAD, 'utf8')
    // ⚠️ 产物里 backend:getStatus 有两处:backendStatus() 方法 + onBackendStatus 里的回放;只有回放那句紧跟 `.then(`。
    //    改坏的是回放:让它永不 resolve(首版用不带 .then 的 marker 改到了 backendStatus(),负对照假绿 —— 2026-09-02)
    const marker = 'invoke("backend:getStatus").then('
    if (src.split(marker).length !== 2) throw new Error(`[nc=noreplay] 产物里 ${marker} 应恰好一处,实际 ${src.split(marker).length - 1} 处,负对照失效(产物过旧?先 npm run build)`)
    preloadBackup = src
    fs.writeFileSync(PRELOAD, src.replace(marker, 'invoke("backend:getStatus").then(() => new Promise(() => {})).then('))
    console.log('⚠️ 负对照 --nc=noreplay:回放已改坏,期望 B1 变红\n')
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-boot-'))
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  // external 模式(也是 DEFAULT_CONFIG):不 spawn 引擎,backendStatus 恒 stopped —— 回放收到的就是它
  fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: 'http://127.0.0.1:1', token: 'x' }, null, 2))
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home } })
  const errors = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => errors.push(e.message))
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(1500)
    const subscribe = (offImmediately) => win.evaluate((offNow) => new Promise((resolve) => {
      const timer = setTimeout(() => { off(); resolve('none') }, 3000)
      const off = window.tangu.onBackendStatus((s) => { clearTimeout(timer); off(); resolve(s.state) })
      if (offNow) off()
    }), offImmediately).catch((e) => `error:${e.message}`)
    const b1 = await subscribe(false)
    check('B1 onBackendStatus 注册即回放:external 模式新订阅者 3s 内收到 stopped', b1 === 'stopped', `got=${b1}`)
    const b2 = await subscribe(true)
    check('B2 注册后立刻退订 → 不回放', b2 === 'none', `got=${b2}`)
    check('B3 无 pageerror', errors.length === 0, errors.slice(0, 3).join(' | '))
  } catch (e) {
    check('跑完', false, String(e))
  } finally {
    await app.close().catch(() => {})
    if (preloadBackup !== null) { fs.writeFileSync(PRELOAD, preloadBackup); console.log('(已恢复 out/preload/preload.mjs)') }
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
