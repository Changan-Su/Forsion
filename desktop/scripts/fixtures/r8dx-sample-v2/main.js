// Round 8 DX sample, v2 (2026-10-26): the same plugin as the recon one (docs/ToBeImproved/走查续八…/instrument/.raw/dx/r8dx-sample),
// rewritten on the new ctx.ui parts — no hand-copied icons, no frozen strings, no own dialog / popover / empty state CSS.
// Bare setup body (the host evaluates new Function('ctx', src)); public APIs only. Driven by scripts/r8dx-shots.cjs.

const t = ctx.i18n.define({
  zh: {
    'list.title': '清单', 'list.new': '新建条目', 'mode.list': '列表', 'mode.board': '看板', 'head.title': '样例',
    'f.all': '全部', 'f.open': '进行中', 'f.done': '已完成', 'sort.title': '排序', 'sort.new': '最新', 'sort.name': '名称',
    add: '新建', more: '更多', 'empty.title': '还没有条目', 'empty.line': '新建的条目会出现在这里。',
    'm.item': '条目', 'm.rename': '重命名', 'm.dup': '复制一份', 'm.pin': '置顶', 'm.del': '删除',
    'toast.saved': '已保存', 'toast.undo': '撤销', 'dlg.title': '导出条目', 'dlg.body': '导出为 Markdown 文件,放进工作文件夹。', 'dlg.ok': '导出', 'dlg.cancel': '取消',
    'del.title': '删除全部条目?', 'del.body': '这一步不能撤销。', 'pop.title': '筛选', 'pop.only': '只看进行中', item: '条目 {n}',
    'set.g1': '显示', 'set.compact': '紧凑行', 'set.density': '卡片密度', 'set.d1': '舒适', 'set.d2': '标准', 'set.d3': '紧凑',
  },
  en: {
    'list.title': 'Items', 'list.new': 'New item', 'mode.list': 'List', 'mode.board': 'Board', 'head.title': 'Sample',
    'f.all': 'All', 'f.open': 'Open', 'f.done': 'Done', 'sort.title': 'Sort', 'sort.new': 'Newest', 'sort.name': 'Name',
    add: 'New', more: 'More', 'empty.title': 'No items yet', 'empty.line': 'Items you create show up here.',
    'm.item': 'Item', 'm.rename': 'Rename', 'm.dup': 'Duplicate', 'm.pin': 'Pin', 'm.del': 'Delete',
    'toast.saved': 'Saved', 'toast.undo': 'Undo', 'dlg.title': 'Export items', 'dlg.body': 'Export as a Markdown file in the working folder.', 'dlg.ok': 'Export', 'dlg.cancel': 'Cancel',
    'del.title': 'Delete all items?', 'del.body': 'This can’t be undone.', 'pop.title': 'Filter', 'pop.only': 'Open only', item: 'Item {n}',
    'set.g1': 'Display', 'set.compact': 'Compact rows', 'set.density': 'Card density', 'set.d1': 'Comfortable', 'set.d2': 'Default', 'set.d3': 'Compact',
  },
})
const T = (k) => () => t(k) // a PluginText that follows a language switch

ctx.addStyle(`
.r8-root { height: 100%; display: flex; flex-direction: column; color: var(--text); font-size: var(--ui-font-body); }
.r8-body { flex: 1; overflow: auto; padding: 16px 20px; }
.r8-icon-btn { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer; }
.r8-icon-btn:hover { background: var(--overlay-light); color: var(--text); }
.r8-card { padding: 10px 12px; border-radius: var(--radius-md); background: var(--bg-card); box-shadow: var(--card-shadow); margin-bottom: 8px; }
.r8-card small { color: var(--text-muted); }
`)

let items = [], seq = 0
const subs = new Set(), redraws = new Set()
const changed = () => { subs.forEach((f) => f()); redraws.forEach((f) => f()) }
const addItem = () => { seq++; items = [{ key: 'i' + seq, n: seq, done: seq % 3 === 0, at: Date.now() }, ...items]; changed() }
const titleOf = (i) => t('item', { n: i.n })
window.__r8dx = { seed(n = 6) { for (let i = 0; i < n; i++) addItem() }, clear() { items = []; seq = 0; changed() } } // instrumentation only

ctx.registerListSource({
  id: 'items',
  title: T('list.title'),
  search: true,
  empty: { icon: 'list-checks', title: T('empty.title'), line: T('empty.line'), action: { label: T('list.new'), icon: 'plus', run: addItem } },
  items: ({ query } = {}) => items.filter((i) => !query || titleOf(i).toLowerCase().includes(query.toLowerCase()))
    .map((i) => ({ key: i.key, title: titleOf(i), hint: i.done ? '✓' : '', icon: 'list-checks', subtitle: new Date(i.at).toLocaleTimeString() })),
  subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
  open: () => ctx.openView('main'),
  actions: [{ id: 'new', label: T('list.new'), icon: 'plus', primary: true, run: addItem }],
  itemMenu: (it) => [{ id: 'del', label: T('m.del'), icon: 'trash', danger: true, run: () => { items = items.filter((x) => x.key !== it.key); changed() } }],
})

ctx.registerView({
  id: 'main',
  title: { zh: 'DX 样例', en: 'DX sample' },
  mount(el) {
    const root = document.createElement('div'); root.className = 'r8-root'; root.dataset.r8 = 'main'
    const body = document.createElement('div'); body.className = 'r8-body'
    el.append(root)
    let mode = 'list', filter = 'all', sort = 'new'
    const vm = ctx.ui.setViewModes(el, {
      modes: [{ id: 'list', label: '列表', labelEn: 'List', icon: 'list-checks' }, { id: 'board', label: '看板', labelEn: 'Board', icon: 'kanban' }],
      value: mode, onChange: (id) => { mode = id; draw() },
    })
    const head = ctx.ui.setViewHead(el, { title: T('head.title') })
    const slot = (name) => { const s = document.createElement('span'); s.dataset.r8 = name; s.style.display = 'inline-flex'; return s }
    const segSlot = slot('seg'), selSlot = slot('sel')
    const seg = ctx.ui.mountControl(segSlot, { type: 'segmented', value: filter, label: T('pop.title'),
      options: [{ value: 'all', label: T('f.all') }, { value: 'open', label: T('f.open') }, { value: 'done', label: T('f.done') }], onChange: (v) => { filter = v; draw() } })
    const sel = ctx.ui.mountControl(selSlot, { type: 'select', value: sort, label: T('sort.title'),
      options: [{ value: 'new', label: T('sort.new') }, { value: 'name', label: T('sort.name') }], onChange: (v) => { sort = v; draw() } })
    const iconBtn = (name, label, key) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'r8-icon-btn'; b.dataset.r8 = key
      b.setAttribute('aria-label', t(label)); b.append(ctx.ui.icon(name, { size: 16 }))
      return { b, tip: ctx.ui.attachTooltip?.(b, t(label), { side: 'bottom' }) }
    }
    const filt = iconBtn('filter', 'pop.title', 'filterbtn'), exp = iconBtn('download', 'dlg.title', 'export'), more = iconBtn('more', 'more', 'more')
    const add = document.createElement('button'); add.type = 'button'; add.className = 'btn sm primary'; add.dataset.r8 = 'add'
    const addLabel = document.createElement('span')
    add.append(ctx.ui.icon('plus', { size: 14 }), addLabel)
    add.onclick = () => { addItem(); ctx.notify?.(t('toast.saved'), { level: 'success', action: { label: t('toast.undo'), run: () => { items = items.slice(1); changed() } }, key: 'saved' }) }
    more.b.onclick = () => ctx.ui.contextMenu({ anchor: more.b, align: 'end' }, [
      { section: T('m.item') },
      { label: T('m.rename'), icon: 'pencil', shortcut: 'F2', run: () => {} },
      { label: T('m.dup'), icon: 'copy', shortcut: '⌘D', run: addItem },
      { label: T('m.pin'), icon: 'pin', run: () => {} },
      { separator: true },
      { label: T('m.del'), icon: 'trash-2', danger: true, run: async () => {
        if (await ctx.ui.confirm({ title: T('del.title'), body: T('del.body'), danger: true })) window.__r8dx.clear()
      } },
    ])
    exp.b.onclick = () => ctx.ui.openDialog({ title: T('dlg.title'), body: T('dlg.body'),
      actions: [{ label: T('dlg.cancel') }, { label: T('dlg.ok'), primary: true, run: () => {} }] })
    filt.b.onclick = () => ctx.ui.popover(filt.b, { label: T('pop.title'), mount: (pop) => {
      pop.dataset.r8 = 'popover'
      const h = ctx.ui.mountSettingsItem(pop, { type: 'switch', id: 'onlyopen', title: t('pop.only'), value: filter === 'open', onChange: (v) => { filter = v ? 'open' : 'all'; seg.update({ value: filter }); draw() } })
      return () => h.dispose()
    } })
    head.actions.append(segSlot, selSlot, filt.b, exp.b, more.b, add)
    root.append(body)
    let empty = null
    const draw = () => {
      addLabel.textContent = t('add')
      empty?.dispose(); empty = null
      body.textContent = ''
      const list = items.filter((i) => filter === 'all' || (filter === 'done' ? i.done : !i.done)).sort((a, b) => sort === 'name' ? titleOf(a).localeCompare(titleOf(b)) : b.at - a.at)
      if (!list.length) {
        const box = document.createElement('div'); box.dataset.r8 = 'empty'; box.style.height = '100%'; body.append(box)
        empty = ctx.ui.mountEmptyState(box, { icon: 'list-checks', title: T('empty.title'), line: T('empty.line'), action: { label: T('list.new'), icon: 'plus', run: addItem } })
        return
      }
      for (const i of list) {
        const c = document.createElement('div'); c.className = 'r8-card'; c.dataset.r8 = 'card'
        const name = document.createElement('div'); name.textContent = titleOf(i)
        const st = document.createElement('small'); st.textContent = i.done ? t('f.done') : t('f.open')
        c.append(name, st)
        c.addEventListener('contextmenu', (e) => { e.preventDefault(); ctx.ui.contextMenu(e.clientX, e.clientY, [{ label: T('m.rename'), icon: 'pencil', run: () => {} }, { separator: true }, { label: T('m.del'), icon: 'trash-2', danger: true, run: () => {} }]) })
        body.append(c)
      }
    }
    draw()
    redraws.add(draw)
    const unsub = ctx.subscribeLocale?.(draw) // only my own DOM; host-drawn parts follow by themselves
    return () => { redraws.delete(draw); unsub?.(); empty?.dispose(); seg.dispose(); sel.dispose(); [filt, exp, more].forEach((x) => x.tip?.dispose()); head.dispose(); vm.dispose(); root.remove() }
  },
})

ctx.registerView({
  id: 'settings',
  title: { zh: 'DX 设置', en: 'DX settings' },
  mount(el) {
    el.dataset.r8 = 'settings'
    const st = { compact: false, density: 'd2' }
    const schema = () => ({ groups: [{ id: 'g1', icon: 'list-checks', title: t('set.g1'), items: [
      { type: 'switch', id: 'compact', title: t('set.compact'), value: st.compact, onChange: (v) => { st.compact = v } },
      { type: 'segmented', id: 'density', title: t('set.density'), value: st.density, options: [{ value: 'd1', label: t('set.d1') }, { value: 'd2', label: t('set.d2') }, { value: 'd3', label: t('set.d3') }], onChange: (v) => { st.density = v } },
    ] }] })
    const page = ctx.ui.mountSettingsPage(el, schema())
    const unsub = ctx.subscribeLocale?.(() => page.update(schema())) // settings schemas stay strings (they cross to the native half-sheet)
    return () => { unsub?.(); page.dispose() }
  },
})
