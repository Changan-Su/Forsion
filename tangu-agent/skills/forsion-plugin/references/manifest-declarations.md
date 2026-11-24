# Manifest declarations: onboarding.requires, requiresPlugins, bilingual labels and icons, guide, widgets

Moved out of SKILL.md (2026-11-23) verbatim.

**Where "见下 / 见上 / below" pointers in this file land** (the sections moved apart on 2026-11-23): Selection bar, View modes, Tooltips, Drop indicators, Host parts, Settings parts, dashboard, `ctx.table.mount` → `host-ui-mounts.md`; 没有活动库, 外观开关, dispose 契约, 自绘浮层, pointer math → `view-runtime-rules.md`; 只读全库查询, onVaultEvent, 二进制资源, working folder, Templates and new notes → `vault-and-assets.md`; 前置条件 / onboarding.requires, requiresPlugins, 双语与图标, 上手提示 / guide, 主页小组件 / widgets → `manifest-declarations.md`; 统一左栏列表源, Floating Panel, Startup appearance, 共享账号, Whiteboard, Chat Box, LCL layout → `more-host-apis.md`; 当前模型, Agent 状态 / 名册, 开新对话, Agent Desk, 摘要栏, 自动化 → `tangu-host-apis.md`; 日历叠加源 → `calendar-overlays.md`; 日历 / 待办其余入口 → `calendar-todo-entries.md`; Space 与 Ribbon, 主页宿主件 → `spaces-and-home.md`; 全库多维表与笔记任务 → `databases-note-tasks.md`; 编辑器 / loadData / 块表面 → `note-editor-surfaces.md`; Tool result cards, Process-row sentences → `tool-cards.md`; where a surface's data comes from → `host-data-sources.md`. All in `references/`.

### 前置条件:onboarding.requires(2026-09-21 起)

1. **只为「不做就不工作」的东西写 `requires`**:没填的地址 / 令牌、没给的系统授权、服务端没配的依赖。
   用法说明写 `steps` / README。**不写励志句、营销句**;`intro` 一句话说清要做什么才能用,没有就不写。
2. 有 `requires` = **闸**:宿主实测,有 `unmet` 才弹检查卡 / 挂「待引导」/ 投一次 Inbox。没有 `requires` =
   **使用说明**:只在详情页里折叠展示,不弹不挂不提醒。**没有「完成设置」按钮,`__setupDone` 已废**,别读写它。
3. 只有三类,**里面不放文案**:
   - `{ "kind": "setting", "key": "serverUrl" }` —— key 必须 `registerSetting` 过(否则永远「无法检查」);
     判据 = localStorage `plugin.<id>.<key>` trim 后非空**且 ≠ `default`**,所以必填项 `default` 写 `''`,别写能用的默认值或示例值。
   - `{ "kind": "permission", "id": "microphone" }` —— id 只能是 `computerAccessibility` / `computerScreen` / `microphone` / `camera` / `screen`。
   - `{ "kind": "check", "id": "server-ready" }` —— 配套 `ctx.registerReadiness?.({ id, label, check })`,**必须可选链**(旧宿主没有这个方法)。
     `label` 是字符串或 `() => string`,按 `ctx.getLocale?.()` 给中英。
4. `check()` 返回 `'ok' | 'unmet' | 'unknown'` 或 `{ state, detail }`(`detail` 用户可见 → 中英两份)。
   **拿不准一律 `'unknown'`**:离线、未登录、本端没有 `window.tangu`、探测出错、HTTP 失败说不清原因。
   只有**确认**没配才回 `'unmet'` —— unknown 永远不算未满足,宿主不拿它催用户。
5. `check` 只在用户打开检查卡 / 点「重新检查」/ 手动启用 / 商店装完时被调,**启动期不调**,8 秒超时按 unknown。
   别在里面做重活,也别指望它在后台跑。
6. key / id 须匹配 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`,≤8 条;坏条目被 `sanitizeOnboarding` **静默丢弃**
   (全丢光闸就退化成说明,不报错)。英文走 `onboarding.en.intro` / `onboarding.en.steps`(与 `steps` 按下标对齐)。
   在 Forsion 仓里时,改完 manifest 用宿主真消毒器验一遍(命令见正典文档「前置条件与使用说明」节)。

范例:`samples/forsion-sample-bundle/`(setting 类 + `check.mjs` 断言 requires 的 key 都注册过)。

### 前置插件 requiresPlugins 与生命周期(2026-10-02 起)

- manifest `"requiresPlugins": ["other-id", { "id": "x", "minVersion": "1.2.0", "market": "x-slug", "name": "X" }]`(≤8 条;
  `market` = 商店 installSlug,新上架的条目是 `market-<商店 ID>`;`name` = 前置没装时显示的名字)。
  **想让用户一键装上前置,就写 `market`(2026-10-30 起)**:用户在商店装完依赖方后,提示条和详情页给「安装前置插件」,前置自己缺的也一路装完,装好依赖方自动开始运行。
  宿主只按 slug 精确对上商店条目:先 `market`,再 `id`(老条目 slug = manifest id 时才对得上),绝不按显示名猜。对不上时界面写「商店里没有」,
  留「在商店中查找」,所以前置是新上架的条目却不写 `market`,用户就只能自己搜。只有 Forsion 插件的前置支持;引擎插件 `tangu-plugin.json` 里的 `market` 不生效,
  装之前商店也看不到你的前置。设置页「在商店中查找」同样拿 `market` 预填搜索。
  前置算齐 ⇔ 已安装、没被门禁挡、版本 ≥ `minVersion`、**正在运行**。没齐时:用户关着 → 开关灰掉开不了;用户开着 → 「等待前置插件」,
  前置就位自动激活;前置停用 / 卸载 → 自动暂停(依赖方先停),回来自动恢复。互相依赖成环的永不激活。
- 前置的意思是「我要它注册的东西在」(视图 / 命令 / 文件类型),**不是**「我能 import 它」—— 插件之间仍然不直接互调。
- **宿主替你记账**:经 ctx 登记的一切(订阅、挂载、字体、主题样式、编辑器扩展、属性类型、伴随面、在飞的 `complete`……)在停用 / 重载 /
  setup 失败时由宿主按相反顺序撤掉,详情页「运行占用」列着此刻挂了什么。你自己起的 `setInterval` / `addEventListener` 宿主看不见 ——
  仍然要在返回的 disposer 里清。
- **async setup**:可以 `return` 一个 promise。同步那段返回即算启用;resolve 出的函数就是 disposer(那时已被停用 / 重载 → 宿主当场调用它);
  reject 与同步抛错同一处理 —— 回滚已登记的一切、详情页显示「加载失败」、依赖它的插件跟着暂停,直到用户重开或重载。
  停用之后 await 醒来再 `register*` 一律作废(拿到空操作)。

### 双语与图标

- `ctx.getLocale()` 取初值 + `ctx.subscribeLocale(cb)` 只报变化。判定 = **切语言时视图不重挂也要变**;
  但整树重建会吃掉用户没提交的输入 —— 重建前快照、重建后回填。
- ⚠️`t()` 的占位符替换**必须单趟正则**:`s.replace(/\{(\w+)\}/g, (m,k)=> (k in vars ? String(vars[k]) : m))`。
  逐个 `split('{k}').join(v)` 会让先替进去的值被后面轮次再吃一遍(用户把卡组命名成 `{n}` → 自己的数据被当占位符)。
- ⚠️**会落盘的兜底默认名(文件名、frontmatter 值)一律钉死中文常量,不许取 `t()`** —— 否则英文界面建出来的
  文件名与中文界面对不上,同一个库里冒出两套。
- **slash 项的 `label` / `group` 可以传函数**(`label: () => t('…')`,2026-09-28 起):宿主每次渲染 slash 菜单时求值,
  切语言即时跟上 —— 传字符串会定格在注册那一刻(首次启动的 IP 语言校正还发生在插件 setup 之后)。
  其余贡献点的**标题仍是注册时的单字符串**(命令 title / view title / setting label / 成就标题),
  宿主不做运行时重解析 → 切语言要等重启。**不许**用「语言变了就 teardown 重注册」绕(会打断录音、写队列、已开的视图)。
- `icon` 一律写宿主词表里的名字(`'template'` / `'pin'` / `'callout-warning'`…),**别塞 emoji** ——
  命中词表宿主就画和内置项同一套 SVG。全表见正典文档「图标」节与 `components/icons` 的 `PLUGIN_ICONS`;
  ⚠️词表键全是 `[a-z0-9-]`,只增不改不删。


### 上手提示:manifest `guide`(2026-11-02 起)

用户**用到**某个功能时宿主替你提示一次怎么用,用过(或点了知道了)就不再出。不是开机连播,不是闸。

```json
"guide": { "tips": [{
  "id": "drag-to-calendar", "at": "todo-row", "style": "ring", "platform": "desktop",
  "when": { "visible": ["calendar-grid"] }, "done": ["todo.schedule"],
  "title": "拖到日历上排时间", "text": "按住这条待办拖进日历的时间格，就排成那半小时。",
  "en": { "title": "Drag onto the calendar to schedule", "text": "Drop it on a time slot to book half an hour." }
}] }
```

- `at` = 你自己 View 里 `data-guide-anchor` 的名字(宿主只在你的 View 宿主节点 `[data-guide-owner=<插件 id>]` 里找,跟别的插件撞不了);它在屏幕上提示才可能出。
- `style`:`line` 贴锚点上沿一行(输入框);`ring` 圈 + 小卡,**必须有 `title`**。
- `when` 只取一种:`{ open: <View id>, times }` / `{ count: <事件>, atLeast }` / `{ visible: [锚点…] }`;**不写 = 只在 `ctx.guide.show(id)` 时出**。写了但认不出的 `when` → 整条丢(不降级成手动)。
- `done`:任一计数 ≥ 1 = 会了,永不再出;计数就是 `ctx.achievements.track(<事件>)`,在用户**真做了那件事**的地方报(别在点开菜单时报)。裸名 = 自己的事件;`app:` 前缀 = 宿主官方事件。
- `platform`:`desktop` / `mobile`;拖动、悬停、快捷键类写 `desktop`。
- 文案 = 中文 + `en` 镜像;**英文界面缺 `en` 的那条不出**(不回落中文)。标题 ≤ 16 字、正文 ≤ 40 字。id `^[a-z0-9][a-z0-9-]{0,47}$`,最多 12 条,坏的那条单独丢。
- 宿主的节奏(作者不用管):全应用同一时刻一处(和 spotlight 共用槽)、一天 3 条、锚点出现 2 秒后、停手 1.5 秒后、一个 View 打开一次最多一条、有弹窗在排 / 首启向导开着时等。看过 / 不再提示只记本机;设置 → 通知 →「上手提示」可关、可重置;命令面板「重置上手提示」。
- **新版本加功能 = 加一条新 id 的提示**:记账按「插件 id + 提示 id」,老用户升级后用到时会看到;别改旧提示的 id。
- 例句:空着时用 `ctx.ui.mountEmptyState(el, { …, examples: [{ label, note?, run }] })`,`run` 把句子填进输入框让用户自己发。
- 能靠界面自己说清的不发提示(「+ 子任务 Tab」那一行、输入框占位里的「支持明天下午3点」)。只给看不见的手势、快捷写法、跨两个 View 的操作发。
- 自测:命令面板「重置上手提示」+ `ctx.guide.show(id)`;不出时先查元素带没带 `data-guide-anchor`、是不是在你自己的 View 里。台架范本:Genesis `desktop/scripts/guide-tips.check.cjs`。
- 旧宿主不认 `guide`,什么都不出;`ctx.guide?.`。

### 主页小组件:manifest `widgets` + `ctx.widgets`(2026-11-07 起)

主页左右栏 / 下排能放插件的卡。卡长什么样声明在 manifest(宿主画,和内置「收件箱」「最近笔记」同一套行样式),数据由插件喂;**只读**,点卡头 / 点行打开声明的 Space。不开 DOM 挂载。

```json
// manifest.json
"widgets": ["widgets/today", "widgets/todo"]
// widgets/today/manifest.json(和 Agent 做的小组件同一种目录)
{ "schemaVersion": 1, "id": "today", "title": "今天", "titleEn": "Today", "summary": "…", "summaryEn": "…", "layout": "list", "icon": "date", "space": "calendar" }
```

- `id` `^[a-z0-9][a-z0-9-]{0,47}$`,插件内唯一;主页摆放里存 `plugin:<插件 id>/<id>`(摆放只在本机)。`title` 必填,`titleEn` 英文界面用。`layout` 这一版只认 `"list"`(别的整张丢)。
- `icon` = 插件图标词表里的名字(同 `registerView` 的 `icon`:`date` / `todo` / `cloud` …),没写用插件 icon.png。`space` = 点了打开的 Space id,不写不跳。目录只认插件根里的相对路径,最多 8 张,坏的那张单独丢。
- 停用 → 卡上留「已停用」占位 + 启用按钮;卸载 / 旧版没声明这张 → 不画、不占位(摆放留着)。

```js
ctx.widgets?.provide('today', async (_params, { signal }) => ({
  rows: [{ id, title, time, meta, tone: 'accent' | 'warn' | 'muted', done, now, group }],
  footer, empty,
}))
ctx.widgets?.invalidate('today') // 不给 id = 你的全部卡
```

- 返回行的数组或 `{ rows, footer?, empty? }`;每行 `title` 必填,`time` 左列,`meta` 右边小字(`tone` 上色),有 `done` 字段就画勾选框(只读,`true` 划线),`now` 实心点,`group` 变了画小标题。最多 50 行;文字按 `ctx.getLocale()` 给好(宿主切语言会重拿)。
- 宿主什么时候来要:卡挂上、你 `invalidate`、窗口回前台(距上次 ≥30 秒)。同一张同一时刻一次,新的一次 abort 旧的 `signal`;**10 秒没回 / 抛错 = 卡上写「暂时读不到」,不当成空**(数据还没准备好就抛,别回空数组)。
- `provide` 的 `id` 必须是 manifest 里声明过的,否则忽略并在控制台警告。停用 / 重载宿主统一撤。
- 卡不在主页上宿主就不来要 → **别在外面常驻轮询**;要按时间变的文字(「还有 1 小时」)就在被要过之后自己定时 `invalidate`,几分钟没被要就停(范本:Forsion-Calendar `src/widgets.ts`)。
- 台架范本:Genesis `desktop/scripts/home-widgets.check.cjs`(临时家目录装好插件 → 主页右栏、收纳面板、窄窗图标条)。
- 旧宿主不认 `widgets`、没有 `ctx.widgets`:一律 `?.`,不用抬 `minAppVersion`。
