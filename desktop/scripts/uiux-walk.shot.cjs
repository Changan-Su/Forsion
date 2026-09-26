/**
 * UI/UX 走查截图机(真 Electron + 桩引擎):把菜单 / 浮层、各 Space 主区、Agents 详情标签、设置各子页
 * 在「明暗 × 中英 × 宽窄」组合下各拍一张,交给人或模型逐张看。正典:docs/ToBeImproved/UIUX评审_2026-09-25.md §4 / §7。
 *
 * 不断言观感(那是看图的事),只断言「组合真的生效了」:<html data-mode> 与期望明暗一致、界面语言确实切了
 * (英文组合下 zh 字样的「新会话」不许出现)—— 否则整组截图都是假的,直接退出。
 * 唯一的原生菜单是托盘菜单(electron/tray.ts),页面截图拍不到,不在清单里。
 *
 * 跑法:npx electron-vite build && npm run shot:walk
 * 旋钮:SHOT_DIR(缺省系统临时目录)/ WALK_COMBOS=light-zh,dark-en(只跑这些组合)/ WALK_ONLY=menu,space,agent,settings
 *       (只拍这几类)/ WALK_MATCH=子串(逗号分隔,只拍 id 含其一的目标)/ WALK_VERBOSE=1(逐个目标打印)
 */
const fs = require('fs')
const path = require('path')
const { sleep, shotDir, launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

const COMBOS = [
  { id: 'light-zh', mode: 'light', lang: 'zh', w: 1440 },
  { id: 'light-en', mode: 'light', lang: 'en', w: 1440, settings: true },
  { id: 'dark-zh', mode: 'dark', lang: 'zh', w: 1440, settings: true },
  { id: 'dark-en', mode: 'dark', lang: 'en', w: 1440 },
  { id: 'light-en-860', mode: 'light', lang: 'en', w: 860 },
].filter((c) => !process.env.WALK_COMBOS || process.env.WALK_COMBOS.split(',').includes(c.id))
const ONLY = process.env.WALK_ONLY ? process.env.WALK_ONLY.split(',') : null
const MATCH = process.env.WALK_MATCH ? process.env.WALK_MATCH.split(',') : null
const want = (kind, id) => (!ONLY || ONLY.includes(kind)) && (!MATCH || MATCH.some((m) => id.includes(m)))

const rightClick = (sel) => async (win) => win.locator(sel).first().click({ button: 'right' })
const click = (sel, nth = 0) => async (win) => win.locator(sel).nth(nth).click()
/** 在 Tangu Space 里打开的菜单 / 浮层。选择器一律结构性的(英文组合下 aria-label 会变)。 */
const MENUS = [
  ['composer-mode', click('.t2c-pill.mode-pill-btn')],
  ['composer-model', click('.model-pill-btn')],
  ['composer-add', click('.add-pill-btn')],
  ['composer-ctxring', click('.t2c-ctxring-btn')],
  ['composer-slash', async (win) => { await win.locator('textarea').last().click(); await win.keyboard.type('/') }],
  ['side-switcher', click('.t2sw-mode-trigger')],
  ['side-plus', click('.t2o-plus')],
  ['side-session-ctx', rightClick('.t2s-srow:not(.t2s-archived-toggle)')],
  ['side-agent-more', async (win) => { await win.locator('.t2o-row').first().hover(); await win.locator('.t2o-row .t2o-tail').first().click() }],
  ['side-agent-ctx', rightClick('.t2o-row')],
  ['side-workspace-ops', click('.t2s-group-add')],
  ['tab-ctx', rightClick('.dv-tab .wb-tab:not(.wb-tab--icon)')],
  ['ribbon-new-space', click('.rb-plus', 0)],
  ['ribbon-add-cmd', click('.rb-plus', 1)],
  ['ribbon-space-ctx', rightClick('.rb-slot[data-id="space:inbox"] .rb-space')],
  ['ribbon-cmd-ctx', rightClick('.rb-slot[data-id="rb-market"] .rb-btn')],
  ['ribbon-unit', click('.unitsw-pill')],
  ['ribbon-account', click('.ribbon-account')],
  ['cmd-palette', async (win) => win.keyboard.press('Meta+K')],
  ['statusbar-space', click('.sb-click', 0)],
  ['statusbar-ctx', rightClick('.sb')],
]
const SPACES = ['tangu', 'agents', 'inbox', 'amadeus', 'calendar', 'coding', 'artificial', 'image-studio', 'automation', 'muse', 'public', 'homepage']
const SETTINGS = [
  'general/g-basic', 'general/g-conn', 'general/g-runtime', 'general/g-forsion', 'general/g-inbox',
  'model/m-models', 'model/m-display', 'model/m-providers', 'model/m-voice',
  'mcp', 'hooks', 'skills/k-library', 'skills/k-discovery', 'agents/ag-roster', 'agents/ag-special', 'agents/ag-clis',
  'amadeus-plugins/pl-forsion', 'amadeus-plugins/pl-engine', 'browser', 'channels', 'notes', 'sync/s-cloud', 'sync/s-remote',
  'spaces', 'theme', 'shortcuts', 'notifications', 'statusbar', 'permissions',
  'advanced/a-mcp', 'advanced/a-ui', 'advanced/a-experimental', 'advanced/a-data', 'developer', 'about',
]

/** 截某个窗口:floating=true 取浮窗(设置),否则取主窗。capturePage 不受窗口是否在前台影响。 */
async function capture(app, file, floating = false) {
  const b64 = await app.evaluate(async ({ BrowserWindow }, fl) => {
    // 浮窗可能被重建过(旧的还没销毁):取最新的那个
    const w = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed() && x.webContents.getURL().includes('window=floating') === fl).sort((a, b) => b.id - a.id)[0]
    return w ? (await w.capturePage()).toPNG().toString('base64') : null
  }, floating)
  if (!b64) throw new Error('窗口不在')
  fs.writeFileSync(file, Buffer.from(b64, 'base64'))
}

async function dismiss(win) {
  for (let i = 0; i < 2; i++) { await win.keyboard.press('Escape').catch(() => {}); await sleep(120) }
  await win.locator('textarea').last().fill('').catch(() => {}) // composer-slash 敲进去的「/」
  await win.mouse.click(5, 5).catch(() => {}) // 拖窗区之外的角:点掉失焦才收的浮层
  await sleep(150)
}

async function applyCombo(win, c) {
  await win.evaluate(([lang, mode]) => {
    localStorage.setItem('tangu_locale', lang)
    localStorage.setItem('forsion_theme_pref', mode)
  }, [c.lang, c.mode])
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await sleep(2500)
  const got = await win.evaluate(() => ({ mode: document.documentElement.dataset.mode, text: document.body.innerText }))
  const zhLeft = /新会话|会话|已归档/.test(got.text)
  if (got.mode !== c.mode) throw new Error(`${c.id}: 明暗没生效(data-mode=${got.mode})`)
  if (c.lang === 'en' && zhLeft) throw new Error(`${c.id}: 语言没切到英文(界面仍有「新会话 / 会话 / 已归档」)`)
  if (c.lang === 'zh' && !zhLeft) throw new Error(`${c.id}: 语言不是中文`)
}

async function main() {
  const dir = shotDir('uiux-walk')
  const done = []
  const skipped = []
  for (const c of COMBOS) {
    const { app, win, close } = await launch({ tag: `walk-${c.id}` })
    const shot = async (kind, id, fn, floating = false) => {
      if (!want(kind, id)) return
      if (process.env.WALK_VERBOSE) console.log(`  → ${kind}-${id}`)
      const file = path.join(dir, `${c.id}__${kind}-${id.replace(/\//g, '_')}.png`)
      try {
        // 每个目标限时:某页挂住(一次 IPC 永不回来)不能拖死后面整组
        await Promise.race([
          (async () => { await fn(); await sleep(450); await capture(app, file, floating) })(),
          sleep(30_000).then(() => { throw new Error('超时 30s') }),
        ])
        done.push(file)
      } catch (e) {
        skipped.push(`${c.id} ${kind}-${id}: ${String(e.message || e).split('\n')[0].slice(0, 160)}`)
      }
    }
    try {
      await boot(app, win, { space: 'tangu', width: c.w, height: 900 })
      await applyCombo(win, c)
      console.log(`== ${c.id}`)
      for (const [id, open] of MENUS) {
        await shot('menu', id, async () => { await enterSpace(win, 'tangu'); await dismiss(win); await open(win) })
        await dismiss(win)
      }
      for (const id of SPACES) {
        await shot('space', id, async () => {
          const ok = id === 'homepage'
            ? await win.locator('.rb-home .rb-space').first().click().then(() => true)
            : await enterSpace(win, id)
          if (!ok) throw new Error('没切进去')
          await sleep(1500)
        })
      }
      if (await enterSpace(win, 'agents')) {
        const tabs = await win.locator('[role=tab]:not(.dv-tab)').count()
        for (let i = 0; i < tabs; i++) {
          await shot('agent', `tab${i}`, async () => { await win.locator('[role=tab]:not(.dv-tab)').nth(i).click(); await sleep(600) })
        }
      }
      if (c.settings) {
        for (const target of SETTINGS) {
          await shot('settings', target, async () => {
            await win.evaluate(([n, t]) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: t, n } }), [Date.now(), target])
            // 浮窗可能被重建:任一还活着的浮窗里出现 .settings-page 即可
            let ok = false
            for (let i = 0; i < 80 && !ok; i++) {
              for (const w of app.windows().filter((x) => !x.isClosed() && x.url().includes('window=floating'))) {
                if (await w.locator('.settings-page').count().catch(() => 0)) { ok = true; break }
              }
              if (!ok) await sleep(250)
            }
            if (!ok) throw new Error('设置浮窗没出来')
            await sleep(900)
          }, true)
        }
      }
    } catch (e) {
      console.error(`组合 ${c.id} 中止:`, e.message || e)
      process.exitCode = 1
    } finally {
      await close()
    }
  }
  console.log(`\n截了 ${done.length} 张 → ${dir}`)
  if (skipped.length) console.log(`跳过 ${skipped.length} 个:\n  ${skipped.join('\n  ')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
