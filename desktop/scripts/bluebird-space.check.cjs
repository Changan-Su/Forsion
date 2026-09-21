/**
 * Bluebird bundle 的真 Space 契约:从磁盘发现插件内嵌 space.json，点 Ribbon 进入后
 * 必须得到三个独立的原生 Dockview 组(视频 / Amadeus / ChatView)，且插件进入
 * nativeWorkbench 模式，不再自绘文档和问答。
 *
 * 使用临时 TANGU_HOME + userData，不碰 ~/.forsion-dev 的数据与布局。
 * 需求:desktop out/main/main.js 已构建，且 dev renderer 在 http://localhost:5273。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const PLUGIN_SRC = process.env.BLUEBIRD_PLUGIN_SRC || path.join(ROOT, '..', '..', 'Forsion-Instrumentality-Project', 'bluebird')
const recipeVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, 'spaces/bluebird/space.json'), 'utf8')).version
const timestamps = process.argv.includes('--timestamps')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-bluebird-space-'))
const vault = path.join(home, 'vault')
const userData = path.join(home, 'userdata')
const shots = path.join(home, 'shots')
fs.mkdirSync(path.join(home, 'plugins'), { recursive: true })
fs.mkdirSync(vault, { recursive: true })
fs.mkdirSync(`${userData}-dev`, { recursive: true })
fs.mkdirSync(shots, { recursive: true })
fs.writeFileSync(path.join(vault, '欢迎.md'), '# Bluebird Space check\n')
const fixtureTitle = '设计学习：边看视频边整理笔记'
const fixtureFolder = '青鸟收藏夹'
const fixtureNote = `${fixtureFolder}/设计学习.md`
const timeCases = '旧时间码 [00:14]\n\n明确引用 [00:32](#bluebird=layout-fixture&t=32)\n\n本地引用 [00:05](#bluebird=local-fixture&t=5)\n\n旧在线引用 [00:18](https://www.bilibili.com/video/BV1xx411c7mD?t=18)\n\n'
const fixtureBody = `---\nbluebird_id: layout-fixture\n---\n\n# ${fixtureTitle}\n\n> 青鸟原生工作台布局验证\n\n${timestamps ? timeCases : ''}` + Array.from({ length: 12 }, (_, i) =>
  `## ${i + 1}. 阅读与对话\n\n视频固定在左上方，ChatView 在左下方。右侧 Amadeus 文档可以独立滚动，主区分屏与左右侧栏各自保持边界。\n\n- 整理关键内容\n- 记录问题和想法\n- 继续围绕当前笔记提问\n`).join('\n')
fs.mkdirSync(path.join(vault, fixtureFolder, '.bluebird'), { recursive: true })
fs.writeFileSync(path.join(vault, fixtureNote), fixtureBody)
fs.writeFileSync(path.join(vault, fixtureFolder, '.bluebird-index.json'), JSON.stringify({ folders: [], items: [
  { id: 'layout-fixture', title: fixtureTitle, platform: 'xiaohongshu', date: '2026-09-19' },
] }))
fs.writeFileSync(path.join(vault, fixtureFolder, '.bluebird/layout-fixture.json'), JSON.stringify({
  id: 'layout-fixture', kind: 'video', meta: { title: fixtureTitle, duration: 80 },
  sourceUrl: timestamps ? 'https://www.bilibili.com/video/BV1xx411c7mD' : 'https://www.xiaohongshu.com/explore/bluebird-layout-fixture',
  summaryMarkdown: fixtureBody, notePath: fixtureNote, segments: [],
}))
if (timestamps) {
  fs.mkdirSync(path.join(vault, fixtureFolder, 'assets'), { recursive: true })
  // Actual decodable media, offline and silent. Assert HTMLMediaElement.currentTime, not a mocked seek callback.
  const pcm = Buffer.alloc(44 + 8000 * 40 * 2)
  pcm.write('RIFF', 0); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8)
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22)
  pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34)
  pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40)
  fs.writeFileSync(path.join(vault, fixtureFolder, 'assets/timestamp.wav'), pcm)
  fs.writeFileSync(path.join(vault, fixtureFolder, '.bluebird/local-fixture.json'), JSON.stringify({
    id: 'local-fixture', kind: 'video', meta: { title: '本地存档定位', duration: 40 },
    sourceUrl: 'https://www.xiaohongshu.com/explore/local-fixture',
    summaryMarkdown: '![[timestamp.wav]]', notePath: `${fixtureFolder}/不应该被切换的文档.md`, segments: [],
  }))
}
fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

async function run() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('desktop out/main/main.js 不存在，先运行 npm run build')
  if (!fs.existsSync(path.join(PLUGIN_SRC, 'manifest.json'))) throw new Error(`找不到 Bluebird 插件源:${PLUGIN_SRC}`)
  fs.cpSync(PLUGIN_SRC, path.join(home, 'plugins', 'bluebird'), { recursive: true })

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      TANGU_HOME: home,
      TANGU_BACKEND_URL: 'http://127.0.0.1:1',
      ELECTRON_RENDERER_URL: process.env.BLUEBIRD_DEV_URL || 'http://localhost:5273',
    },
  })
  try {
    const win = await app.firstWindow()
    if (timestamps) await win.route('https://player.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Offline platform-player fixture</p>' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1560, 1000))
    const messages = []
    win.on('console', (msg) => messages.push(`${msg.type()}: ${msg.text()}`.slice(0, 800)))
    win.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`.slice(0, 800)))
    await win.waitForSelector('#root', { timeout: 30000 })
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.getByText(label, { exact: true }).first()
      if (await button.count().catch(() => 0)) { await button.click().catch(() => {}); break }
    }
    try {
      await win.waitForFunction(async () => {
        const engine = await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/index.ts')
        return engine.useSpaceStore.getState().spaces.some((space) => space.id === 'bluebird')
      }, null, { timeout: 20000 })
    } catch (error) {
      const diagnostic = await win.evaluate(async () => {
        const pluginStore = await import('/src/amadeus/plugins/pluginStore.ts').then((m) => {
          const s = m.usePluginStore.getState()
          return {
            initialized: s.initialized,
            plugins: s.plugins.map((p) => ({ id: p.id, blocked: p.blocked })),
            activeIds: s.activeIds,
            views: s.views.map((v) => `${v.pluginId}:${v.item.id}`),
            errors: s.lastSetupError,
          }
        }).catch((e) => ({ importError: String(e) }))
        const registeredViews = await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/viewRegistry.ts')
          .then((m) => m.allViews().map((v) => v.type))
          .catch((e) => [`importError:${String(e)}`])
        await import('/src/userSpaces.tsx').then((m) => m.loadUserSpaces()).catch((e) => {
          console.error('[bluebird-check] manual loadUserSpaces failed', e)
        })
        return {
          url: location.href,
          ribbon: [...document.querySelectorAll('.rb-space')].map((el) => el.getAttribute('title') || el.textContent),
          body: (document.body.textContent || '').slice(0, 1200),
          hasTangu: !!window.tangu,
          hasAmadeus: !!window.amadeus,
          spaces: (await window.tangu?.spacesList?.().catch((e) => [{ error: String(e) }]))?.map((s) => ({ slug: s.slug, plugin: s.plugin, json: s.json?.slice(0, 500) })),
          plugins: (await window.amadeus?.listPlugins?.().catch((e) => [{ error: String(e) }]))?.map((p) => ({ id: p.id, version: p.version, blocked: p.blocked })),
          pluginStore,
          registeredViews,
          registeredSpaces: await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/index.ts')
            .then((m) => m.useSpaceStore.getState().spaces.map((space) => space.id))
            .catch((e) => [`importError:${String(e)}`]),
          ribbonAfterManualLoad: [...document.querySelectorAll('.rb-space')].map((el) => el.getAttribute('title') || el.textContent),
        }
      })
      await win.screenshot({ path: path.join(shots, 'bluebird-space-timeout.png'), fullPage: true })
      console.error('Bluebird Space 未注册:', JSON.stringify({ ...diagnostic, messages: messages.slice(-40) }))
      throw error
    }
    await win.evaluate(async () => {
      const engine = await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/index.ts')
      engine.setActiveSpace('bluebird')
    })
    await win.waitForTimeout(1200)

    // Reproduce the reported upgrade shape: the previous run exited in Bluebird with a one-pane legacy
    // plugin view, while the recipe marker had already been stamped 2.0.0. Reloading must migrate both
    // the named slot and the current-layout blob after the plugin Space registers asynchronously.
    const seeded = await win.evaluate(async folder => {
      const engine = await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/index.ts')
      const workspace = engine.useWorkspace.getState()
      if (!workspace.api) return false
      workspace.api.clear()
      workspace.openView('plugin:bluebird:folder', {}, 'main', { newTab: true })
      workspace.saveCurrent()
      const versions = JSON.parse(localStorage.getItem('forsion_space_recipe_ver') || '{}')
      versions.bluebird = '2.0.0'
      localStorage.setItem('forsion_space_recipe_ver', JSON.stringify(versions))
      localStorage.setItem('forsion_default_space', '__last__')
      localStorage.setItem('forsion_tangu_active_space', 'bluebird')
      localStorage.setItem('plugin.bluebird.workFolder', folder)
      return true
    }, fixtureFolder)
    check('已构造 2.0.0 单栏旧布局', seeded)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForFunction(async expectedVersion => {
      const engine = await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/index.ts')
      const state = engine.useSpaceStore.getState()
      const workspace = engine.useWorkspace.getState()
      const recipe = JSON.parse(localStorage.getItem('forsion_space_recipe_ver') || '{}')
      const main = (workspace.api?.panels || []).filter((panel) => panel.params?.__loc === 'main')
      return state.activeSpaceId === 'bluebird' && recipe.bluebird === expectedVersion && main.length === 3
    }, recipeVersion, { timeout: 30000 })
    await win.waitForTimeout(1200)

    const state = await win.evaluate(async () => {
      const engine = await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/index.ts')
      const panels = (engine.useWorkspace.getState().api?.panels || []).map((panel) => ({
        id: panel.id,
        type: panel.params?.__type,
        loc: panel.params?.__loc,
        group: panel.group?.id,
        params: panel.params,
        rect: panel.group?.element.getBoundingClientRect().toJSON(),
      }))
      const main = panels.filter((panel) => panel.loc === 'main')
      const recipe = (() => { try { return JSON.parse(localStorage.getItem('forsion_space_recipe_ver') || '{}') } catch { return {} } })()
      return {
        active: localStorage.getItem('forsion_tangu_active_space'),
        recipe: recipe.bluebird,
        panels,
        main,
        legacyQa: document.body.textContent?.includes('AI 问答') ?? false,
      }
    })

    const mainViews = state.main.map((panel) => panel.type)
    check('活动 Space = bluebird', state.active === 'bluebird', `actual=${state.active}`)
    check('配方版本已迁移', state.recipe === recipeVersion, `actual=${state.recipe}`)
    check('视频 View 已打开', mainViews.includes('plugin:bluebird:folder'), JSON.stringify(state.main))
    check('Amadeus View 已打开', mainViews.includes('amadeus-editor'), JSON.stringify(state.main))
    check('ChatView 已打开', mainViews.includes('chat-panel'), JSON.stringify(state.main))
    check('三个主 View 分属三个 Dockview 组', new Set(state.main.map((panel) => panel.group)).size === 3, JSON.stringify(state.main))
    check('插件进入 nativeWorkbench 模式', state.main.some((panel) => panel.type === 'plugin:bluebird:folder' && panel.params?.nativeWorkbench === true), `legacyQa=${state.legacyQa}`)
    check('原生模式不再自绘 AI 问答', !state.legacyQa)
    const video = state.main.find(p => p.type === 'plugin:bluebird:folder')?.rect
    const doc = state.main.find(p => p.type === 'amadeus-editor')?.rect
    const chat = state.main.find(p => p.type === 'chat-panel')?.rect
    check('左上视频、左下 Chat、右侧文档通高', !!video && !!doc && !!chat
      && Math.abs(video.x - chat.x) < 3 && Math.abs(video.width - chat.width) < 3
      && chat.y >= video.bottom - 2 && doc.x >= video.right - 2
      && Math.abs(doc.y - video.y) < 3 && Math.abs(doc.bottom - chat.bottom) < 3,
      JSON.stringify({ video, doc, chat }))
    const index = await win.evaluate(async folder => JSON.parse(await window.amadeus.readTextFile(`${folder}/.bluebird-index.json`)), fixtureFolder)
    check('冷启动保留已有收藏索引', index.items.some(item => item.id === 'layout-fixture'))
    try { await win.getByText(fixtureTitle, { exact: true }).first().click({ timeout: 15000 }) }
    catch (error) {
      console.error('Fixture diagnostic', await win.evaluate(() => ({ body: document.body.innerText.slice(0, 2500),
        folder: localStorage.getItem('plugin.bluebird.workFolder') })), messages.slice(-15))
      await win.screenshot({ path: path.join(shots, 'fixture-missing.png'), fullPage: true })
      throw error
    }
    await win.getByText('1. 阅读与对话', { exact: true }).first().waitFor({ timeout: 15000 })
    check('收藏条目同步到右侧原生文档', true)
    await win.getByText('设计学习.md', { exact: true }).first().waitFor({ timeout: 10000 })
    check('ChatView 自动引用当前笔记', true)
    if (timestamps) {
      const stamp = await win.getByText('旧时间码 [00:14]', { exact: true }).evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let n
        while ((n = walker.nextNode())) {
          const at = n.textContent.indexOf('[00:14]')
          if (at < 0) continue
          const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + 7)
          const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
        }
      })
      await win.mouse.click(stamp.x, stamp.y)
      await win.waitForFunction(() => new URL(document.querySelector('.bb-native iframe').src).searchParams.get('t') === '14', null, { timeout: 3000 })
      check('旧笔记时间码跳转左侧视频', true)
      await win.locator('a[href="#bluebird=layout-fixture&t=32"]').click()
      await win.waitForFunction(() => new URL(document.querySelector('.bb-native iframe').src).searchParams.get('t') === '32')
      check('特殊时间引用定位指定条目', true)
      const local = win.locator('a[href="#bluebird=local-fixture&t=5"]')
      await local.click()
      await win.waitForFunction(() => {
        const player = document.querySelector('.bb-native audio')
        return player && player.currentTime >= 5 && player.currentTime < 8
      })
      check('跨条目引用使用存档媒体并准确定位', true)
      const media = await win.locator('.bb-native audio').elementHandle()
      await media.evaluate(el => { el.pause(); el.currentTime = 20 })
      await local.click()
      await win.waitForFunction(() => document.querySelector('.bb-native audio')?.currentTime < 8)
      check('重复时间引用不重建播放器', await media.evaluate(el => el === document.querySelector('.bb-native audio') && el.currentTime >= 5))
      check('跳转另一条视频不替换来源文档和 Chat 引用', await win.getByText('1. 阅读与对话', { exact: true }).count() > 0
        && await win.getByText('设计学习.md', { exact: true }).count() > 0)
      await win.locator('a[href="https://www.bilibili.com/video/BV1xx411c7mD?t=18"]').click()
      await win.waitForFunction(() => new URL(document.querySelector('.bb-native iframe').src).searchParams.get('t') === '18')
      check('旧在线时间链接回到原视频,不打开网页', true)
      await win.locator('[data-bluebird-time="14"]').click()
      await win.waitForFunction(() => new URL(document.querySelector('.bb-native iframe').src).searchParams.get('t') === '14')
      check('旧时间码继续绑定原文档', true)
      check('兼容已有时间码不修改笔记', fs.readFileSync(path.join(vault, fixtureNote), 'utf8') === fixtureBody)
    }
    await win.waitForTimeout(500)
    await win.screenshot({ path: path.join(shots, 'bluebird-space.png'), fullPage: true })
    const independent = await win.evaluate(async () => {
      const engine = await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/index.ts')
      const doc = engine.useWorkspace.getState().api.panels.find(p => p.params.__type === 'amadeus-editor')
      const scroller = [...doc.group.element.querySelectorAll('*')].find(el => el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY))
      const media = document.querySelector('.bb-native .bb-media')
      if (!scroller || !media) return false
      const before = media.getBoundingClientRect().toJSON()
      scroller.scrollTop = 300
      await new Promise(r => requestAnimationFrame(r))
      const after = media.getBoundingClientRect().toJSON()
      return scroller.scrollTop > 0 && before.x === after.x && before.y === after.y && before.height === after.height
    })
    check('滚动长文档不移动视频区域', independent)
    if (timestamps) {
      await win.evaluate(async () => {
        const engine = await import('/@fs/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/lcl/engine/index.ts')
        const api = engine.useWorkspace.getState().api
        const panel = api.panels.find(p => p.params.__type === 'plugin:bluebird:folder')
        api.removePanel(panel)
      })
      await win.locator('.bb-native').waitFor({ state: 'detached' })
      await win.locator('a[href="#bluebird=local-fixture&t=5"]').click()
      await win.waitForFunction(() => {
        const player = document.querySelector('.bb-media audio')
        return player && player.currentTime >= 5 && player.currentTime < 8
      })
      check('关闭视频面板后点击引用可重新打开并定位', true)
    }
    console.log(`截图:${path.join(shots, 'bluebird-space.png')}`)
  } finally {
    await app.close().catch(() => {})
  }
}

run().then(() => process.exit(failures ? 1 : 0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
