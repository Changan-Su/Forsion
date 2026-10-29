// Plugin view base look (2026-10-29): the "bare" view writes plain HTML with no classes and no CSS of its own —
// the host's base layer should make it look native. The "flaky" view throws on mount until window.__pbase.broken
// is cleared, for the failure card + Retry. Bare setup body; public APIs only. Driven by scripts/plugin-base-shots.cjs.

// The only CSS here is the tie probe: (0,0,1), the same weight as the host's base button rule — the plugin's must win.
ctx.addStyle(':where(.pb-tie) button { background: var(--danger-light); border-color: var(--danger); }')

window.__pbase = { broken: true } // instrumentation only

ctx.registerView({
  id: 'bare',
  title: { zh: '裸写', en: 'Bare' },
  mount(el) {
    el.innerHTML = `
<div data-pb="bare" style="padding: 20px 24px; display: grid; gap: 14px; max-width: 720px">
  <h1>项目周报</h1>
  <p>没写一行样式:标题、按钮、输入框、表格都该是宿主的样子。</p>
  <h2>操作</h2>
  <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
    <button data-pb="b1">新建</button>
    <button data-pb="b2">导出</button>
    <button data-pb="b3" disabled>已禁用</button>
    <button data-pb="btn" class="btn">.btn</button>
    <button class="btn primary">.btn.primary</button>
    <span class="pb-tie"><button data-pb="tie">插件自己的</button></span>
  </div>
  <h3>筛选</h3>
  <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
    <input data-pb="in" placeholder="搜索标题">
    <select data-pb="sel"><option>全部</option><option>进行中</option><option>已完成</option></select>
    <label><input type="checkbox" checked> 只看我的</label>
  </div>
  <textarea rows="2" placeholder="备注"></textarea>
  <h4>本周</h4>
  <table data-pb="table">
    <thead><tr><th>任务</th><th>负责人</th><th>状态</th></tr></thead>
    <tbody>
      <tr><td>接入支付回调</td><td>阿青</td><td>进行中</td></tr>
      <tr><td>导出 CSV</td><td>小林</td><td>已完成</td></tr>
      <tr><td>权限页改版</td><td>阿青</td><td>待开始</td></tr>
    </tbody>
  </table>
  <div data-pb="part"></div>
</div>`
    // A host part inside the bare view: its layer (data-host-mount) must stay out of the base look
    const part = ctx.ui?.mountEmptyState?.(el.querySelector('[data-pb="part"]'), { icon: 'list-checks', title: { zh: '宿主零件', en: 'Host part' } })
    return () => part?.dispose?.()
  },
})

ctx.registerView({
  id: 'flaky',
  title: { zh: '会失败的视图', en: 'Flaky view' },
  mount(el) {
    if (window.__pbase.broken) throw new TypeError('Cannot read properties of undefined (reading \'items\')\n    at mount (plugin-base-sample/main.js:58)')
    el.innerHTML = '<div data-pb="flaky-ok" style="padding: 16px"><h2>挂上了</h2><p>重试之后这一个视图重新 mount。</p><button>刷新</button></div>'
  },
})
