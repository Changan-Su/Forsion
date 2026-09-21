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
    // 文件面示范(2026-08-03 约定):产出写进插件「工作文件夹」(设置页每个插件自动有一条,
    // 默认=插件显示名);整库可读写、越界被宿主拒绝;老宿主没有 workFolder(甚至没有 app)就整体跳过。
    if (ctx.app && ctx.app.workFolder && ctx.app.writeFile) {
      const p = `${ctx.app.workFolder()}/你好.md`
      await ctx.app.writeFile(p, `# 你好,${name}\n\n由「示例捆绑包」写入 —— 插件产出落在工作文件夹,存 markdown 供笔记引用。\n`)
      if (ctx.app.openFile) ctx.app.openFile(p)
    }
  },
})

// Mini Panel example: both surfaces use the same data and entity parameter.
// Current hosts supply live per-view params; all optional context methods are feature-detected.
for (const id of ['counter', 'mini-counter']) {
  ctx.registerView({
    id,
    title: 'Counter',
    mount(el, view) {
      const zh = document.documentElement.lang.startsWith('zh')
      let disposed = false
      let count = 0
      const root = document.createElement('section')
      root.style.cssText = 'padding:16px;color:var(--text);font:13px var(--font-ui);display:grid;gap:12px;'
      const label = document.createElement('label')
      label.textContent = zh ? '计数器名称' : 'Counter name'
      const input = document.createElement('input')
      input.value = String(view?.getParams?.().counterId || 'daily')
      input.addEventListener('input', () => view?.setParams?.({ counterId: input.value }))
      label.append(input)
      const value = document.createElement('output')
      const button = document.createElement('button')
      button.textContent = zh ? '加一' : 'Add one'
      const render = () => { value.textContent = String(count) }
      button.onclick = async () => {
        button.disabled = true
        try { await ctx.saveData({ count: count + 1 }); count++; if (!disposed) render() }
        finally { if (!disposed) button.disabled = false }
      }
      root.append(label, value, button); el.append(root); render()
      const off = view?.onParamsChanged?.((params) => { input.value = String(params.counterId || 'daily') })
      Promise.resolve(ctx.loadData()).then((data) => { if (!disposed) { count = Number(data?.count) || 0; render() } })
      return () => { disposed = true; off?.(); root.remove() }
    },
  })
}
