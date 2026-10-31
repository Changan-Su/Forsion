// Round 8 DX recon sample. Bare setup body (host evaluates new Function('ctx', src)); public APIs only.
// FRICTION notes are inline as `// F:` so the report can cite them.

// ---- i18n boilerplate (F: every plugin rewrites this; no ctx.i18n / t() helper) ----
const MSG = {
  'list.title': { zh: '清单', en: 'Items' },
  'list.new': { zh: '新建条目', en: 'New item' },
  'mode.list': { zh: '列表', en: 'List' },
  'mode.board': { zh: '看板', en: 'Board' },
  'f.all': { zh: '全部', en: 'All' },
  'f.open': { zh: '进行中', en: 'Open' },
  'f.done': { zh: '已完成', en: 'Done' },
  'sort.title': { zh: '排序', en: 'Sort' },
  'sort.new': { zh: '最新', en: 'Newest' },
  'sort.name': { zh: '名称', en: 'Name' },
  'add': { zh: '新建', en: 'New' },
  'more': { zh: '更多', en: 'More' },
  'empty.title': { zh: '还没有条目', en: 'No items yet' },
  'empty.line': { zh: '新建的条目会出现在这里。', en: 'Items you create show up here.' },
  'm.rename': { zh: '重命名', en: 'Rename' },
  'm.dup': { zh: '复制一份', en: 'Duplicate' },
  'm.pin': { zh: '置顶', en: 'Pin' },
  'm.del': { zh: '删除', en: 'Delete' },
  'toast.saved': { zh: '已保存', en: 'Saved' },
  'toast.undo': { zh: '撤销', en: 'Undo' },
  'dlg.title': { zh: '导出条目', en: 'Export items' },
  'dlg.body': { zh: '导出为 Markdown 文件,放进工作文件夹。', en: 'Export as a Markdown file in the working folder.' },
  'dlg.ok': { zh: '导出', en: 'Export' },
  'dlg.cancel': { zh: '取消', en: 'Cancel' },
  'pop.title': { zh: '筛选', en: 'Filter' },
  'set.g1': { zh: '显示', en: 'Display' },
  'set.compact': { zh: '紧凑行', en: 'Compact rows' },
  'set.compactD': { zh: '列表行高收到 28px。', en: 'List rows shrink to 28px.' },
  'set.density': { zh: '卡片密度', en: 'Card density' },
  'set.d1': { zh: '舒适', en: 'Comfortable' }, 'set.d2': { zh: '标准', en: 'Default' }, 'set.d3': { zh: '紧凑', en: 'Compact' },
  'set.group': { zh: '分组依据', en: 'Group by' },
  'set.gNone': { zh: '不分组', en: 'None' }, 'set.gTag': { zh: '标签', en: 'Tag' }, 'set.gDate': { zh: '日期', en: 'Date' },
  'set.g2': { zh: '同步', en: 'Sync' },
  'set.sync': { zh: '跨设备同步', en: 'Sync across devices' },
  'set.limit': { zh: '每页条目数', en: 'Items per page' },
  'set.name': { zh: '导出文件名', en: 'Export file name' },
  'item': { zh: '条目 {n}', en: 'Item {n}' },
}
let locale = ctx.getLocale?.() ?? 'zh'
const t = (k, vars) => (MSG[k]?.[locale] ?? MSG[k]?.zh ?? k).replace(/\{(\w+)\}/g, (m, v) => (vars && v in vars ? String(vars[v]) : m))
const rerenders = new Set()
ctx.subscribeLocale?.((l) => { locale = l; rerenders.forEach((f) => f()) })

// ---- icons (F: no way to draw a vocabulary icon in my own DOM; copy lucide paths by hand) ----
const SVG = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  filter: '<path d="M3 6h18M7 12h10M10 18h4"/>',
  download: '<path d="M12 15V3M7 10l5 5 5-5M5 21h14"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
}
const icon = (n, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[n]}</svg>`

// ---- CSS (F: no host class vocabulary documented for toolbar / icon button / card / empty state; hand-written with tokens) ----
const style = document.createElement('style')
style.textContent = `
.r8-root { height: 100%; display: flex; flex-direction: column; color: var(--text); font: var(--ui-font-body, 13px) var(--font-ui, system-ui); }
.r8-body { flex: 1; overflow: auto; padding: 16px 20px; }
.r8-tools { display: flex; align-items: center; gap: 6px; }
.r8-icon-btn { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: var(--radius-sm, 6px); background: transparent; color: var(--text-muted); cursor: pointer; }
.r8-icon-btn:hover { background: var(--overlay-light); color: var(--text); }
.r8-card { padding: 10px 12px; border-radius: var(--radius-md, 10px); background: var(--bg-card); box-shadow: var(--card-shadow); margin-bottom: 8px; }
.r8-card small { color: var(--text-muted); }
.r8-mine-empty { display: grid; justify-items: center; gap: 6px; padding: 48px 0; color: var(--text-muted); }
.r8-mine-empty strong { color: var(--text); font-size: var(--ui-font-heading, 15px); }
.r8-dialog { border: 0; border-radius: var(--radius-lg, 14px); background: var(--bg-card); color: var(--text); box-shadow: var(--card-shadow); padding: 18px 20px; min-width: 320px; }
.r8-dialog::backdrop { background: rgba(0,0,0,.25); }
.r8-pop { margin: 0; border: 0; border-radius: var(--radius-md, 10px); background: var(--bg-card); color: var(--text); box-shadow: var(--card-shadow); padding: 10px; min-width: 200px; }
.r8-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.r8-slot { display: inline-flex; }
`
document.head.append(style) // F: no ctx.injectStyle with lifecycle; must remove on disable myself (and there is no onDisable hook for setup-level resources)

// ---- data ----
let items = []
let seq = 0
const subs = new Set()
const changed = () => { subs.forEach((f) => f()); rerenders.forEach((f) => f()) }
const addItem = (title) => { seq++; items = [{ key: 'i' + seq, title: title || t('item', { n: seq }), done: seq % 3 === 0, at: Date.now() }, ...items]; changed() }
window.__r8dx = { seed(n = 6) { for (let i = 0; i < n; i++) addItem() }, clear() { items = []; seq = 0; changed() } } // instrumentation only

// ---- left: list source (host-drawn) ----
ctx.registerListSource?.({
  id: 'items',
  title: t('list.title'), // F: string frozen at registration; switching language does not update it
  search: true,
  items: ({ query } = {}) => items.filter((i) => !query || i.title.toLowerCase().includes(query.toLowerCase())).map((i) => ({ key: i.key, title: i.title, hint: i.done ? '✓' : '', icon: 'list-checks', subtitle: new Date(i.at).toLocaleTimeString() })),
  subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
  open: () => ctx.openView('main'),
  actions: [{ id: 'new', label: t('list.new'), icon: 'plus', primary: true, run: () => addItem() }],
  itemMenu: (it) => [
    { id: 'ren', label: t('m.rename'), icon: 'edit', run: () => {} },
    { id: 'del', label: t('m.del'), icon: 'trash', danger: true, run: () => { items = items.filter((x) => x.key !== it.key); changed() } },
  ],
})

// ---- main view ----
ctx.registerView({
  id: 'main',
  title: 'DX sample',
  mount(el) {
    const root = document.createElement('div'); root.className = 'r8-root'; root.dataset.r8 = 'main'
    const body = document.createElement('div'); body.className = 'r8-body'
    el.append(root)
    let mode = 'list', filter = 'all', sort = 'new'
    // view modes + head-row actions slot
    const vm = ctx.ui?.setViewModes?.(el, {
      modes: [{ id: 'list', label: '列表', labelEn: 'List', icon: 'list-checks' }, { id: 'board', label: '看板', labelEn: 'Board', icon: 'kanban' }],
      value: mode, onChange: (id) => { mode = id; draw() },
    })
    const tools = document.createElement('div'); tools.className = 'r8-tools'; tools.dataset.r8 = 'tools'
    // F: no toolbar segmented control / select for plugins. Only the settings-row parts exist; try them inline.
    const segSlot = document.createElement('div'); segSlot.className = 'r8-slot'; segSlot.dataset.r8 = 'seg'
    const selSlot = document.createElement('div'); selSlot.className = 'r8-slot'; selSlot.dataset.r8 = 'sel'
    const seg = ctx.ui?.mountSettingsItem?.(segSlot, { type: 'segmented', id: 'filter', title: '', value: filter, options: [{ value: 'all', label: t('f.all') }, { value: 'open', label: t('f.open') }, { value: 'done', label: t('f.done') }], onChange: (v) => { filter = v; draw() } })
    const sel = ctx.ui?.mountSettingsItem?.(selSlot, { type: 'select', id: 'sort', title: '', value: sort, options: [{ value: 'new', label: t('sort.new') }, { value: 'name', label: t('sort.name') }], onChange: (v) => { sort = v; draw() } })
    // F: primary button: `.btn.primary` exists in host base.css but is not documented as plugin vocabulary
    const add = document.createElement('button'); add.type = 'button'; add.className = 'btn sm primary'; add.dataset.r8 = 'add'
    add.innerHTML = icon('plus', 14) + `<span>${t('add')}</span>`
    add.onclick = () => { addItem(); ctx.notify?.(t('toast.saved'), { level: 'success', action: { label: t('toast.undo'), run: () => { items = items.slice(1); changed() } }, key: 'saved' }) }
    const filt = document.createElement('button'); filt.type = 'button'; filt.className = 'r8-icon-btn'; filt.innerHTML = icon('filter'); filt.setAttribute('aria-label', t('pop.title')); filt.dataset.r8 = 'filterbtn'
    const exp = document.createElement('button'); exp.type = 'button'; exp.className = 'r8-icon-btn'; exp.innerHTML = icon('download'); exp.setAttribute('aria-label', t('dlg.title')); exp.dataset.r8 = 'export'
    const more = document.createElement('button'); more.type = 'button'; more.className = 'r8-icon-btn'; more.innerHTML = icon('more'); more.setAttribute('aria-label', t('more')); more.dataset.r8 = 'more'
    const tips = [ctx.ui?.attachTooltip?.(filt, t('pop.title'), { side: 'bottom' }), ctx.ui?.attachTooltip?.(exp, t('dlg.title'), { side: 'bottom' }), ctx.ui?.attachTooltip?.(more, t('more'), { side: 'bottom' })]
    // context menu: F: PluginContextMenuItem has no icon; the host strips unknown fields
    more.onclick = () => { const r = more.getBoundingClientRect(); ctx.ui?.contextMenu?.(r.left, r.bottom + 4, [
      { label: t('m.rename'), icon: 'edit', run: () => {} },
      { label: t('m.dup'), icon: 'copy', run: () => addItem() },
      { label: t('m.pin'), icon: 'pin', checked: false, run: () => {} },
      { label: t('m.del'), icon: 'trash', danger: true, run: () => window.__r8dx.clear() },
    ]) }
    // modal: F: no host modal/confirm with body + buttons; native <dialog> gets host motion but zero host styling
    const dlg = document.createElement('dialog'); dlg.className = 'r8-dialog'; dlg.dataset.r8 = 'dialog'
    exp.onclick = () => {
      dlg.innerHTML = `<strong>${t('dlg.title')}</strong><p style="color:var(--text-muted);margin:8px 0 0">${t('dlg.body')}</p><div class="r8-row"><button type="button" class="btn sm ghost" value="cancel">${t('dlg.cancel')}</button><button type="button" class="btn sm primary" value="ok">${t('dlg.ok')}</button></div>`
      dlg.querySelectorAll('button').forEach((b) => (b.onclick = () => dlg.close(b.value)))
      if (!dlg.isConnected) document.body.append(dlg) // F: must append to body (Shell isolation), not to el
      dlg.showModal()
    }
    // popover: F: anchored positioning + zoom math by hand (OverlayAt/clampMenu named in SKILL.md rule 3 are not reachable)
    const pop = document.createElement('div'); pop.popover = 'auto'; pop.className = 'r8-pop'; pop.dataset.r8 = 'popover'
    filt.onclick = () => {
      pop.innerHTML = `<div style="font-weight:600;margin-bottom:8px">${t('pop.title')}</div>`
      const slot = document.createElement('div'); pop.append(slot)
      ctx.ui?.mountSettingsItem?.(slot, { type: 'switch', id: 'onlyopen', title: t('f.open'), value: filter === 'open', onChange: (v) => { filter = v ? 'open' : 'all'; draw() } })
      if (!pop.isConnected) document.body.append(pop)
      pop.showPopover()
      const r = filt.getBoundingClientRect(), z = pop.currentCSSZoom || 1
      pop.style.position = 'fixed'; pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth * z - 8) / z}px`; pop.style.top = `${(r.bottom + 4) / z}px`
    }
    tools.append(segSlot, selSlot, filt, exp, more, add)
    if (vm) vm.actions.append(tools); else root.append(tools)
    root.append(body)
    // body: try the settings `state` part as empty state, plus a hand-made one that borrows the host class name
    let stateH = null
    const draw = () => {
      stateH?.dispose(); stateH = null
      body.textContent = ''
      const list = items.filter((i) => filter === 'all' || (filter === 'done' ? i.done : !i.done)).sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title) : b.at - a.at)
      if (!list.length) {
        const a = document.createElement('div'); a.dataset.r8 = 'empty-settings-state'; body.append(a)
        stateH = ctx.ui?.mountSettingsItem?.(a, { type: 'state', id: 'empty', state: { kind: 'empty', icon: 'list-checks', title: t('empty.title'), desc: t('empty.line'), action: { label: t('list.new'), kind: 'primary', onClick: () => addItem() } } })
        const b = document.createElement('div'); b.className = 'empty-state'; b.dataset.r8 = 'empty-host-class' // F: try host class name blind
        b.innerHTML = `${icon('inbox', 22)}<strong class="empty-state-title">${t('empty.title')}</strong><p class="empty-state-line">${t('empty.line')}</p><div class="empty-state-actions"><button type="button" class="empty-state-action">${icon('plus', 15)}${t('list.new')}</button></div>`
        b.querySelector('button').onclick = () => addItem()
        body.append(b)
        return
      }
      for (const i of list) {
        const c = document.createElement('div'); c.className = 'r8-card'; c.dataset.r8 = 'card'
        c.innerHTML = `<div>${i.title}</div><small>${i.done ? t('f.done') : t('f.open')}</small>`
        c.addEventListener('contextmenu', (e) => { e.preventDefault(); ctx.ui?.contextMenu?.(e.clientX, e.clientY, [{ label: t('m.rename'), run: () => {} }, { label: t('m.del'), danger: true, run: () => {} }]) })
        body.append(c)
      }
    }
    draw()
    const relabel = () => { add.querySelector('span').textContent = t('add'); draw() } // F: segmented/select labels need a manual update() on locale change
    rerenders.add(relabel)
    return () => { rerenders.delete(relabel); stateH?.dispose(); seg?.dispose(); sel?.dispose(); tips.forEach((x) => x?.dispose()); vm?.dispose(); dlg.remove(); pop.remove(); root.remove() }
  },
})

// ---- right: settings page (host-drawn) ----
ctx.registerView({
  id: 'settings',
  title: 'DX settings',
  mount(el) {
    el.dataset.r8 = 'settings'
    const st = { compact: false, density: 'd2', group: 'none', sync: true, limit: 20 }
    const schema = () => ({ groups: [
      { id: 'g1', icon: 'list-checks', title: t('set.g1'), items: [
        { type: 'switch', id: 'compact', title: t('set.compact'), desc: t('set.compactD'), value: st.compact, onChange: (v) => { st.compact = v } },
        { type: 'segmented', id: 'density', title: t('set.density'), value: st.density, options: [{ value: 'd1', label: t('set.d1') }, { value: 'd2', label: t('set.d2') }, { value: 'd3', label: t('set.d3') }], onChange: (v) => { st.density = v } },
        { type: 'select', id: 'group', title: t('set.group'), value: st.group, options: [{ value: 'none', label: t('set.gNone') }, { value: 'tag', label: t('set.gTag') }, { value: 'date', label: t('set.gDate') }], onChange: (v) => { st.group = v } },
      ] },
      { id: 'g2', icon: 'clock', title: t('set.g2'), items: [
        { type: 'switch', id: 'sync', title: t('set.sync'), value: st.sync, onChange: (v) => { st.sync = v } },
        { type: 'stepper', id: 'limit', title: t('set.limit'), min: 5, max: 100, step: 5, value: st.limit, onChange: (v) => { st.limit = v } },
        { type: 'input', id: 'name', title: t('set.name'), placeholder: 'items.md' },
      ] },
    ] })
    const page = ctx.ui?.mountSettingsPage?.(el, schema())
    const re = () => page?.update(schema()) // F: whole-schema update on every locale switch
    rerenders.add(re)
    return () => { rerenders.delete(re); page?.dispose() }
  },
})
