// 捆绑包模板的 UI 部分。裸 setup 体(不得有顶层 import/export;宿主 new Function('ctx', src) 求值)。
// 注意:UI 部分是**可省的**——纯捆绑包(只发引擎插件/Agent/Space,无桌面 UI)不写 main.js 也合法,
// 宿主按 no-op 处理。bundle 的其余内容不经此文件:宿主按子目录标志文件自动识别
// (tangu-plugins/*/tangu-plugin.json、agents/*/config.toml、spaces/*/space.json)。
const isZh = () => (ctx.getLocale?.() ?? 'zh') !== 'en'

// 前置条件示范(manifest onboarding.requires 的 setting 类,2026-09-21 起):「打个招呼」得知道怎么称呼你,
// 不填就不工作 —— 只有这种东西才该写进 requires(用法说明留给 steps / README)。
// 宿主判据:localStorage `plugin.sample-bundle.nickname` trim 后非空,**且 ≠ 下面声明的 default**。
// 所以 default 留空串:写成「朋友」之类的占位,用户就是想叫「朋友」也永远过不了闸;写成一个能用的真默认值,
// 则说明这项本来就不是「不填就不工作」,压根不该进 requires。
// key 必须在这里注册过:宿主拿不到定义就只能判「暂时无法检查」。检查卡会把这个输入框就地嵌在那一行里。
ctx.registerSetting({
  key: 'nickname',
  label: isZh() ? '称呼' : 'Your name',
  type: 'text',
  default: '',
  description: isZh() ? '「打个招呼」用它称呼你;不填这条命令不工作。' : "Say hello greets you by this name. It won't run until you fill it in.",
})
const nickname = () => {
  try { return typeof localStorage === 'undefined' ? '' : (localStorage.getItem('plugin.sample-bundle.nickname') ?? '').trim() }
  catch { return '' }
}

// 命令 id 必须带包前缀:命令面板按裸 id 做 React key,跨插件撞 id 会互相顶掉。
ctx.registerCommand({
  id: 'sample-bundle-hello',
  title: isZh() ? '示例捆绑包:打个招呼' : 'Sample bundle: say hello',
  run: async () => {
    const zh = isZh()
    // 兼容纪律:ctx.notify 是较新的可选能力,旧宿主(API v1 早期)没有 → 回退 ctx.app.notify
    const say = (msg) => {
      if (ctx.notify) ctx.notify(msg, { title: zh ? '示例捆绑包' : 'Sample bundle' })
      else ctx.app.notify(msg)
    }
    const name = nickname()
    // 前置条件没满足:说清缺什么、去哪填,然后停。宿主的检查卡 / 「待引导」徽标指向的是同一个设置项。
    if (!name) {
      say(zh ? '先在本插件的设置里填上「称呼」。' : 'Fill in "Your name" in this plugin\'s settings first.')
      return
    }
    say(zh
      ? `${name},内嵌的引擎工具 sample_bundle_echo、Agent「示例捆绑助手」与 Space 都已随包就位。`
      : `Hi ${name}. The bundled engine tool sample_bundle_echo, the bundled sample assistant and the Space are all in place.`)
    // Output follows the host's working-folder setting: new default Plugins/<effective plugin ID>,
    // with manual preferences and legacy-folder compatibility preserved. Never derive it from the display name.
    // Hosts without workFolder (or app) skip this example.
    if (ctx.app && ctx.app.workFolder && ctx.app.writeFile) {
      const p = `${ctx.app.workFolder()}/你好.md`
      await ctx.app.writeFile(p, `# 你好,${name}\n\n由「示例捆绑包」写入 —— 插件产出落在工作文件夹,存 markdown 供笔记引用。\n`)
      if (ctx.app.openFile) ctx.app.openFile(p)
    }
  },
})

// Mini Panel example: both surfaces use the same data and entity parameter.
// Current hosts supply live per-view params; all optional context methods are feature-detected.
// The view is drawn from host parts (2026-10-26+): view head, toolbar select, ⋯ menu, confirm dialog, empty state and
// the public .btn classes. They follow theme, language and zoom, so don't hand-make <select>, menus, dialogs or tab bars:
// check-plugin.mjs --style and the plugin sandbox list any you do. Labels are { zh, en } so a language switch applies at once.
// Both views (main and Mini) share one store: every change reads the stored counts, applies itself and saves, one at a
// time, so a view's stale copy never overwrites a number the other view just saved.
let queue = Promise.resolve()
const readCounts = (data) => data?.counts || { daily: Number(data?.count) || 0 } // 1.2.0 kept one number under `count`
const change = (fn) => (queue = queue.catch(() => {}).then(async () => {
  const counts = { ...readCounts(await ctx.loadData()) }
  fn(counts)
  await ctx.saveData({ counts })
  return counts
}))
const COUNTERS = [{ value: 'daily', label: { zh: '每天', en: 'Daily' } }, { value: 'weekly', label: { zh: '每周', en: 'Weekly' } }]
for (const id of ['counter', 'mini-counter']) {
  ctx.registerView({
    id,
    title: isZh() ? '计数器' : 'Counter',
    mount(el, view) {
      // One guard for apps older than the parts; below it the parts are called directly (no hand-made fallback).
      if (!ctx.ui?.setViewHead) { el.textContent = isZh() ? '请把 Forsion 更新到最新版。' : 'Update Forsion to use this view.'; return }
      let disposed = false
      let counts = {}
      let empty = null
      const counter = () => String(view?.getParams?.().counterId || 'daily')
      const head = ctx.ui.setViewHead(el, { title: { zh: '计数器', en: 'Counter' } })
      const pick = document.createElement('span')
      const picker = ctx.ui.mountControl(pick, {
        type: 'select', size: 'toolbar', value: counter(), label: { zh: '计数器', en: 'Counter' }, options: COUNTERS,
        onChange: (value) => { view?.setParams?.({ counterId: value }); render() },
      })
      const add = document.createElement('button')
      add.className = 'btn primary sm'
      add.textContent = isZh() ? '加一' : 'Add one'
      const more = document.createElement('button')
      more.className = 'btn ghost sm'
      more.setAttribute('aria-label', isZh() ? '更多' : 'More')
      more.append(ctx.ui.icon('more', { size: 16 }))
      head.actions.append(pick, add, more)
      const body = el.appendChild(document.createElement('div'))
      body.style.cssText = 'padding:16px;font:var(--ui-font-display) var(--font-ui);color:var(--text);'
      const save = async (fn) => { const next = await change(fn); if (!disposed) { counts = next; render() } }
      const inc = async () => {
        const c = counter()
        add.disabled = true
        try { await save((all) => { all[c] = (all[c] || 0) + 1 }) } finally { if (!disposed) add.disabled = false }
      }
      const reset = async () => {
        const c = counter()
        if (await ctx.ui.confirm({ title: { zh: '把这个计数器清零?', en: 'Reset this counter?' }, ok: { zh: '清零', en: 'Reset' }, danger: true })) await save((all) => { all[c] = 0 })
      }
      add.onclick = inc
      more.onclick = () => ctx.ui.contextMenu({ anchor: more, align: 'end' }, [
        { label: { zh: '清零', en: 'Reset' }, icon: 'trash-2', danger: true, run: reset },
      ])
      function render() {
        const n = counts[counter()] || 0
        empty?.dispose(); empty = null
        body.textContent = n ? String(n) : ''
        if (!n) empty = ctx.ui.mountEmptyState(body, { icon: 'plus', title: { zh: '还没开始计数', en: 'Nothing counted yet' }, action: { label: { zh: '加一', en: 'Add one' }, run: inc } })
      }
      const off = view?.onParamsChanged?.((params) => { picker.update({ value: String(params.counterId || 'daily') }); render() })
      Promise.resolve(ctx.loadData()).then((data) => {
        if (disposed) return
        counts = readCounts(data)
        render()
      })
      render()
      return () => { disposed = true; off?.(); empty?.dispose(); picker.dispose(); head.dispose(); body.remove() }
    },
  })
}
