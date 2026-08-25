/**
 * 图鉴逻辑:以 index.html 里那批 <link data-label> 为唯一清单 → fetch 同一批 CSS →
 * 解析「分节注释 + 规则」→ 渲染分类目录 / 实例 / token 面板。
 *
 * 为什么解析注释而不是另写一份清单:base.css / engine.css 的分节注释本来就写着**这是什么、
 * 什么时候用、踩过什么坑**(仓库里最权威的那份)。抄一遍必然腐烂,读原文则永远同步。
 *
 * 扩展性契约:
 *   - 新增 CSS 真源 → 在 index.html 加一条 `<link … data-label="…">`。**link 本身就是清单**,
 *     所以不存在「登记了却没挂上样式」的漂移(把清单写进 JS 时踩过)。
 *   - 新增设计语言 → THEMES 加一行(theme.css 只抽 token,主题规则是覆盖不是组件,不进组件目录)。
 *   - 新增实例 → DEMOS 加一条。
 * 解析器与它的自测在 ./cssIndex.js —— `node cssIndex.js` 可单跑。
 */
import { parseCss, classesIn, varsUsed, varsDeclared } from './cssIndex.js';

const D = '../../desktop/frontend/src';
export const THEMES = [
  { id: 'lovable', dir: `${D}/theme/themes/lovable` },
  { id: 'zhi', dir: `${D}/theme/themes/zhi` },
  { id: 'genesis-glass', dir: `${D}/theme/themes/genesis-glass` },
  { id: 'lovable-plus', dir: '../../desktop/themes/lovable-plus' },
];

// ── 实例(demo):只手写少量真·可复用基元;其余类只登记。「未收录」计数即提醒 ──────────
const svg = (d, w = 15) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>');
const CHECK = svg('<path d="M20 6 9 17l-5-5"/>');

export const DEMOS = {
  btn: {
    when: '所有需要用户拍板的动作。按钮的描边是它的形状,不属于「内容卡不描边」那条(DESIGN.md §5)。',
    html: `<button class="btn primary">主操作</button>
<button class="btn ghost">次要</button>
<button class="btn danger">危险</button>
<button class="btn primary sm">小号</button>
<button class="btn primary" disabled>禁用</button>`,
  },
  'icon-btn': {
    when: '顶栏 / 输入框排的纯图标钮:30×30 圆形,平时 0.7 透明,hover 归 1。',
    html: `<button class="icon-btn">${ICON}</button><button class="icon-btn active">${CHECK}</button>`,
  },
  seg: {
    when: '互斥的 2–4 档(明暗 / 阴影 / 玻璃)。边线走 --overlay-medium 而非 --border,否则暗色下描一圈黑边。',
    html: `<div class="seg"><button class="active">亮</button><button>暗</button><button>跟随系统</button></div>`,
  },
  switch: {
    when: '通用二态开关,配 .switch-row 摆文案。开态染 --accent-ink。',
    html: `<div class="switch-row"><button class="switch on" role="switch" aria-checked="true"></button><span>已开启</span></div>
<div class="switch-row"><button class="switch" role="switch" aria-checked="false"></button><span>已关闭</span></div>`,
  },
  field: {
    when: '设置 / 弹窗里的表单字段:label + 控件 + .hint。多列并排用 .field-row 包。',
    html: `<div style="width:100%;max-width:420px">
  <div class="field"><label>工作目录</label><input type="text" value="~/Forsion" /><div class="hint">留空 = 使用默认目录</div></div>
  <div class="field-row"><div class="field"><label>端口</label><input type="text" value="3001" /></div>
    <div class="field"><label>模式</label><select><option>本地</option><option>云端</option></select></div></div>
  <div class="field"><label class="inline-check"><input type="checkbox" checked /> 启动时自动连接</label></div>
</div>`,
  },
  'inline-input': {
    when: '卡片内联输入(ask_user 自由输入等)。跟随 token,暗色不会是裸白底。',
    html: `<input class="inline-input" placeholder="输入你的回答…" style="width:260px" />`,
  },
  'ctx-menu': {
    when: '右键 / 更多操作浮层。真身 position:fixed,本页为展示已就地化。',
    html: `<div class="ctx-menu g-unfix" style="min-width:168px">
  <button class="ctx-item">${ICON}<span>重命名</span></button>
  <button class="ctx-item">${ICON}<span>复制链接</span></button>
  <button class="ctx-item danger">${ICON}<span>删除</span></button>
</div>`,
  },
  'cmd-panel': {
    when: 'LCL 命令面板(⌘K)。.cmd-overlay 是 fixed 遮罩,此处只展示面板本体。',
    html: `<div class="cmd-panel g-unfix">
  <input class="cmd-input" placeholder="输入命令…" value="主题" />
  <div class="cmd-list">
    <button class="cmd-item active"><span class="cmd-title"><span class="cmd-prefix">外观 · </span>切换明暗</span><span class="cmd-hotkey">⌘⇧L</span></button>
    <button class="cmd-item"><span class="cmd-title"><span class="cmd-prefix">外观 · </span>切换设计语言</span></button>
  </div>
  <div class="cmd-foot">↑↓ 选择 · ⏎ 执行 · Esc 关闭</div>
</div>`,
  },
  'tool-card': {
    when: 'agent 的一次工具调用。整框 + 柔阴影 + 全圆角,head 用 UI 字、hint 用等宽。失败只标红叉不描红边。',
    html: `<div class="tool-card" style="width:100%;max-width:520px">
  <div class="tool-card-head">${ICON}<span class="tool-name">read_file</span><span class="tool-hint">src/styles/base.css</span></div>
  <div class="tool-card-body"><div class="label">结果</div>已读取 4105 行。</div>
</div>
<div class="tool-card err" style="width:100%;max-width:520px">
  <div class="tool-card-head">${ICON}<span class="tool-name">run_bash</span><span class="tool-hint">exit 1</span></div>
</div>`,
  },
  'approval-card': {
    when: '需要用户拍板的动作卡 —— 属于「不去边的四类」之一,边线是信息不是装饰。',
    html: `<div class="approval-card" style="width:100%;max-width:520px">
  <div class="approval-title">${ICON} 允许写入 <code>~/.forsion/config.json</code>?</div>
  <div class="approval-why">这个路径在工作目录之外,所以要问你一次。</div>
  <pre class="approval-preview">+ "theme": "genesis-glass"</pre>
  <div class="approval-actions"><button class="btn primary sm">允许一次</button><button class="btn ghost sm">始终允许</button><button class="btn danger sm">拒绝</button></div>
</div>`,
  },
  'inquiry-card': { when: 'agent 的追问卡(ask_user)。与审批卡同族:中性柔影浮卡 + 选项。', html: `<div class="inquiry-card" style="width:100%;max-width:480px"><div class="inquiry-q">要为这次改动写日志吗?</div><div class="inquiry-opts"><button class="btn ghost sm">写</button><button class="btn ghost sm">不写</button></div></div>` },
  'plugin-card': { when: '插件页卡片的**唯一正典**(check:settingsui 钉住)。别在别处另起一套卡。', html: `<div class="plugin-card" style="width:260px"><strong>Bluebird 视频分析</strong><div class="hint" style="color:var(--text-faint);font-size:11.5px">v1.2.0 · 已启用</div></div><div class="plugin-card plugin-card--blocked" style="width:260px"><strong>不兼容插件</strong><div class="hint" style="color:var(--text-faint);font-size:11.5px">需要宿主 ≥ 2.1</div></div>` },
  'special-card': { when: '侧栏入口卡(Historian / Muse / 微信远程):无边框扁平行,hover 才浮底、露出右侧箭头。', html: `<div style="width:230px;background:var(--sidebar-bg);padding:6px;border-radius:var(--radius-md)"><button class="special-card active"><div class="special-card-head"><span class="sc-icon">${ICON}</span><span class="sc-title">Muse · 灵感捕手</span><span class="sc-go">${svg('<path d="m9 18 6-6-6-6"/>', 13)}</span></div></button><button class="special-card"><div class="special-card-head"><span class="sc-icon">${ICON}</span><span class="sc-title">Historian · 记忆整理</span><span class="sc-go">${svg('<path d="m9 18 6-6-6-6"/>', 13)}</span></div></button></div>` },
  'empty-state': { when: '列表 / 视图的空态。图标 56px + .empty-title,整体 --text-faint,不要在空态里放主按钮以外的东西。', html: `<div class="empty-state" style="min-height:150px;width:100%">${svg('<circle cx="12" cy="12" r="9"/><path d="M8 15h8"/>', 40)}<div class="empty-title">还没有会话</div><button class="btn ghost sm">新建会话</button></div>` },
  sk: { when: '骨架屏。**新加载分支禁止写空白/转圈**,一律用 .sk;色底跟 --accent-rgb 自动适配明暗与配色。', html: `<div class="sk" style="height:150px;width:100%;max-width:420px"><div class="sk-b sk-title"></div><div class="sk-b"></div><div class="sk-b sk-thin"></div><div class="sk-gap"></div><div class="sk-b"></div><div class="sk-b sk-thin"></div></div>` },
  spin: { when: '进行中的原地旋转(0.9s 匀速)。等待时长不可知时配文案,别单独用。', html: `<span class="spin" style="display:inline-flex">${svg('<path d="M21 12a9 9 0 1 1-6.2-8.6"/>', 18)}</span>` },
  'thinking-block': { when: 'agent 思考过程折叠块:2px 左边线 + 缩进,不卡片化(它不是内容,是过程)。', html: `<div style="width:100%;max-width:480px"><button class="thinking-toggle">${svg('<path d="m6 9 6 6 6-6"/>', 13)} 思考了 4 秒</button><div class="thinking-block"><div class="thinking-content">先确认 CSS 里有没有 url(),没有就能裸 link…</div></div></div>` },
  'todo-row': { when: '计划 / 待办列表的一行。状态只由 .todo-mark 的 completed / in_progress / pending 表达。', html: `<div class="todo-rows" style="width:100%;max-width:420px"><div class="todo-row"><span class="todo-mark completed">${CHECK}</span><span>解析真源 CSS</span></div><div class="todo-row"><span class="todo-mark in_progress">${ICON}</span><span>渲染组件目录</span></div><div class="todo-row"><span class="todo-mark pending">${ICON}</span><span>写开发日志</span></div></div>` },
  modal: { when: '二级界面。固定尺寸(modal-sm 460 / modal-md 560 / 缺省 720),内容在 .modal-body 内滚动,切 tab 不跳高。外层遮罩 .u-backdrop 是 fixed,此处从略。', html: `<div class="modal" style="--modal-w:400px;--modal-h:210px"><div class="modal-head"><strong>设置</strong><span class="grow"></span><button class="icon-btn">${svg('<path d="M18 6 6 18M6 6l12 12"/>', 14)}</button></div><div class="modal-tabs"><button class="active">通用</button><button>外观</button><button>插件</button></div><div class="modal-body">内容在这里滚动。</div></div>` },
  'skin-chip': { when: '配色轴的选择芯片。选中态 = 细线 + 淡底(--sel-line / --sel-fill),不叠外圈 ring。', html: `<button class="skin-chip active"><span class="skin-dot" style="background:#f8f7f6"></span>经典</button><button class="skin-chip"><span class="skin-dot" style="background:#fbf5ef"></span>珊瑚</button><button class="skin-chip"><span class="skin-dot" style="background:#eef4f2"></span>青瓷</button>` },
  'conn-pill': { when: '连接 / 引擎状态药丸。状态只由 .dot 的 ok / err 变色表达,文字不重复说颜色。', html: `<span class="conn-pill ok"><span class="dot"></span>已连接</span><span class="conn-pill err"><span class="dot"></span>引擎未运行</span><span class="conn-pill"><span class="dot"></span>连接中</span>` },
  'attach-chip': { when: '输入区的附件芯片:缩略图 + 省略文件名 + 移除钮(hover 转 danger)。最大宽 200px。', html: `<span class="attach-chip"><span>DESIGN.md</span><button>${svg('<path d="M18 6 6 18M6 6l12 12"/>', 12)}</button></span>` },
  'tier-badge': { when: '会员等级徽章。**自身不带颜色** —— 由调用方按等级注入底/字色,所以任何配色下都不会串味。', html: `<span class="tier-badge" style="background:var(--accent-light);color:var(--accent-ink)">PRO</span><span class="tier-badge" style="background:var(--overlay-light);color:var(--text-muted)">FREE</span>` },
  'update-banner': { when: '应用内更新横幅:非侵入、可忽略,压在主界面顶部,不做成弹窗。', html: `<div class="update-banner" style="width:100%"><span>新版本 v2.1.0 可用</span><button class="btn primary sm">重启更新</button><button class="update-banner-x">×</button></div>` },
  'jump-bottom': { when: '「回到底」按钮。bottom 由 --t2-composer-h 单源算出 —— 改输入区高度必须同时想到它(check:chatside)。', html: `<button class="jump-bottom g-unfix">${svg('<path d="m6 9 6 6 6-6"/>', 14)}</button>` },
  'md-body': { when: 'markdown 排版的**唯一正典**(check:settingsui 钉住)。任何要渲染 markdown 的地方都套它,别另写一套字号行距。', html: `<div class="md-body" style="width:100%;max-width:520px"><h3>标题三</h3><p>正文段落,含<code>行内代码</code>与<a href="#">链接</a>。</p><ul><li>列表项一</li><li>列表项二</li></ul><blockquote>引用块。</blockquote><pre><code>npm run check:cssvar</code></pre></div>` },
  'panel-note': { when: '面板里的解释性小字(不是错误、不是提示条),12px + --text-faint。', html: `<div class="panel-note">改动会在下次启动后生效。</div>` },
};

// ── 主流程 ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const root = document.documentElement;

const state = { tab: 'comp', filter: 'all', q: '' };
const SKIN_LABEL = { cream: '经典', coral: '珊瑚', teal: '青瓷', lavender: '薰衣草', zhi: '知蓝', custom: '自定义' };
let SKIN_IDS = [];       // 从 skins.css 文本推,不硬编码
let FILES = [];          // [{name, label, sections}]
let CLASSES = new Map(); // class -> {rules, vars, files}
let TOKENS = new Map();  // --x -> Set(来源文件)
let DEMO_HOME = new Map(); // 实例只在「该类的定义处」出一次,免得一个 .btn 在 5 个分节里各画一遍

async function boot() {
  const all = [...document.querySelectorAll('link[data-label]')].map((l) => {
    const href = l.getAttribute('href');
    return { href, name: href.split('/').pop(), label: l.dataset.label, axis: l.dataset.axis || 'base' };
  });
  const grab = (href) => fetch(href).then((r) => { if (!r.ok) throw new Error(`${href} → HTTP ${r.status}`); return r.text(); });
  const [texts, themeTexts] = await Promise.all([
    Promise.all(all.map((s) => grab(s.href))),
    Promise.all(THEMES.map((t) => grab(`${t.dir}/theme.css`).catch(() => ''))),
  ]);

  const skinsIdx = all.findIndex((s) => s.axis === 'skin');
  SKIN_IDS = [...new Set([...(texts[skinsIdx] || '').matchAll(/data-skin=['"]([\w-]+)['"]/g)].map((m) => m[1]))];
  const AXIS = { skin: '配色', lang: '语言', base: '缺省' };   // 谁声明了这个 token(轴归属),标签要短,否则挤掉右边的值
  const addToken = (v, axis) => { if (!TOKENS.has(v)) TOKENS.set(v, new Set()); TOKENS.get(v).add(AXIS[axis]); };

  all.forEach((s, n) => {
    const sections = parseCss(texts[n]);
    if (s.axis !== 'skin') FILES.push({ ...s, sections });
    for (const sec of sections) for (const r of sec.rules) {
      for (const v of varsDeclared(r.body)) addToken(v, s.axis);
      if (s.axis === 'skin') continue;
      for (const c of new Set(classesIn(r.sel))) {
        if (!CLASSES.has(c)) CLASSES.set(c, { rules: [], vars: new Set(), files: new Set() });
        const e = CLASSES.get(c);
        e.rules.push({ ...r, file: s.name, section: sec.title });
        e.files.add(s.name);
        varsUsed(r.body).forEach((v) => e.vars.add(v));
      }
    }
  });
  // 主题 CSS 只抽 token:genesis-glass 的 --gl-* 档位只存在于它自己的 theme.css,
  // 不收就等于 token 面板永远看不到那八个可调项。
  let themeTokens = 0;
  for (const txt of themeTexts) for (const sec of parseCss(txt)) for (const r of sec.rules) {
    for (const v of varsDeclared(r.body)) { if (!TOKENS.has(v)) themeTokens++; addToken(v, 'lang'); }
  }

  for (const f of FILES) for (const [n, sec] of f.sections.entries()) for (const r of sec.rules) {
    for (const c of classesIn(r.sel)) {
      if (!DEMOS[c] || DEMO_HOME.has(c)) continue;
      if (new RegExp(`(^|,\\s*)\\.${c}(?![\\w-])`).test(r.sel)) DEMO_HOME.set(c, `${f.name}#${n}`);
    }
  }
  for (const c of Object.keys(DEMOS)) if (!DEMO_HOME.has(c) && CLASSES.has(c)) DEMO_HOME.set(c, `${CLASSES.get(c).rules[0].file}#?`);

  // 自检:解析器一坏就是满屏空白/半份目录,这里让它出声。
  // ⚠️ 写进 #g-alarm 而不是 #main —— 后者会被紧接着的 render() 覆盖掉(评审揪出来的:警告闪一下就没了)。
  const bad = [];
  if (CLASSES.size < 900) bad.push(`类名只解析出 ${CLASSES.size} 个(应 >900)`);
  if (TOKENS.size < 90) bad.push(`token 只解析出 ${TOKENS.size} 个(应 >90)`);
  if (FILES.some((f) => !f.sections.length)) bad.push(`有文件解析出 0 个分节:${FILES.filter((f) => !f.sections.length).map((f) => f.name).join(' ')}`);
  if (SKIN_IDS.length < 2) bad.push(`skins.css 只推出 ${SKIN_IDS.length} 个配色`);
  if (themeTexts.some((t) => !t)) bad.push('有 theme.css 没读到');
  if (bad.length) {
    $('g-alarm').innerHTML = `<div class="approval-card"><div class="approval-title">⚠️ 解析自检未通过 —— 下面的目录不完整</div><div class="approval-why">${esc(bad.join(';'))}<br>先跑 <code>node lcl/gallery/cssIndex.js</code> 定位。</div></div>`;
    console.error('[gallery] self-check failed', bad);
  }

  await mountThemes();
  mountAxes();
  render();
  $('g-sub').textContent = `真源 ${all.length} 份 CSS + ${THEMES.length} 份主题 · ${FILES.reduce((n, f) => n + f.sections.length, 0)} 个分节 · ${CLASSES.size} 个类 · ${TOKENS.size} 个 token(其中 ${themeTokens} 个仅主题声明)`;
}

/** 语言轴:每个主题一条 disabled <link>,切换即启停(与 desktop 的 theme/loader.ts 同机制)。 */
async function mountThemes() {
  for (const t of THEMES) {
    try {
      t.manifest = await fetch(`${t.dir}/theme.json`).then((r) => r.json());
    } catch { t.manifest = { name: t.id }; }
    // 先以 media=print 加载(下载但不作用于屏幕),onload 后转常规并按当前选择停用。
    // 直接 disabled 挂上去的话浏览器要等到启用那一刻才去取,首次切换会有一帧读到旧 token(token 面板会读到旧值)。
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${t.dir}/theme.css`;
    link.media = 'print';
    link.onload = link.onerror = (e) => {
      if (e.type === 'error') console.warn('[gallery] theme.css 加载失败', link.href);
      link.media = 'all';
      link.disabled = root.dataset.theme !== t.id;   // 期间用户可能已经切走了,以当前选择为准
      if (!link.disabled && state.tab === 'color') render();   // 生效才刷新:否则 token 面板停在旧值
    };
    document.head.appendChild(link);
    t.link = link;
    for (const fam of t.manifest?.fonts?.google || []) {
      const f = document.createElement('link');
      f.rel = 'stylesheet';
      f.href = `https://fonts.googleapis.com/css2?family=${fam.replace(/ /g, '+')}&display=swap`;
      document.head.appendChild(f);
    }
  }
}

function segify(el, items, get, set) {
  el.innerHTML = items.map((it) => `<button data-v="${esc(it.v)}" title="${esc(it.t || '')}">${esc(it.l)}</button>`).join('');
  const sync = () => [...el.children].forEach((b) => b.classList.toggle('active', b.dataset.v === String(get())));
  el.onclick = (e) => { const b = e.target.closest('button'); if (b) { set(b.dataset.v); sync(); } };
  sync();
}

function mountAxes() {
  segify($('ax-theme'), [{ v: '', l: '缺省' }, ...THEMES.map((t) => ({ v: t.id, l: (t.manifest?.name || t.id).split(' · ').pop(), t: t.manifest?.description || '' }))],
    () => root.dataset.theme || '', (v) => {
      THEMES.forEach((t) => { t.link.disabled = t.id !== v; });
      if (v) root.dataset.theme = v; else delete root.dataset.theme;
      if (state.tab === 'color') render();
    });

  segify($('ax-skin'), SKIN_IDS.map((id) => ({ v: id, l: SKIN_LABEL[id] || id })),
    () => root.dataset.skin, (v) => { root.dataset.skin = v; if (state.tab === 'color') render(); });

  segify($('ax-mode'), [{ v: 'light', l: '亮' }, { v: 'dark', l: '暗' }], () => root.dataset.mode, (v) => {
    root.dataset.mode = v;                       // 两处都要:skins.css 认 .dark,其余消费者认 data-mode
    root.classList.toggle('dark', v === 'dark');
    if (state.tab === 'color') render();
  });

  const toggle = (btn, on, off, init) => {
    let v = init;
    const sync = () => {
      btn.classList.toggle('on', v); btn.setAttribute('aria-checked', String(v)); (v ? on : off)();
      if (state.tab === 'color') render();   // 扁平会把三个阴影 token 清空,不重算面板就显示旧值
    };
    btn.onclick = () => { v = !v; sync(); };
    sync();
  };
  toggle($('ax-flat'), () => (root.dataset.flat = '1'), () => delete root.dataset.flat, false);
  toggle($('ax-glass'), () => delete root.dataset.glass, () => (root.dataset.glass = 'off'), true);

  segify($('ax-tab'), [{ v: 'comp', l: '组件' }, { v: 'color', l: '配色 / token' }], () => state.tab, (v) => { state.tab = v; render(); });
  segify($('ax-filter'), [{ v: 'all', l: '全部' }, { v: 'demo', l: '有实例' }, { v: 'todo', l: '未收录' }], () => state.filter, (v) => { state.filter = v; render(); });
  $('q').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); render(); };
}


// ── 渲染 ───────────────────────────────────────────────────────────────────
function render() { (state.tab === 'comp' ? renderComponents : renderTokens)(); }

const hit = (s) => !state.q || String(s).toLowerCase().includes(state.q);

function renderComponents() {
  const nav = [], out = [];
  let shown = 0, withDemo = 0;
  for (const f of FILES) {
    const navItems = [];
    for (const [n, sec] of f.sections.entries()) {
      const id = `s-${f.name.replace(/\W/g, '')}-${n}`;
      const cls = [...new Set(sec.rules.flatMap((r) => classesIn(r.sel)))].sort();
      const list = cls.filter((c) => {
        if (state.filter === 'demo' && !DEMOS[c]) return false;
        if (state.filter === 'todo' && DEMOS[c]) return false;
        return hit(c) || hit(sec.title) || hit(sec.doc);
      });
      if (!list.length) continue;
      shown += list.length;
      const demos = list.filter((c) => DEMO_HOME.get(c) === `${f.name}#${n}`);
      withDemo += demos.length;
      navItems.push(`<a href="#${id}">${esc(sec.title)} <span>${list.length}</span></a>`);
      out.push(`<section class="g-sec" id="${id}">
        <h3>${esc(sec.title)}<span class="g-src">${esc(f.name)}:${sec.line}</span></h3>
        ${sec.doc ? `<p class="g-doc">${esc(sec.doc)}</p>` : ''}
        ${demos.map((c) => demoBlock(c)).join('')}
        <div class="g-rows">${list.map((c) => classRow(c)).join('')}</div>
      </section>`);
    }
    if (navItems.length) nav.push(`<div class="g-nav-file">${esc(f.name)} · ${esc(f.label)}</div>${navItems.join('')}`);
  }
  $('nav').innerHTML = nav.join('') || '<div class="g-nav-file">无匹配</div>';
  $('main').innerHTML = out.join('') || '<div class="empty-state" style="min-height:200px"><div class="empty-title">没有匹配的组件</div></div>';
  const total = CLASSES.size, demoed = Object.keys(DEMOS).filter((c) => CLASSES.has(c)).length;
  $('g-stat').innerHTML = `CSS 共 <b>${total}</b> 类 · 已配实例 <b>${demoed}</b> · 未收录 <b>${total - demoed}</b>${state.q || state.filter !== 'all' ? ` · 当前筛出 ${shown}(含实例 ${withDemo})` : ''}`;
}

function demoBlock(c) {
  const d = DEMOS[c];
  return `<div class="g-demo">
    <div class="g-demo-head"><span class="g-demo-name">.${esc(c)}</span><span class="g-when">${esc(d.when)}</span></div>
    <div class="g-stage">${d.html}</div>
    <pre class="g-code">${esc(d.html)}</pre>
  </div>`;
}

function classRow(c) {
  const e = CLASSES.get(c);
  if (!e) return '';
  const doc = e.rules.find((r) => r.doc)?.doc || '';
  const vars = [...e.vars];
  const detail = e.rules.map((r) => `${esc(r.file)}:${r.line}  ${esc(r.sel)}`).join('\n')
    + (vars.length ? `\n\n消费 token:${esc(vars.join(' '))}` : '');
  return `<div class="g-row">
    <code>.${esc(c)}</code>
    <span class="g-tag${DEMOS[c] ? ' on' : ''}">${DEMOS[c] ? '有实例' : `${e.rules.length} 条规则`}</span>
    <span class="g-row-note">${esc(doc || vars.slice(0, 6).join(' '))}</span>
    <details><summary>详情</summary><div class="g-detail">${detail}</div></details>
  </div>`;
}

function renderTokens() {
  const cs = getComputedStyle(root);
  const fams = new Map();
  for (const [name, files] of [...TOKENS].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!hit(name)) continue;
    const fam = name.replace(/^--/, '').split('-')[0];
    if (!fams.has(fam)) fams.set(fam, []);
    fams.get(fam).push([name, files]);
  }
  const axisTag = (axes) => [...axes].join(' · ');
  const secs = [...fams].map(([fam, list]) => `<section class="g-sec">
    <h3>--${esc(fam)}-*<span class="g-src">${list.length} 个</span></h3>
    <div class="g-tokens">${list.map(([name, files]) => {
      const v = cs.getPropertyValue(name).trim();
      const isColor = v && CSS.supports('color', v);
      return `<div class="g-tok">
        <span class="g-sw">${isColor ? `<i style="background:${esc(v)}"></i>` : ''}</span>
        <code>${esc(name)}</code><em title="${esc(v)}">${esc(v || '(未定义)')}</em>
        <span class="g-axisof" title="声明来源:缺省=base/engine · 配色=skins.css · 语言=theme.css">${axisTag(files)}</span>
      </div>`;
    }).join('')}</div></section>`).join('');

  $('nav').innerHTML = `<div class="g-nav-file">token 家族</div>` + [...fams].map(([f, l]) => `<a href="#">--${esc(f)} <span>${l.length}</span></a>`).join('');
  $('main').innerHTML = `
    <section class="g-sec">
      <h3>双轴主题模型<span class="g-src">DESIGN.md §1–§3</span></h3>
      <p class="g-doc">观感 = 语言(data-theme,管**结构**:圆角/字体/阴影形态/间距)× 配色(data-skin,管**颜色**)。两套 token 不相交,故任意组合都成立 —— 语言块里出现颜色、或配色块里出现圆角,维护量就从 N+M 变成 N×M。
另有四个全局开关:明暗(data-mode + .dark)、扁平(data-flat)、毛玻璃(data-glass)、界面缩放(--uiz)。上方工具条即是这五个轴的实时开关。
下面的值全部来自 getComputedStyle —— 就是此刻这个组合的真实生效值,不是抄的;每个 token 右侧标着**谁声明了它**(缺省 = base/engine · 配色 = skins.css · 语言 = 各 theme.css)。</p>
      <p class="g-hint">当前:语言 <b>${esc(root.dataset.theme || '缺省(base.css :root)')}</b> · 配色 <b>${esc(root.dataset.skin)}</b> · <b>${root.dataset.mode === 'dark' ? '暗' : '亮'}</b>色 · 扁平 ${root.dataset.flat ? '开' : '关'} · 毛玻璃 ${root.dataset.glass === 'off' ? '关' : '开'}</p>
    </section>
    <section class="g-sec">
      <h3>层级语汇<span class="g-src">DESIGN.md §3</span></h3>
      <p class="g-doc">从下到上:舞台 → 外壳 → 面 → 纸 → 浮层。每层**只有一个元素上色**,上级容器一律透明,否则染色相乘、半透材质越叠越糊。</p>
      <div class="g-layer" style="background:var(--bg)">0 stage · --bg
        <div class="g-layer" style="background:var(--sidebar-bg);margin-top:8px">1–2 chrome / pane · --sidebar-bg
          <div class="g-layer" style="background:var(--bg-card);margin-top:8px">3 paper · --bg-card(正文永不透背景)
            <div class="g-layer" style="background:var(--bg-glass);backdrop-filter:var(--panel-blur);border:var(--border-width) solid var(--border);margin-top:8px">3.5–4 thin / float · --bg-glass + --panel-blur</div>
          </div>
        </div>
      </div>
      <p class="g-hint">⚠️ genesis-glass 的外壳玻璃来自 macOS 原生窗口材质,浏览器里只呈现半透染色(DESIGN.md §4),此处看到的不是桌面端的最终观感。</p>
    </section>` + secs;
  $('g-stat').innerHTML = `token 共 <b>${TOKENS.size}</b> 个 · ${fams.size} 个家族`;
}

boot().catch((e) => {
  $('main').innerHTML = `<div class="approval-card"><div class="approval-title">读取真源 CSS 失败</div><div class="approval-why">${esc(e.message)}<br>本页必须经 HTTP 打开(file:// 会被 CORS 拦)。在 Forsion-Genesis/ 下跑 <code>npm run gallery</code>(或 <code>python3 -m http.server 8100 --directory Forsion-Genesis</code>),再开 http://localhost:8100/lcl/gallery/</div></div>`;
});
