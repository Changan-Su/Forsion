---
name: forsion-extension-development
description: 当用户要给 Forsion / Tangu 做插件、主题、Space、智能体(agent)或捆绑包(bundle)——或要把某个能力做成可分发/可上架市场的扩展——时使用。内置五类官方模板(samples/),讲清各自的格式基线与硬约束(尤其两种"插件"是完全不同的系统),照抄模板改比从零写靠谱。
metadata:
  version: 1.19.0
  author: Forsion
  category: Forsion
---

# Forsion 扩展开发

Forsion / Tangu 的扩展**默认按捆绑包(bundle)形态发行**(2026-07-25 起口径):一个 Forsion 插件目录内嵌 UI / 引擎插件 / Agent / 技能 / Space,装一处全就位 —— 哪怕当下只有一类内容,bundle 布局也让之后追加其它层零迁移。四类单体形态仍完整支持、互不影响(纯数据内容如主题、单个 Space 可以更轻)。每类都有一份官方模板放在本技能的 `samples/` 下 —— **先复制对应模板再改**,别从零搭。

| 类型 | 是什么 | 模板 | 最小产物 |
|------|--------|------|----------|
| **捆绑包(默认起点)** | 一个 Forsion 插件内嵌引擎插件/Agent/技能/Space | `samples/forsion-sample-bundle/` | `manifest.json` + 约定子目录 |
| **引擎插件** | 给 agent 加工具 / 设置 / 提示片段 | `samples/forsion-sample-plugin/` | `tangu-plugin.json` + `dist/index.js` |
| **主题** | 换 UI 结构+配色(纯数据) | `samples/forsion-sample-theme/` | `theme.json` + `theme.css` |
| **Space** | 视图布局配方(纯数据) | `samples/forsion-sample-space/` | `space.json` |
| **智能体** | 预设人设+记忆+技能的 agent | `samples/forsion-sample-agent/` | `config.toml` + `SOUL.md` |

> ⚠️ "插件"有**两个互不相干的系统**,先分清用户要哪个:
> - **引擎插件**(本技能 `samples/forsion-sample-plugin`):后端/Agent 层,`tangu-plugin.json` + `activate(ctx)`,给模型加工具。
> - **Amadeus/Forsion 桌面插件**:UI 层,`manifest.json` + 裸 `main.js`(宿主 `new Function('ctx', code)` 跑 —— **文件本身就是 `setup(ctx)` 的函数体**,顶层直接 `ctx.registerView(…)`;别包成 `function setup(ctx) { … }`,没人调用它 = 零注册、零报错),加命令/斜杠项/视图/文件类型。桌面端 设置 → 插件 有一键脚手架(hello-amadeus);捆绑包模板的根即这一形态。
> 要"一套功能跨两层发行"(UI+工具+Agent+Space)时,用**捆绑包**把它们装进一个目录。

## 通用纪律

1. **先有动机再做**:每个扩展要能指回一条真实痛点,说不出就别做。
2. **注入模型的文本一律英文**:工具 `description`、参数说明、promptSection —— 给模型读的全英文;用户可见字段用 `name`/`nameEn`、`description`/`descriptionEn` 双语镜像。
3. **id 全局唯一、kebab-case**:命令/斜杠/工具 id 处于全局命名空间,裸名会互相顶掉;主题 id **就是** `data-theme` 值,更要独一无二。
4. **交付=能跑+能回归**:非平凡逻辑留一个 `check.mjs`(`node check.mjs` 一条命令),范式见 `forsion-plugin-mindmap` / activitywatch 的 check 模式。
5. **动作性能力住引擎侧,渲染端命令只做导航**(2026-08-24 拍板):注册任何入口前先问一句——这是**导航**(开视图/切面板)还是**动作**(带参数、可 headless 完成的活,比如「分析这条链接」)?动作**不要**做成命令面板命令:`Command.run(): void` 类型上就没有参数位,而且命令表活在渲染进程,聊天 agent 与自动化都够不着。正确做法=把能力做成捆绑包的**引擎侧资产**,零通道基建。**先选对形态**:靠引擎已有工具就能复现的动作 → 包根 `skills/<slug>/SKILL.md`(**全局技能,默认选它**,进所有 agent 的技能目录,`use_skill` 直接用);要专属人设 / 独立上下文预算 / 稳定的自动化入口 → 才建 `agents/<slug>/` 具名 agent(+ 它自己的 `skills/`),聊天 agent 经 `delegate(agentSlug)`、自动化经 `agent_run` 调用(⚠️`agent_run` **必须指名 agentSlug**,只发全局技能的 bundle 靠被指名的那个 agent 身上带着这份技能来够到)。需要桌面主进程能力时引擎侧已有桥工具(如 `transcribe_audio` 语音转写)。范式=青鸟收藏夹:工作台 UI 归渲染端插件,分析管线归 bundle 内嵌的 `bluebird` agent+技能,两个入口(人点工作台 / agent 委派)共用同一条引擎管线。

## 引擎插件(samples/forsion-sample-plugin)

三个常用贡献点:工具(`sample_greet`)、设置 schema(`text`/`toggle`,设置页通用渲染)、`promptSection`(启用时注入系统提示)。硬约束:

- **绝不运行时 import 核心包**。对 `@forsion/tangu-agent` 只允许 `import type`(模板 tsconfig 开了 `verbatimModuleSyntax`,值导入直接编译错误)。运行时能力全走 `activate(ctx)` 的 **`ctx.sdk`** —— 否则核心的模块级单例被复制成第二份,行为诡异。
- **`dist/` 必须提交**。市场安装 = 解压源码到 `~/.forsion/plugins/<id>/`,全程不构建;改 `src/` 后必须 `npm run build`(tsc→dist/)再提交。
- **工具门禁**:`isEnabledFor` 返回 `store.isPluginEnabledSync(id)`,插件启用才对模型可见。
- **生命周期**:关掉插件时宿主调 `deactivate()`(限时 5s)并撤掉它注册的工具 / 命令 / 路由(meta 留着,设置页照样列出);再打开会在**同一个模块对象**上再调一次 `activate(ctx)`。所以 activate 可能跑多次 —— 别依赖模块级「只做一次」的状态,activate 里起的定时器 / 子进程 / 监听(含 `process.once`)一律在 deactivate 里收掉。
- **限时**:import + `activate` 合计限时 30s,超时按激活失败处理(设置页显示错因);超时的 `activate` / `deactivate` 宿主不会再等,但在它真正结束前**不会**再激活同一个插件(防止迟到的收尾清掉新实例),结束后自动补上。activate 里别等永远不回的连接 —— 连不上就先返回、后台重试。
- **工具 provider id 用自己的命名空间**(`plugin:<你的 id>`):两个插件撞了同一个 id,后注册的覆盖前者。
- **前置插件**:manifest `"requiresPlugins": ["other-id", { "id": "x", "minVersion": "1.2.0" }]`。前置没装 / 版本低 / 关着 / 没在跑时本插件休眠(列出但不运行),前置就位后自动激活;互相依赖成环的永不激活。
- 类型契约 `types/tangu-agent.d.ts` 是 apiVersion 1 的 API 拷贝,随模板分发;宿主升 apiVersion 时替换它并同步 manifest 的 `apiVersion`。

装本机:整夹拷到 `~/.forsion/plugins/<id>/` → 设置页重扫即生效,不用重启。同 id 覆盖升级也是重扫即热换代:单文件入口(esbuild 打成一个 bundle,推荐)直接换;多文件的**纯 ESM** 包(`"type": "module"`,入口相对 import 同包文件)在 Node ≥ 22.15 上也能整包换代。宿主证明不了整张模块图都会换代的,如实标「需重启」:包里有 CommonJS(`.cjs`、`require('./x')`、`createRequire` 造的函数)、原生 `.node`、任一层自带 `node_modules`、软链、`import(变量)`、引到插件目录外的文件,或运行时太旧。同一进程里热换代满 20 次后也一律「需重启」(旧模块卸不掉,省内存)。

## 主题(samples/forsion-sample-theme)

双轴模型:**语言(结构:圆角/字体/阴影/布局)× 配色(颜色)× 明暗**。磁盘主题装 `~/.forsion/themes/<id>/`,**目录名必须 == id**。

- 主题 CSS 是**全局注入**(非隔离),因此**每条规则都要 scope 在 `[data-theme='<id>']` 下**,否则污染其它主题。
- **不要硬编码颜色**:配色由 skin 提供,主题只定结构,消费 `var(--bg)`/`var(--text)`/`var(--accent)` 等词表 token —— 这样任意配色/明暗都成立。
- 可选 `settings[]`(number/select/boolean/color)让用户在设置页调主题内参数:`key` **就是** CSS 自定义属性名,宿主把值写进 `:root` 内联变量,主题用 `var(--key, 默认值)` 消费。参考本仓内置 `genesis-glass` 主题(`desktop/frontend/src/theme/themes/genesis-glass/`)。

## Space(samples/forsion-sample-space)

`space.json` 声明视图布局配方(引用视图类型 id;插件视图用 `plugin:<插件id>:<视图id>` 并在 `requires.views` 声明)。纯数据,无代码。

### 图标:`icon` + `iconFile`(2026-10-04 起)

图标库只有 28 枚,几个 Space 一多就撞图标。给 Space 配一枚自己的图:

```json
{ "icon": "video", "iconFile": "icon.png" }
```

- `icon`:宿主图标库里的名字(全表见 `samples/forsion-sample-space/README.md`),不认识的回落方块。
- `iconFile`:一枚图片的**裸文件名**(`.png` / `.svg`,不能带路径)。宿主先在 Space 自己的目录里找;插件内嵌的 Space 找不到,再到**插件包根**找。
  所以 `"iconFile": "icon.png"` 而 Space 目录里不放图 = **直接用插件图标**;想单独画一枚,就把图放进 `spaces/<slug>/`。
  - **PNG**:原色显示。和插件图标同一道门禁:正方形、边长 64~512 像素、≤256KB。
  - **SVG**:只取轮廓,颜色跟随主题和选中态(≤64KB)。照 Ribbon 线形图标的规格画最协调:`viewBox="0 0 24 24"`、2px 描边、不填充。SVG 里写的颜色不生效,要彩色用 PNG。
- **两个都写**。老宿主不认 `iconFile`;文件缺失或不合规时也退到 `icon`。
- 只换图标**不要**升 `space.json` 的 `version` —— 那个版本号一变,宿主会丢掉用户保存的布局。升插件 `manifest.json` 的版本即可,图标随插件更新自动换。
- 宿主只把图当图片显示(`<img>` / CSS mask),SVG 里的脚本、外链都不会执行,也别指望它们。

### 布局:原生 Panel 优先(2026-10-02 起规)

插件视图**先摆进宿主的原生 Panel**,别在一个 view 里自造侧栏、底栏、分栏 —— 原生 Panel 自带标签、拖宽、折叠、
mod+J、布局记忆和移动端抽屉,自造的一样都没有,还和别的 Space 长得不一样。按内容找位置:

| 内容 | 放哪 | 怎么写 |
|---|---|---|
| 可打开项的列表(工程、收藏、会话) | 左栏统一工作区 | `registerListSource` + `layout.left: [{ "type": "workspace", "params": { "mode": "plugin:<id>:<列表源>" } }]` |
| 主体(编辑器、播放器、详情) | 主区 | `layout.main`;要并排的另一份原生视图(笔记、聊天)用 `split: "right" / "down"` 分栏 |
| 随选中对象变的属性 / 检查器 | 右栏 | 长驻内容写 `layout.right`;跟着主视图走的面板用 Extend View(`view.extendView.open({ side: 'right' })`) |
| 横跨全片的时间线、日志、控制台、终端 | 底部面板 | `layout.bottom`(2026-10-02 起)或 `ctx.openView(id, { location: 'bottom' })` |

- 范例:**青鸟收藏夹**(左 = 收藏夹列表源;主区 = 详情 + 原生笔记 `split: "right"` + 原生聊天 `split: "down"`)、
  **视频工作室**(左 = 工程列表;主区 = 舞台与走带;右 = 属性 Extend View;底部 = 时间线)。
- **一份状态,多个 view**:主区和底部是两个 `registerView`,同一窗口里共用插件模块里的那份状态,别各存一份。
  拆不开的 DOM 可以整块搬进另一个 view 的 `el`(事件监听跟着走),样式随之注入。
- ⚠️ **iframe 一搬就重新加载**,而宿主开合底部面板会把主区整列摘下重挂 —— 主区里的 iframe 同样重载。
  靠 postMessage 驱动的预览要在帧**每次**报告就绪时把时间、播放状态补发回去,不能只听第一次(否则画面一直是黑的)。
- **先 feature-detect 再依赖**:旧宿主静默忽略 `layout.bottom`;旧桌面宿主把 `openView(id, { location: 'bottom' })`
  当主区打开,会把当前主视图导航走。查 `ctx.viewLocations?.includes('bottom')`(移动端没有底部面板,不含它)。
  主视图让出内容的判据 = 配方传给它的参数(如 `{ "timeline": "bottom" }`)**且** `viewLocations` 含 bottom;任一不满足就在 view 内自绘。
- 配方里写了 `layout.bottom` 就**默认展开**;用户收起后 mod+J 照配方开回来(关掉最后一个标签也一样)。
- 底部横跨哪几列用 `layout.bottomSpan`:缺省 `right`(主区+右栏,左栏满高)/ `left`(左栏+主区,右栏满高)/ `full`(通栏)/ `main`(只在主区下方,左右栏都满高)。时间线要通栏就写 `full`;旧宿主忽略该字段、按缺省摆。
  改了 `layout` 要**抬 `version`**,否则用过这个 Space 的人永远停在旧布局。
- **启动布局 → 项目布局(照 Coding Studio,2026-10-02 起插件可做)**:没打开项目时左栏是项目导航、主区是启动台,
  底部收起;打开项目后左栏换成项目自己的内容(素材、对话),底部开出时间线 / 终端。换法:
  `ctx.replaceView?.('nav', 'media')` —— 只换自己的视图,**原地**换(同一块面板、尺寸不变、不重建布局,所以主区
  里的 iframe 不会重载);面板收着就只换暂存、保持收着;Space 的面板默认值跟着换。回到启动台反过来换,再
  `ctx.closeView?.('timeline')` 收起底部(关掉底部最后一个视图 = 面板收起,与用户点 × 一样)。返回 0 = 那个视图
  哪儿都没开着(用户关了它,或布局已经是项目态):**别**拿 `openView` 兜底 —— 它会把用户收起的面板弹出来。
  旧宿主没有这两个方法:左栏就一直是导航(视频工作室这么做:旧宿主上没有素材区,时间线仍画在编辑器里);
  非要内容就 `openView(id, { location: 'left' })` 多开一个标签,底部不动。
  ⚠️ 进出项目的布局跳转会让宿主重挂主区那一列(主区视图卸载再挂上;10-02 真 Electron 实测进、出各一次,⌘J 开合
  不会)。两条后果:① 跨这一下要留的临时状态(新建页里填的想法、刚选的模板)放模块作用域,**等用户真正用掉
  (发送 / 清空)才清** —— 别在第一次交给界面时就清,即将被卸掉的那一份可能先拿到;② 关项目时,新挂上的那份
  会按「参数里的文件 → 模块里的当前项 → 存盘的上次打开」找项目:先把这三样清干净(存盘那步要 await)再拆界面、
  换布局,否则它会把刚关的项目又打开。
  范例:视频工作室(导航 ↔ 素材,底部时间线随项目开合;仪器 `npm run verify:docked`)。

### Mini Panel 适配

Space 需要显式声明 `mini` 才会出现在 Mini Panel。它是一块扩展面板：默认 320×420，单层宿主栏提供 Space 切换、在主面板显示、关闭；只设计本能力的快捷交互，不复制应用导航、设置、标签管理或移动端抽屉。

Computer Use 占用外部应用前台时，宿主可临时打开 Tangu Mini 观察当前运行会话，无需用户先打开 Mini。自动窗口的焦点、跟随、会话同步与收起由宿主管理，不覆盖手动 Mini 的状态；插件无需监听前台信号或新增适配字段。

```json
"mini": {
  "name": { "zh": "快捷记录", "en": "Quick capture" },
  "view": { "type": "plugin:my-bundle:quick", "params": { "itemId": "today" } },
  "mainView": { "type": "plugin:my-bundle:detail" }
}
```

- `view` 与 `mainView` 都是 `{type, params?}`；必须使用**不同的已注册视图类型**。缺少适配或视图未注册时不显示在 Mini 中，完整 Space 仍可用。不要把可选 Mini 类型放进 `requires.views`，否则旧宿主会拒绝整个配方。
- 在 `mount(el, view)` 中用 `view.surface === 'mini'` 识别容器；老宿主这些字段可缺省。Mini 不提供 `extendView`。
- `view.getParams()` 读当前实体/筛选参数，`view.setParams(patch)` 合并更新，`view.onParamsChanged(fn)` 订阅后返回取消函数。参数更新不重挂 DOM；自己更新需要变化的内容，避免丢失正在输入的草稿。
- `view.showInMainPanel?.()` 打开 `mini.mainView`，同一份当前参数覆盖 `mainView.params`。两边使用相同实体键（如 `itemId`/`notePath`），不要另建一份业务数据。宿主顶部已有按钮，不必重复绘制。
- `mount` 返回清理函数，停止订阅/计时器并保存必要内容。旧实例的 context 在关闭、切换 Space 或禁用后失效，异步回调不得继续调用。
- 按中英、亮暗、320×420、实体定位与插件启停验证。参考捆绑包模板的 `mini-counter` / `counter` 视图及 `spaces/sample-bundle-mini/space.json`；Genesis 回归命令为 `desktop` 下 `npm run check:minicard`。

插件只有一块快捷视图、不值得为它建完整 Space 时，直接调用开放接口：

```js
ctx.openMiniPanel?.('mini-counter', {
  title: 'Counter', params: { itemId: 'today' },
  mainViewId: 'counter', mainViewParams: { section: 'inbox' },
})
```

`viewId` / `mainViewId` 都写**本插件相对 id**，宿主自动加 `plugin:<pluginId>:`，省略 `mainViewId` 就把同一视图交回主面板。仍须先 `registerView`；Web/mobile 或旧宿主可能没有原生 Mini，务必可选链并保留 `ctx.openView()` 回退。

## 智能体(samples/forsion-sample-agent)

文件夹式:`config.toml`(模型/工具/技能开关)+ `SOUL.md`(人设,英文写给模型)+ `Library/`(参考资料)+ 每-agent 记忆。装 `~/.forsion/agents/<slug>/`。

## 捆绑包(samples/forsion-sample-bundle)—— 默认起点

**新扩展默认从这个模板起步**:除非明确只做主题或单个纯数据 Space/智能体,插件类工作一律用 bundle 布局(只填用得上的子目录即可,单一内容的 bundle 完全合法)。一个 Forsion 桌面插件目录内嵌引擎侧/跨域内容,装进 `~/.forsion/plugins/<id>/` 一处全就位。识别全靠**标志文件**,manifest 无新增字段;所有子目录可选,纯捆绑包连 `main.js` 都可省:

```
<id>/manifest.json                     ← bundle 标志(普通 Forsion 插件 manifest)
     main.js                           ← UI 部分(可省)
     tangu-plugins/<pid>/tangu-plugin.json   ← 内嵌引擎插件:引擎原地加载(优先级最低,顶不掉手装同 id)
     skills/<slug>/SKILL.md            ← 内嵌全局技能:引擎原地扫描(内置 < bundle < 用户)
     agents/<slug>/config.toml         ← 内嵌 Agent:人格面播种一次,其 skills/ 指纹自愈
     spaces/<slug>/space.json          ← 内嵌 Space:随插件启停显隐(图标见上文 `iconFile`)
```

**三种生命周期,发包前必须分清**:

| | 谁 | 升级时 |
|---|---|---|
| **随包** | 引擎插件、Space | 父插件禁用即级联关闭/收起,卸载一并消失 |
| **播种一次** | Agent 的**人格面**(config.toml / SOUL.md / Library / MEMORY) | 首次发现拷入引擎成为活体,**永不覆盖**,卸载保留 |
| **指纹自愈** | Agent 的 `skills/`(2026-08-25 起) | 每次启动比指纹:用户没动过的跟着 bundle 更新;动过的(含无指纹老副本)保护不覆盖并在引擎日志报出来 |

包根 `skills/`(全局技能)是原地扫描、不落盘拷贝,不在上表内。因此 onboarding 里**不要** recommends 自家已内嵌的 agent/skill(会引导去市场重复装)。真实范例:`Forsion-Instrumentality-Project/bluebird/`。

### 插件能自带 MCP 吗?——不能,也别绕(2026-09-06 立规)

标志文件只有上面五种,**没有 MCP 这一类**;引擎的 MCP 配置是 `~/.tangu/config.json` 的 `mcp` 段,进程启动时冻结(改了要重启引擎),插件也没有写它的接缝。要给 agent 工具,按能力住在哪选路,不要造第三条:

- **能力在引擎/本机可跑** → 捆绑包 `tangu-plugins/<pid>/` 里的引擎插件 `registerToolProvider`,工具原地进工具面、自动过审批闸(computer-use / stickers 都是这样)。
- **能力在某台服务端**(如 Forsion server 的后台管理)→ **服务端自己出 MCP 端点**,插件只做「接入卡」:探测端点、签长效令牌、给出 `claude mcp add …` 命令与 Forsion 设置 → MCP 可粘贴的 JSON。先例 = server-admin 0.7.0 的「接入 Agent(MCP)」+ server `microserver/admin-mcp/`(`/api/admin/mcp`)。这样 Tangu / Claude Code / Codex 吃同一个端点,插件不持有任何监听。
- 声明式 `mcp.json` 标志**刻意没加**:服务器地址与令牌是运行期数据,写不进 manifest;真有静态 stdio MCP 要随包发时再议(约 30 行,在 `plugins/bundles.ts` + `mcp/config.ts` 合并)。

### 把动作搬进引擎侧:三档路由(通用纪律 5 的落地写法)

发现某个能力「只有点命令面板才能用」时,把它做成 bundle 的引擎侧资产(形态按纪律 5 选:默认包根 `skills/`,真需要专属人设/上下文预算/自动化入口才加 `agents/<slug>/`),然后在**通用技能**里写一张降级路由表(照抄 `bluebird/skills/bluebird-link/SKILL.md`)。**只发全局技能时第 2 档不适用**,直接写「自己做 / 指去工作台」两档即可:

1. **我自己就有那份技能**(即我就是那个专门 agent)→ `use_skill` 直接做。**这一档必须排最前**,否则专门 agent 会委派自己。
2. **有 `delegate` 工具且当前是本地库** → `delegate({ agentSlug: "<slug>", task })`,task 里带**真实库根路径**并要求它自己落盘、回报路径;顺带如实说明「委派产物不进插件侧栏索引」。
3. **都不行**(没 delegate / 云端库 / 第 2 档失败)→ 让用户从命令面板打开工作台自己操作。

需要桌面主进程能力时(语音转写、系统面)引擎侧已有 MCP 桥工具,如 `transcribe_audio(path, timestamps?)` —— 它在没开桌面/云端 worker 上自动隐身。**调用方明确说了「我自己接力转写」时,即使工具可见也不要调**。子 agent 继承**父会话**的审批档位,不是它 config 里的 `approval_mode`。
## Agent 自建 Space(2026-09-11 起;Muse 首例)

一个 agent 自己的 Space = 它目录下的一个桌面插件:`<tangu>/agents/<slug>/Space/{manifest.json, main.js}`,与普通桌面插件**同一份契约**(manifest + main.js,`registerView` / `registerCommand` / `registerStatusItem` / `registerSetting` / `notify` / `loadData` 都能用),但有五条不同:

> ⚠️ **main.js 整个文件就是 `setup(ctx)` 的函数体**(宿主 `new Function('ctx', code)(ctx)`):`ctx` 已在作用域里,顶层直接写 `ctx.registerView({ id: 'home', … })`。**别**写成 `function setup(ctx) { … }` —— 没人调用它,求值只声明了一个函数,零注册、零报错。09-27 实机:Muse 的 Space 每一版都这么包,从首建起空白了 16 天,它自己还一直在「升级」。

1. **id 固定 `agent-<slug>`**,manifest 里的 `id` 被无视 —— 写别家的 id 也顶不掉真插件;
2. **主槽 = `registerView({ id: 'home', … })`**:桌面该 agent 的 Space 主区渲染这一个视图,其它视图照常 `ctx.openView` 开标签页;
3. `capabilities` / `fileExtensions` / `requiresApp` / `onboarding` / `events` 一律不生效(没有「用户点安装」这步授权),bundle 子目录(引擎插件/技能/agents/spaces)也**不生效**(引擎只认一个 bundle 根);
4. 纯 JS、无构建、无 CDN(CSP `default-src 'self'`);想用库就内联进 main.js;
5. **不监听文件**:桌面按引擎在你周期收尾时打的内容戳重载,所以一个周期里改完再收尾即可;加载失败(setup 抛错 / manifest 缺失、坏或被 apiVersion·minAppVersion 挡下 / 装上了却没注册 `home` / `home` 的 mount 抛错)会以 `[feedback]` 行回到你的日志,下个周期修。**没收到 feedback 不等于用户看到了你的 Space** —— 它只在桌面打开过 Muse Space / Muse 面板时才会发。

### `ctx.agent`:读写你自己的数据(2026-09-27 起,**只有 agent 自建 Space 有**)

Space 应该**从数据渲染**,别把状态、时间、待办写死在 main.js 里、每个周期改一遍 —— 那既浪费你的额度,用户看到的也永远是旧的。
`ctx.agent` 只在 `agent-<slug>` 插件上存在、只能碰你自己这个 agent(普通插件整个没有;今天只有 Muse 有数据源):

| 成员 | 说明 |
|---|---|
| `slug` | 你的 agent slug(如 `'muse'`) |
| `status()` | `{ running, lastCycleAt, sleepUntil, sleepReason, mode, heartbeatMinutes, pendingApprovals }` 或 null |
| `todos(status?)` | 你提过的 TODO:`{ id, title, detail, status, createdAt }[]`;`status` 缺省 = 全部(`'pending'` / `'done'` / `'dismissed'` / `'injected'`) |
| `updateTodo(id, 'done' \| 'dismissed')` | **只在用户刚在你自己的视图里点过之后生效**(在你 Space 上按钮的 click 处理函数里调;宿主只认本视图里 1.5 秒内的真实点击 / 按键),挂载时 / 定时器 / 订阅回调 / 借别处的点击调一律 reject;效果同 Muse 面板的按钮,会以「用户处理了」的 `[feedback]` 回到你的日志;只改仍是 pending 的 |
| `schedule()` | 你 SCHEDULE.db 的条目:`{ id, name, date, repeat, auto, description, lastRun }[]` |
| `library.list()` / `library.read(path)` | 你的 Library:目录树 / 读一个文本文件(相对路径如 `'Journal/2026-09-27.md'`,≤1MB;越界、隐藏文件、不存在 → reject) |
| `subscribe(cb)` | 周期结束、睡醒、待批数或待办数变化、`updateTodo` 之后回调(宿主约 20 秒查一次);返回退订,禁用/重载宿主统一收 |

数据调用(status / todos / schedule / library / updateTodo)是 Promise,后端没就绪会 reject —— 自己画空态,别让 mount 抛错(mount 抛错也会以 `[feedback]` 回到你);`subscribe` 同步返回退订。
**挂载之后没接住的错也回到你**(2026-09-27 起):宿主给你当前这一版的代码打了 `sourceURL`,异步回调 / 事件处理 / 定时器 / 订阅回调里没接住的错,栈里有你的帧就以 `[feedback]` 回写、带 `main.js` 的行号(同一条只报一次,每版最多 3 条)—— 包括你 `await` 的宿主接口 reject 了你没接(异步栈里有你那一帧,行号落在 `await` 那行)。旧版漏清的定时器在重载后抛的不算。
手势闸防的是「顺手写个定时器 / 挂载时就标掉」这类失误,**不是安全边界**(插件与宿主同一个渲染进程);审批队列不开放。

```js
ctx.registerView({ id: 'home', title: 'Muse', mount(el) {
  const draw = async () => {
    const [st, todos] = await Promise.all([ctx.agent.status(), ctx.agent.todos('pending')]).catch(() => [null, []])
    el.replaceChildren()
    for (const t of todos) {
      const b = document.createElement('button')
      b.textContent = `✓ ${t.title}`
      b.onclick = () => ctx.agent.updateTodo(t.id, 'done').then(draw, () => {}) // 只能在点击里调
      el.append(b)
    }
  }
  draw()
  return ctx.agent.subscribe(draw) // 退订函数正好当 disposer
} })
```

## 桌面插件:贡献点全表(动手前先看这张表)

`ctx` 上的注册口就这些 —— **内置与外置拿到的是同一份**(`pluginStore.makeContext`,能力对等原则)。
细节正典 = 仓根 `docs/Function/生态内容制作指南.md`(本表每一行都能在那儿找到对应小节);
类型契约 = `Forsion-Genesis/desktop/frontend/src/amadeus/plugins/types.ts`。

| 贡献点 | 给用户的入口 | 备注 |
|---|---|---|
| `registerCommand` | 命令面板(+ 可选 agent 面) | id 处于全局命名空间,裸名会互顶;默认只做导航,**动作性能力要么走引擎侧 agent/技能(通用纪律 5),要么给这条命令声明 `invoke`**(见下) |
| `registerSlashItem` | 笔记里的 `/` | 静态 `scaffold`,或动态 `run()`(先建文件再返回嵌入语法);`label` / `group` 传函数则跟随界面语言 |
| `registerSelectionAction` | 选中文字后工具栏「AI ▾」里的「插件」组 | `run(cx)` 返回要提议的 markdown,**只进宿主的预览面板**,用户点「替换 / 插入下方」才写(见下「正文 AI」) |
| `registerView` | 独立标签页(`ctx.openView(id)` 打开) | **DOM 挂载**(`mount(el, view?)` 返 disposer;可以是 async —— resolve 出的就是 disposer,reject 算挂载失败;`view.extendView` 可开临时扩展),外置插件的主力;加 `workspaceSource` 可让左栏跟着它切到自家列表。**样式不隔离**:选择器挂自家根类名,配色只用 `var(--bg)` / `--bg-card` / `--text` / `--text-muted` / `--border` / `--accent`(自造的变量名宿主没有,会落到你写死的兜底色) |
| `openFloatingPanel` | 第六种 Floating Panel | 先注册 view，再按相对 id 打开；桌面是真原生窗口，Web 是不可拖动居中面板；可选链兼容旧宿主 |
| `openMiniPanel` | 320×420 Mini Panel | 不建 Space 也能直开紧凑 view；用 `mainViewId` 声明回主面板的目标；仅原生桌面宿主提供 |
| `registerListSource` | **统一左栏**里的一条列表(收藏/任务/订阅…) | 宿主渲染,与会话/笔记行同一套 UI;⚠️`subscribe()` 里**必须重读一次数据**,见下 |
| `registerFileType` | 自定义 `.x.md` 文件类型 | 撞内置后缀返回 **`false`** → 整体退让(判定写 `=== false`) |
| `registerFileCreator` | 文件树右键 + 新建标签页启动器 | 与文件类型配套;**四条新建路径都要注册**,少一条用户就会问「为什么这儿没有」 |
| `registerEmbedRenderer` | `![[x]]` 嵌入的自绘渲染 | |
| `registerSetting` | 详情页声明式表单(number/boolean/text) | 每键一个字符串,**没有原子性**;同 key 重注册即覆盖 |
| `ctx.ui.mountMarkdownEditor` | 视图内原生 Amadeus Markdown 编辑器 | 正文归调用方(API 草稿等),**不碰笔记库**;保存前 `getValue()`;老宿主没有 → 可选链 |
| `ctx.ui.mountFloatingToc` | 视图内原生悬浮目录 | 插件保有正文 DOM,宿主负责扫描 / 滚动高亮 / 跳转 / 主题;老宿主没有 → 可选链 |
| `ctx.table.mount` | 面板里的原生多维表(只读) | 一份规格 → 真 DbTable(筛选/搜索/隐藏列/排序/统计全套),**不依赖笔记库**;老宿主没有 → 可选链 + 自己的表格降级(见下) |

#### Extend View:随主视图挂载的临时扩展(2026-09-05)

`registerView.mount(el, view?)` 在 Main View 中的第二参提供 **`view.extendView`**。用它承载新增/编辑表单、详情或临时工具;
宿主创建临时原生 View,加入现有 Left / Right / Bottom Panel 的标签组,由主视图管理生命周期。
不需要为每个插件 `registerView` 第二个常驻视图,不进永久视图目录、导航历史或布局存档。
原生标签栏保持可见,可在原有 View 与临时 View 间切换且保留草稿;宽度/高度沿用 Panel 设置。
侧栏原先收起时按需展开;关闭临时 View 后返回原有 View,仅有临时 View 的面板随之收起。
使用原生折叠按钮会收起整个 Panel 并销毁临时 View;再次展开仅还原常规 View。
内置 React 主视图从 `ViewProps.extendView` 取同一接口;侧栏 View、Dashboard 嵌卡和无侧栏的 mini 窗口没有这个接口。

```js
ctx.registerView({ id: 'items', title: 'Items', mount(el, view) {
  const button = document.createElement('button')
  button.textContent = ctx.getLocale().startsWith('zh') ? '编辑' : 'Edit'
  button.onclick = () => view?.extendView?.open({
    id: 'editor',
    title: () => ctx.getLocale().startsWith('zh') ? '编辑条目' : 'Edit item',
    side: 'right', // left / right / bottom;默认 right
    mount(body, handle) {
      const input = document.createElement('input')
      input.setAttribute('aria-label', 'Item name')
      body.appendChild(input)
      // 保存成功可调用 handle.close();失败时保留输入并提示。
      return () => { input.remove() } // 清理订阅/监听器/计时器
    },
    onClose(reason) { /* dismiss(原生关闭/折叠/Esc/系统返回) / close / replace / owner */ },
  })
  el.appendChild(button)
  return () => { button.remove() }
} })
```

每个主视图同时至多一份扩展,同一个 Panel 也只容纳一份临时内容(后来者替换前者)。
移动端临时 View 进入原生左右抽屉的视图选择器;请求 bottom 时回落到右抽屉。
每个主视图内,相同 `id` 再次 `open` 只聚焦,**不重新 mount、不替换参数**,保留输入;
要切对象就换 id 或先 close。不同 id 替换前一份;旧 handle 的 close 无法关掉后来者。
`handle.isOpen` 可探测是否还活着。`view.extendView.close()` 收当前扩展。
主视图关闭、切 tab/Space、换实体参数或插件禁用会卸载内容;旧 controller 的异步 open 会抛错,
调用方应取消自己的请求或处理失败。扩展里的未保存草稿由主视图自行管理,不要把凭据写入布局。

**规则/Agent 入口**调用与按钮相同的 `open` 函数即可;Agent 入口仍须在 `registerCommand` 上声明下面的
`invoke` 白名单,传显式目标和稳定 id,不做 toggle。须先确保拥有这份扩展的主视图已经挂载,
不要把过期 `view` 存成跨视图的全局控制器。旧宿主需检查 `view?.extendView`,按需保留原来的内联表单。

#### `invoke`:把一条命令开给 agent(2026-09-04)

给 `registerCommand` 的条目加一个 `invoke`,这条命令就进 Tangu 的 `list_ui_commands` 目录、
可被 `run_ui_command` 派发。**存在即白名单** —— 不声明就对模型完全不可见。

```js
ctx.registerCommand({
  id: 'myplugin-open-report',
  title: () => t('报告'),
  keywords: 'report weekly 报告 周报',   // 命令面板的模糊搜索别名(中文/拼音都可以,不进模型面)
  run: () => openReport(),
  invoke: {
    // 英文,给模型看。**不要复用 title** —— title 跟随界面语言,中文用户的目录会整份变中文。
    description: 'Open the weekly report view.',
    // 有参数就给 JSON Schema;并且**一定要接显式值,不要做 toggle**:
    // 模型看不到当前界面状态,而派发事件在重连时会重放,toggle 会被翻两次。
    params: { type: 'object', properties: { week: { type: 'string' } } },
    run: (args) => openReport(String(args.week || '')),
    state: () => currentWeek(),           // 可选:当前值探针,省得模型靠猜
  },
})
```

`invoke.run` 可以返回一个字符串,作为**这一次调用**的回执回给模型(如 `'opened week 40'`),优先于 `state()`。
回执按调用给,并发的两次调用各拿各的;`state()` 每次起 run 都会被读进目录,别在里面放一次性的结果。
回执与 `state` 一样会被截到 200 字符。

三条硬纪律:

1. **危险类不许 opt-in** —— 删除或覆盖用户数据、凭据与安全设置、对外发送/发布/购买、
   安装升级重启退出、不可逆的批量操作。理由不是洁癖:**web 与移动端的云 run 根本不经过审批闸**
   (引擎对非 host 执行档直接 approve),你这份声明就是那两端的全部安全边界。
2. **先想清楚是导航还是动作。** 模型「帮用户开一个面板」几乎没有价值;有价值的是把它刚做出来的
   东西摆到用户眼前、或者改一个用户用话说出来的设置。
3. **插件命令只在桌面存在**(web 与 mobile 的 `listPlugins` 都返回 `[]`)。声明了 `invoke` 也不会
   出现在手机的目录里 —— 这是正确行为,不是 bug,别为此写特例。

#### `checked`:开关类命令的当前状态(2026-09-25)

用户可以把任意命令钉进 Ribbon 命令区。**开关类**命令(开 / 关某个模式)声明 `checked`,钉上去的按钮
就带 `aria-pressed` 并在开着时高亮,一眼看得出现在是开是关;不声明就是普通动作钮。

```js
ctx.registerCommand({
  id: 'myplugin-focus-mode',
  title: () => t('专注模式'),
  run: () => setFocus(!isFocus()),
  checked: () => isFocus(),   // 渲染期求值:要便宜、无副作用
})
```

- **只给真开关用**。「打开报告」这种动作声明了 `checked` 会被读屏报成「未按下」。
- 宿主**不订阅**你的状态:Ribbon 在点击后、悬停进出时重读;别处(快捷键、设置页)改了状态,
  按钮要等下一次重渲才跟上。旧宿主没有这个字段 = 静默忽略,不用做特性检测。

| `registerSettingsView` | 详情页里自己画的面板 | 会被反复挂载卸载,状态别放模块级单例;`title` 可传函数(切语言跟上)。`category: 'forsion'`(2026-09-28 起)只对带主进程半身的首方内置包(Forsion Extend)生效:面板成为设置「Forsion 云端」的一个子页,别的插件写了照旧画在详情页 |
| `ctx.app.openSettings?(target)` | 打开设置到某一页 / 子页(2026-09-28 起) | 口径同宿主深链,如 `'model/m-providers'`;旧宿主没有,一律 `?.` 调 |
| `registerReadiness` | onboarding 检查卡上的一行 `check` | 2026-09-21 起;**必须 `ctx.registerReadiness?.(…)`**;拿不准回 `'unknown'`,见下「前置条件」 |
| `registerEditorExtension` | 笔记编辑器的按键 / 装饰 | `'high'` 档不处理**必须 `return false`** |
| `registerStatusItem` | 全局状态栏 | 返回 handle,可原位 `update({text,title})` |
| `registerTheme` | 强调色主题 | 与磁盘主题包(`~/.forsion/themes/`)是两件事 |
| `registerAppearance` | 设置 → 外观 → 开屏与图标 | 图像方案，由用户选择；可选链兼容旧宿主，返回 disposer；见下文 Startup appearance |
| `registerFont` | 设置 → 外观 → 字体 | 2026-08-28 起;**返回 disposer**(宿主在禁用/重载时也会自己撤销,返回值可以不接);旧宿主没有 → `ctx.registerFont?.(…)` |
| `registerPanel` | 右侧栏面板 | ⚠️收 **React 组件** —— 外置插件得自带一份 React(mindmap 有先例),多数场景改用 `registerView` |
| `registerPropertyType` | 多维表自定义列类型 | ⚠️同上,`Cell` 是 React 组件;`baseType` 决定落盘形状 |
| `ctx.notify(msg, {level})` | 右上角通知 | 自动标插件名,用户可按插件静音 |
| `ctx.achievements` | 成就系列 + `track(event, n)` | 宿主强制 `plugin:<id>:` 前缀,伪造不了官方成就 |
| `ctx.activity.log(event, detail)` | 写进活动日志(Muse 读得到) | 同款前缀纪律 |
| `ctx.loadData() / saveData()` | 每插件一份 JSON blob | 大块数据走这条(见下「编辑器」节) |
| `ctx.dashboard` | 原生仪表盘(网格/卡片/排版台) | 2026-09-01 起;**两条路线**(视图内 `mount` 不依赖库 / `source` 生成 `.dashboard.md` 需要库)见下节;一律 `ctx.dashboard?.` |
| `ctx.getLocale / subscribeLocale` | 跟随宿主中英切换 | 见下「双语」 |
| `ctx.tangu` | 当前模型 / 模型目录 / 当前 Space / 会话用量 / **agent 此刻在干什么**(只读)+ `agents()` 用户的 Agent 名册 + `startChat` 用指定 Agent 开一个可见的新对话 + `mountChat` 把原生对话挂进自己的视图(2026-10-04 起)+ `complete` 一次性文本补全(2026-09-28 起) | ⚠️**非 Tangu 宿主上整个不存在** → 一律 `ctx.tangu?.`;`agentStatus` / `subscribeAgentStatus` / `startChat` 是 2026-09-19 起、`agents` 是 2026-09-20 起的可选方法 → `ctx.tangu?.startChat?.(…)`;见下「当前模型」「Agent 状态」「Agent 名册」「开新对话」 |
| `ctx.desk` | Tangu 聊天右侧 **Agent Desk** 里挂一块自绘区(`registerCompanion`,典型:跟着 agent 状态做反应的 3D 形象) | 2026-09-19 起;⚠️**只在桌面 Tangu 上存在**(web / 移动端 / 纯 Amadeus 壳整个没有)→ `ctx.desk?.`;两种模式 `idle` / `always`,见下「Agent Desk 伴随面」 |
| `ctx.automation` | 播种多维表自动化规则(`ensure(rules)`) | 2026-09-02 起;⚠️**非 Tangu 宿主上整个不存在** → `void ctx.automation?.ensure(…)`;id 宿主加 `plugin:<id>:` 前缀;见下「自动化」 |
| `ctx.calendar` | 把插件种的表登记进 Calendar Space(`ensureMember`) | 2026-09-02 起;显式成员制,不登记就不在日历里;旧宿主没有 → `ctx.calendar?.` |
| manifest `events[]` | 自动化(Automation)可订阅的事件 | 纯声明无代码;⚠️目前只有中文 `label`,英文界面下也显示中文 |
| manifest `onboarding` | 有 `requires` = **闸**(宿主实测,未满足才弹检查卡);没有 = 详情页里折叠的使用说明 | 见下「前置条件:onboarding.requires」;**别 recommends 自家已内嵌的 agent/skill**(会引导去市场重复装);⚠ `recommends` 只在闸的检查卡里渲染,没有 `requires` 就一个字都不显示 |

`ctx.app` 上另有三组:**整库文件读写**、**只读全库查询**、**块表面** —— 各占下面一节。

### ⚠️「没有活动库」时的统一行为(2026-09-02 立规)

上面三组里**凡走库内路径**的方法(`readFile / writeFile / readBytes / writeBytes / watchFile / openFile / loadPage /
createPage / listPages / listFiles / searchVault / reveal`)都要求一个**已打开**的笔记库。
没有活动库时它们**各自失败得不一样**,而且大半是静默的:

| 方法 | 没有活动库时 |
|---|---|
| `readFile(p)` | **静默返回 `null`**(与「文件不存在」同形,try/catch 照不到) |
| `writeFile(p, t)` | **reject** —— 主进程抛 `Error('No vault is open')` |
| `readBytes(p)` / `writeBytes(p, bytes)`(2026-09-19+) | 同上两行:`readBytes` 给 `null` 不抛,`writeBytes` **reject** `'No vault is open'`。旧宿主 / 桥缺席时方法整个不存在 → `ctx.app.writeBytes?.(…)` |
| `mutateDb(p, fn)`(2026-09-02+) | `{ ok:false, error }`,**不抛**;云端/移动端桥没有 CAS 写口时同样 `{ ok:false }`。⚠️**改活表(补列属性、加视图)一律走它**:比对交换 + 冲突重读重放,`fn` 返 `null` 不写;`readFile`+`writeFile` 整文件覆盖会盖掉读写之间自动化/用户刚写的行且零报错。旧宿主没有 → `ctx.app.mutateDb?.(…)` 再走自己的回落路 |
| `listPages()` / `listFiles()` / `searchVault(q)` | 一律**给空数组、不 reject** |
| `vaultRoot()` | `null` —— **唯一的可用性探针** |
| `workFolder()` | **照常返值**(它只是一条设置项的值)—— ⚠️**不是可用性探针**,拿到字符串不代表写得进去 |

- ⚠️**库是惰性恢复的**:`vaultRoot()` 为 null 只说明「当前没有**打开着的**库」,不代表用户没有库 ——
  用户这一程还没进过 Amadeus 之前它就是 null。插件在宿主**启动期**装载,setup 里那一发读写多半正撞在这上面。
  插件视图挂载时宿主会唤醒库(2026-10-02 起),但恢复是异步的:视图刚挂上那一下 `vaultRoot()` 仍可能是 null ——
  一进视图就要读库(列工程、恢复上次打开的文件)的,先等 `vaultRoot()` 有值再读,别把那一刻的空当成「用户没有内容」。
- **结论(2026-09-02 起规,起因:服务器总览面板误依赖笔记库,用户实报「太奇怪了」)**:
  **与笔记无关的功能(仪表盘 / 远程系统面板 / 工具面)不得建立在这些方法上** ——
  用 `ctx.dashboard.mount`(见下节)、`ctx.loadData` / `ctx.saveData`、以及自己视图里的 DOM。
- **启动期的写一律 try/catch**;要按「库在不在」分支就读 `vaultRoot()`,别去试探 `readFile` 的 null。
- 与列表源那条纪律是同一个病根:`registerListSource` 的 `subscribe()` 必须顺手重读一次(见下)。

### 宿主挂载接口的 dispose 契约(2026-10-04 起)

`ctx.app.mountBlocks` / 文件视图的 `mountNoteView` / `ctx.ui.mount*` / `ctx.table.mount` / `ctx.dashboard.mount` / `ctx.tangu.mountChat`
都把宿主的界面挂进**宿主自己加到 `el` 里的一层**(`display:contents`,不出盒子:`el` 的高度、flex 照旧作用在里面的内容上)。

- `dispose()` 同步摘掉这一层,**之后 `el` 立刻还给你**:清空它、放自己的内容、在同一个 `el` 上再挂,都不用等。
- dispose 再挂 = 一份全新的实例(输入焦点、排序筛选这些状态不带过来)。只是换数据 / 换参数就用句柄的 `update()`。
- 别用 `el > .x` 去选宿主渲染的节点,也别假设它是 `el.firstElementChild` —— 中间隔着那一层。
- 2.12.2 及更早的宿主没有这条保证:dispose 之后那一拍里清空 `el`,宿主的卸载会报一条页面错误,或者再挂之后一片空白。
  要兼容它们,就把宿主内容挂进你自己建的子节点(`const slot = el.appendChild(document.createElement('div'))`),换内容时连子节点一起换掉。

### 可复用 UI 组件：ctx.ui.mountChatBox（2026-09-24 起）

Space 管布局，View 管独立功能面，**UI component** 是 View 内可组合的部件；不要与 Amadeus 文档 Block / Dashboard Card 混用。
开发插件 View 前先查宿主组件目录；已经公开的组件通过 `ctx.ui` 挂载，不复制聊天 JSX/CSS，也不打包第二份 React。

`ctx.ui?.mountChatBox?.(el, opts)` 挂载与原生聊天同源的输入卡和模型选择器，返回 `{ update(patch), focus(), dispose() }`。
`opts` 支持 `value`、`modelId`、`thinkingLevel`、`agentSlug`（初始默认）、`label`、`placeholder`、`submitLabel`、`disabled`、
`submitOn: 'modifier-enter' | 'enter'`、`onChange(draft)`、`onSubmit(draft)`。`draft = { text, modelId, thinkingLevel }`。
提交返回 true 清空已提交内容；false / reject 保留，等待中防重复。默认 ⌘/Ctrl+Enter，Shift+Enter 换行，输入法确认不提交。
模型目录与聊天共用，只展示 LLM；模型与思考档是组件局部草稿，不改全局默认/当前会话，不自动开会话或调用模型。
**调用方必须使用回调里的模型与思考档**，不能只接 text。附件、命令、审批与运行控制属于会话编排器，不是此提示表单 API。
插件主动在 View 卸载时 dispose（之后 `el` 立刻归还，见上「dispose 契约」）；宿主仍会在插件禁用/重载/setup 失败时统一回收，卸载后晚到的异步结果无效。
完整双语示例与契约：`docs/customization/ui-components.md`；类型真源：`desktop/shared/chatBox.ts`。
新增公共组件时一起维护类型、本文、原生消费者和生命周期测试，`contractDocs.test.ts` 覆盖 `ctx.ui` 嵌套方法。

### 原生 Markdown 编辑器 ctx.ui.mountMarkdownEditor(2026-09-30 起)

`ctx.ui?.mountMarkdownEditor?.(el, opts)` 挂载与笔记同源的 Amadeus 编辑器(可视 / Markdown 源码 / 发布预览三档),
返回 `{ getValue(), update(patch), insertMarkdown(md), focus(), dispose() }`。
`opts` 支持 `value`(必填字符串)、`label`、`readOnly`、`previewBaseUrl`(预览里相对路径图片/视频的源)、`onChange(markdown)`。
**正文与持久化归调用方**:不读写活动库、不改当前笔记、不自动保存、不调模型。保存前必须同步调 `getValue()`(含最新一笔编辑事务)。
`update({ value })` 换文档,`insertMarkdown` 追加附件/嵌入(只读时无效),`dispose()` 幂等(之后 `el` 立刻归还,见上「dispose 契约」);宿主在插件禁用/重载/setup 失败时统一回收,旧句柄不再改内容。
老宿主没有此方法时明确提示升级,不要拿 textarea 冒充原生编辑器。完整契约:`docs/customization/ui-components.md`;类型真源:`desktop/shared/markdownEditor.ts`。

### 原生悬浮目录 ctx.ui.mountFloatingToc(2026-09-07 起)

长内容视图不用复制 Chat View 的目录实现。`ctx.ui.mountFloatingToc(shell, opts)` 在插件自己的
`shell` 上叠一层宿主原生 Floating TOC(默认左侧刻度条、hover / 键盘聚焦展开),正文 DOM 与滚动仍归插件。
宿主负责 MutationObserver 增量扫描、当前段高亮、平滑跳转、窄栏隐藏、明暗 / 配色 / 扁平模式与键盘可达性。

```js
ctx.registerView({ id: 'manual', title: 'Manual', mount(el) {
  el.innerHTML = `
    <div data-role="shell" style="height:100%;min-height:0">
      <article data-role="scroll" style="height:100%;overflow:auto">
        <h1>Getting started</h1><p>…</p>
        <h2>Configuration</h2><p>…</p>
      </article>
    </div>`
  const shell = el.querySelector('[data-role="shell"]')
  const scroll = el.querySelector('[data-role="scroll"]')
  const toc = ctx.ui?.mountFloatingToc(shell, {
    scrollContainer: scroll,
    contentRoot: scroll,               // 省略时就是 scrollContainer
    selector: 'h1, h2, h3',
    label: ctx.getLocale?.() === 'en' ? 'Table of contents' : '目录',
    minItems: 2,                       // 缺省 2;只有一个标题时不占边栏
    hideBelow: 520,                    // 缺省 520 CSS px
    topOffset: 24,
    side: 'left',                      // 也可 right
  })
  return () => toc?.dispose()
} })
```

- `shell` 是**非滚动**定位外壳,`scrollContainer` 是里面真正滚动的元素;宿主只在 `shell` 追加覆盖层,
  不会清空或接管插件正文。两者写成同一个滚动元素会让覆盖层跟着正文滚,不要这样搭。
- 普通标题不用额外标记。非 `h1-h3` 条目可加 `data-lcl-toc-title="显示名"`、
  `data-lcl-toc-level="2"`;需要强层级样式再加空属性 `data-lcl-toc-primary`。
- 特殊 DOM 可传 `itemFromElement(element, index) → {text, level, primary?, onSelect?} | null`。
  回调抛错会被宿主隔离;不传 `onSelect` 就按元素位置在 `scrollContainer` 内平滑滚动。
- DOM 的增删和文字变化会自动重扫;只有 Shadow DOM / 第三方画布等观察不到的变化才调返回句柄的 `refresh()`。
  `dispose()` 幂等,同步摘掉宿主加在 `shell` 里的那层(你的正文不动);插件禁用 / 重载时宿主也会统一卸载。
- 旧宿主整个 `ctx.ui` 不存在,一律 `ctx.ui?.mountFloatingToc(...)`;缺席时可继续显示正文,不必仿一份目录。

### 仪表盘 ctx.dashboard(2026-09-01 起)

插件能拿到**真的** Dashboard(dashboard3 网格 / 卡片 / 排版台,不是自己画的仿制品)。
**两条路线,按「要不要住进笔记库」分**:`ctx.dashboard.mount(el, opts)` 渲在插件自己的容器里、**不依赖笔记库**;
`ctx.dashboard.source(recipe, opts)` 把配方编译成真 `.dashboard.md` 字节、**需要已打开的笔记库**。

```js
// 路线 A —— 在插件自己的视图容器里渲染,**不依赖笔记库**(库开没开、有没有库都能用)
ctx.registerView?.({ id: 'overview', title: '总览', mount(el) {
  return ctx.dashboard?.mount?.(el, {
    recipe,                                   // 配方见下
    layoutText: saved,                        // 上次存下的整页文本;首次传 null
    onLayout: (text) => ctx.saveData?.({ layout: text }),   // 用户在排版台手排后交出整页文本
    locked: true,                             // true=成品页(只看);false=排版台(可拖可改)
  })                                          // 返回卸载函数 —— 正好当 mount 的 disposer(调用后 el 立刻归还,见「dispose 契约」)
}})

// 路线 B —— 编译成一份真 `.dashboard.md` 字节,落进库、用原生 tab 打开(**需要已打开的笔记库**)
const r = ctx.dashboard?.source(recipe, { existingFileText })   // {ok:true,text} | {ok:false,error}
if (r?.ok) {
  const p = `${ctx.app.workFolder()}/总览.dashboard.md`
  await ctx.app.writeFile(p, r.text)          // ⚠️无库会 reject,见上表
  ctx.app.openFile?.(p)                       // amadeusNav 把 .dashboard.md 路由到原生 Dashboard tab
}
```

**配方(`recipe`)的卡片只有四种**:

| kind | 字段 | 说明 |
|---|---|---|
| `stat` | `id / label / value / unit?` | 数字卡。`value` 是**字面值**(插件自己算好的字符串),不是查询表达式 |
| `section` | `id / label` | 分节标题 |
| `text` | `id / md` | 一段 markdown |
| `view` | `id / type / params?` | 嵌一个视图 |

- ⚠️**卡 `id` 是跨次稳定契约**:手排布局按卡 id 保留。id 变了 = 那张卡的位置/尺寸丢失,用户白排一次。
  别拿数组下标或本地化字符串当 id。
- 路线 B 再生成时**把现有文件字节传 `existingFileText`**:用户手排的布局(`dashboard3`/`dashboard3x`)与页面筛选会存活;
  读不懂的现有布局会**拒编译**(`ok:false`)—— 宿主绝不拿默认值覆盖用户布局,所以 `ok:false` 要如实报给用户,别静默重写。
- 围栏格式与 frontmatter 词表**留在宿主**(格式无版本契约,手抄 = 将来破兼容)—— 只出配方,别自己拼 `.dashboard.md` 文本。
- 旧宿主没有,两条都要可选链:`ctx.dashboard?.mount?.(…)` / `ctx.dashboard?.source(…)`,并备一条降级 UI。

### 原生多维表 ctx.table.mount(2026-09-05 起)

面板里的表格不用再手搓 `<table>`:给**一份规格**,宿主用真的多维表渲(筛选 / 搜索 / 隐藏列 / 排序 / 统计
一样不少),**不依赖笔记库** —— 与 `ctx.dashboard.mount` 同一路线(远程系统面板也能用)。
表是**只读**的:没有加行 / 加列 / 删行,单元格也编辑不了。

```js
const spec = {
  id: 'models',                                   // 槽位键:同 id 再来 = 更新,不是重挂
  columns: [
    { key: 'name',  label: '模型', kind: 'text', width: 200 },
    { key: 'calls', label: '调用', kind: 'number' },
    { key: 'state', label: '状态', kind: 'select', options: [{ value: 'on', label: '启用', color: 'green' }] },
  ],
  rows: models.map((m) => ({
    id: m.id,
    attrs: { 'data-id': m.id },                   // 落到行元素上,既有的事件委托照常收得到
    cells: {
      name:  { text: m.name, sub: m.slug, avatar: { src: m.icon, letter: m.name[0] } },
      calls: { text: '58.5 万', sortValue: 585000 },   // 显示归 text,排序归 sortValue
      state: m.enabled ? 'on' : 'off',
    },
  })),
  actionsLabel: '操作',
  actions: (row) => [{ act: 'm-edit', label: '编辑', attrs: { 'data-id': row.id } }],  // 真 <button data-act>
  empty: '还没有模型',
  onRowOpen: (row) => openDetail(row.id),         // 行点击 / Enter(点在按钮、链接上时不触发)
  onSort: (s) => { state.sort = s },              // 用户改了排序 → 面板自己记一份
}

const h = ctx.table.mount(el, spec)               // 同步返回 { update, dispose }
refresh = (rows) => h.update({ ...spec, rows })   // 数据刷新走 update:排序/筛选/列宽存活
// 视图卸载时 h.dispose()(幂等,之后 el 立刻归还;插件禁用时宿主也会统一卸掉)
```

- **数据刷新一律 `update(spec)`,不要 dispose 了重挂** —— 用户当前的排序 / 筛选 / 隐藏列 / 列宽住在表自己的
  状态里,重挂就全没了(面板每次重绘都清一次 = 用户没法用)。
- **单元格里不许出现 HTML 字符串**:`text` 只收字符串/数字,装饰走 `sub` / `tone` / `dot` / `mono` / `title` /
  `avatar` / `href` 这些字段。规格非法(没列 / 行缺 id / `text` 不是基元)**当场同步抛**。
- `sortValue` 是给复合文案用的:显示 `58.5 万`、排序按 `585000`。不给就按字面排(「585000 < 9」那种)。
- `onRender(root)` 是**只读**回调(挂懒加载观察器一类):表是宿主的 React 树,**往里塞/删节点会在下一次
  `update()` 的对账里被抹掉**。头像懒加载的正确姿势是「拿到 src → 改规格 → `update()`」。
- `sort` 只吃首份规格;之后用户在表头改的排序归表自己记,`update()` 不冲掉它(所以要在 `onSort` 里同步面板状态)。
- 列的 `align` / `nowrap` 只有降级路径认(原生表有自己的列宽 / 对齐语汇);`row.className` 两条路径都认(原生路径并进行的 className)。
- 行只是分页 / 截断的一片(服务端分页、按页切)就标 `partial: true`:原生表整条工具栏(筛选 / 搜索 / 导出 / 视图设置)不给 —— 它们只会看到本页并给出错误的数据视图;表头排序照留(本页内)。
- 规格里的 `attrs`(行 / 格 / 头像 / 动作)只放行 `data-*` / `aria-*` / `title` / `id` / `role` / `tabindex` / `lang` / `dir` / `hidden` / `class`;`on*` / `style` / `src` / `href` 一律丢弃,`data-act` / `type` / `disabled` 这类固定属性不可被 attrs 覆盖。
- **规则行折叠 `fold`(2026-09-21 起,先查 `ctx.table.caps?.fold`)**:`fold: { by: ['user'], time: 'at', minutes: 30 }` =
  `by` 各列值全等、且 `time` 列落在同一个 30 分钟**本地时钟**窗口(:00 / :30)的行收成一条**汇总行**,点开展开成员行
  (`by` / `time` 至少给一个;`minutes` 缺省 30)。通用汇总:数字求和、日期画「最早 – 最晚」、其余列出包含的值与次数;
  想自己定某几列的汇总格就给 `fold.summary = (rows) => ({ cost: { text: '-2.62', tone: 'amber' } })`(`text` 原样显示,
  没给的列走通用汇总;回调在渲染期被调,别做重活)。表头排序作用在**汇总值**上。`update()` 里改了 `fold` 会立即重折
  (与 `sort` 相反:折叠规则跟宿主走,面板的时间窗控件靠它)。`partial` 的表要**按折叠单元分页**、把整单元的成员行一起给,
  否则一个单元会被页边切成两半。宿主不认 `fold`(没有 `caps.fold`)时字段被静默忽略 = 成员行平铺。
- 旧宿主没有:`if (ctx.table && ctx.table.mount) { … } else { 画自己的经典表格 }`。整个 `ctx.table` 会**不存在**
  (不是空壳),抛出来的错也当「宿主不收」处理 —— 两种情况都走降级 UI。

### 只读全库查询(2026-08-14 起)

全部可选 → 一律 `ctx.app.listPages?.()`;**没有活动库/桥缺席时给空数组不抛错**,`vaultRoot` 给 `null`。

| | 语义与坑 |
|---|---|
| `listPages()` | 笔记清单,vault 相对路径,**不截断**;插件自定义后缀已被主进程排除在外 |
| `listFiles()` | 文件树可见的非笔记文件。⚠️遍历**跳过一切点目录/点文件** → 经 `saveAsset()` 落进 `.amadeus/` 的页面附件枚举不到,**别声称「库里所有图片」** |
| `searchVault(q)` | 全库笔记全文检索。⚠️**最多 50 条且可能截断**,要穷举别靠它;`line` 是剥掉 frontmatter 后的行号**不是磁盘坐标**;`score` 不透明,跨版本不保证稳定 |
| `vaultRoot()` | 库的绝对路径(把路径喂给 Agent 的 host 工具时才需要)。⚠️含用户名/组织目录等**敏感信息,不得默认持久化或上报**;切库瞬间与主进程短暂不同源,**别缓存过夜** |
| `reveal(path)` | 在系统文件管理器里打开该路径所在目录并高亮它(2026-08-29 起)。⚠️对**不存在**的路径是静默 no-op,而工作文件夹是首写才诞生 → **先 `writeFile` 一份 README 再 reveal 它**;桥缺席时整条方法不存在,`if (ctx.app.reveal)` 才画按钮 |

### 统一左栏列表源(2026-08-25 起)

`ctx.registerListSource?.({ id, title, items, subscribe, open, search?, groups?, actions?, itemMenu?, drop? })` ——
插件只出数据,搜索词与选中分组**由宿主持有**并经 `items({query, group})` 回传(插件对 UI 无状态);
`items()` 每次渲染都被调,自己缓存别读盘。露出左栏两条路:space.json 写
`{"type":"workspace","params":{"mode":"plugin:<插件id>:<源id>"}}`,或给 `registerView` 加 `workspaceSource`。

- ⚠️**`subscribe()` 必须顺手重读一次**:插件在宿主**启动期**装载,而笔记库恢复是**懒的** ——
  setup 里那次 `ctx.app.readFile` 多半撞在「还没有活动库」上,宿主此时**静默返回 `null` 不抛异常**
  (try/catch 照不到),列表就此定格为空。宿主挂载列表面 / 切库都会重订阅,这是重读的门。
  (青鸟 2026-08-28 实报「明明有记录却是空」,根因即此。)
- 行首图标 `iconUrl`(favicon 等)与 `icon`(词表键)**两个都给**:老宿主 / 取不到图时退 `icon`。
- `actions` / `itemMenu()` 的每一项是 `{ id, label, primary?, danger?, run }`:`primary` 留在工具条外面(缺省第一项),其余收进「⋯」;
  `danger: true`(2026-09-25 起)= 不可逆动作(删除 / 移除),宿主在右键菜单和「⋯」里都用危险色画它。**只管配色,确认仍由插件自己在 `run()` 里做**
  (宿主不替你弹框);惯例把它排在最后一项。老宿主忽略该字段。
- 行可带 `unread: true`(2026-09-11 起):宿主在行首图标角上画与未读会话同一个点;老宿主忽略。
  宿主自己的收件箱就是这么接进统一左栏的(`plugin:inbox:messages`,分组 = 未读 / 发信人 / 已归档),可当参考实现。
- `drop` 不声明就完全没有拖放;声明了也是宿主判形点亮、插件决定接不接。
- 细节与全部字段语义见正典文档同名小节 + `amadeus/plugins/types.ts` 的 `ListSourceContribution`。

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
5. `check` 只在用户打开检查卡 / 点「重新检查」/ 手动启用 / 市场装完时被调,**启动期不调**,8 秒超时按 unknown。
   别在里面做重活,也别指望它在后台跑。
6. key / id 须匹配 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`,≤8 条;坏条目被 `sanitizeOnboarding` **静默丢弃**
   (全丢光闸就退化成说明,不报错)。英文走 `onboarding.en.intro` / `onboarding.en.steps`(与 `steps` 按下标对齐)。
   在 Forsion 仓里时,改完 manifest 用宿主真消毒器验一遍(命令见正典文档「前置条件与使用说明」节)。

范例:`samples/forsion-sample-bundle/`(setting 类 + `check.mjs` 断言 requires 的 key 都注册过)。

### 前置插件 requiresPlugins 与生命周期(2026-10-02 起)

- manifest `"requiresPlugins": ["other-id", { "id": "x", "minVersion": "1.2.0", "market": "x-slug", "name": "X" }]`(≤8 条;
  `market` = 市场 installSlug,设置页「在市场中查找」拿它预填搜索;`name` = 前置没装时显示的名字)。
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


## 当前模型与当前 Space:ctx.tangu(2026-08-29 起)

```js
const m = ctx.tangu?.activeModel()        // {id, name} | null —— 输入栏药丸显示的那个
const sp = ctx.tangu?.activeSpace()       // 'tangu' / 'home'(主页)/ 用户 Space id | null
const off = ctx.tangu?.subscribe(() => rerender())   // 只在这两个值**真变了**时回调,不是每次 store 变更
```

```js
const models = ctx.tangu?.models?.()   // 全部对话模型(只含 llm)—— 逐模型设置用
const s = ctx.tangu?.session?.()       // {contextWindow, contextTokens, sessionTokens, effort} | null
```

- ⚠️**`ctx.tangu` 在非 Tangu 宿主上整个不存在**(纯 Amadeus 壳 / unit 设备页 / 云端)—— 一律可选链 + 降级路径。
- `session()` **拉取式**:这几个值流式回答里每帧都在动,**故意不进 `subscribe` 的变更键**(进去 = 把订阅插件按帧敲一遍)。要跟着动就自己定时拉,或"开面板那一刻读一次"。`contextWindow` 未知给 **0**、`effort` 未知给 **null** —— 别把 0/空串当档位画出来。
- **能力探测,不是权限闸**:模型名不敏感,**不用**写 manifest `capabilities`(那道双闸给 `system.activeWindow` 那类)。
- 只读。要换模型,走引擎侧 agent(通用纪律 5),别指望这里;要**开一个对话**见下「开新对话」。

### Agent 状态:agentStatus / subscribeAgentStatus(2026-09-19 起)

「跟着 agent 做反应」的插件(Desk 伴随形象、状态栏小宠物)用这一对:

```js
const st = ctx.tangu?.agentStatus?.()   // 省略参数 = 主区活动会话;传 null = 新对话草稿(恒 idle);传 id = 那个会话
// → { phase, sessionId, runId, tool?, toolStage?, waitingFor?, since, until?, messageId?, textChars, reasoningChars,
//     agentSlug?, agentName? }
const off = ctx.tangu?.subscribeAgentStatus?.((s) => avatar.play(s.phase), /* sessionId? */)
```

| phase | 含义 |
|---|---|
| `idle` | 没在跑(草稿 / 空会话 / 用户已点停止 / done·error 的余韵过期) |
| `thinking` | 在跑,但在推理 / 等模型首帧 / LLM 重试 / 工具结果回来等下一轮 |
| `speaking` | 正在流式输出正文 |
| `tool` | 有工具在跑:`tool` = 工具名,`toolStage` = `'args'`(模型还在写参数)/ `'exec'`(执行中) |
| `waiting` | 等用户:`waitingFor` = `'approval'`(`tool` = 待批的工具名)/ `'inquiry'`(`tool` = `'ask_user'` / `'exit_plan_mode'`)。**优先级最高** |
| `done` / `error` | 刚结束 / 刚失败;带 `until`,到点自动回 `idle`(约 4s / 6s) |

- **订阅是变更过滤的**:只在 `phase / tool / toolStage / waitingFor / sessionId / agentSlug` 变了时回调,done/error 余韵到期再回调一次;
  **每个 token 不回调**(流式期间 store 每个增量都在动,裸转发 = 把你按帧敲一遍)。宿主在禁用/重载时统一退订,你自己也 dispose。
- **口型 / 说话量**:`speaking` 期间自己按帧(或 ~15Hz)拉 `agentStatus()`,对 `textChars` 做差分 + ~150ms 平滑;
  `messageId` 变了(换了一条气泡)重置基线,负增量钳 0。这是 token 速率包络,不是语音响度 —— TTS 响度目前拿不到。
- 已知空档(宿主没有状态可给,别当 bug 报):按下发送到 run 真正开始之间是 `idle`(新对话的 `sessionId` 会先从 null 变成新 id);
  发送失败只有一个 toast、没有状态;委派出去的子代理子会话读出来是 `idle`。
- Desk 伴随面里**别用这两个方法**,用 `mount` 递给你的 `host.status()` / `host.onStatus()` —— 那一份绑的是这张 Desk 所属的会话
  (被钉住的分屏聊天,会话 ≠ 主区活动会话)。
- 旧宿主 / 台架假探针没有 → 方法不存在或恒 `idle`;按 idle 处理即可。

**这个会话归哪个 Agent(`agentSlug` / `agentName`,2026-09-20 起)** —— 给「每个 Agent 一套设置」的插件用(Live3D 让每个 Agent 有自己的形象):

- `agentSlug` = 这个会话的 Agent。没显式选过 → 用户的默认 Agent;草稿会话(`sessionId: null`)→ 新对话界面上选中的那个。**外部引擎会话**(Claude Code 等 ACP 引擎,根本没有 Tangu agent)与推导不出来时**整条不给** —— 退回通用外观,别自己编一个 slug。
- `agentName` 是展示名,名册还没拉回来 / Agent 已删时**省略**。别把 `agentSlug` 当名字画出去,用你自己的兜底文案。
- 团队(群聊)会话报的是会话**配置的** Agent,不是当前发言的成员 —— 有意做成稳定的,免得形象在成员之间忽闪。
- `agentSlug` **进**变更过滤:用户换会话的 Agent 时 `subscribeAgentStatus` 正好醒一次;改 Agent 的展示名**不会**(要新名字就自己拉一次 `agentStatus()`)。

### Agent 名册:agents(2026-09-20 起)

要做「每个 Agent 用哪个形象」这类选择器,光有当前会话不够,得要名册:

```js
const list = ctx.tangu?.agents?.() ?? []   // → [{ slug, name }, …];旧宿主给 [] —— 退化成「只认当前会话的 Agent」
```

- 是快照不是订阅:打开设置页时读一次即可。含 Muse 这类系统 Agent(与主界面「选择 Agent」条同一份名单);Agent 没有展示名时 `name` 回落成 `slug`。
- 你自己存的 per-Agent 设置一律**按 `slug`** 建索引 —— 它就是 `agentStatus().agentSlug` 会还给你的那个稳定 id。名册里查不到的 slug = Agent 被删了(或名册还没拉回来):**留着那条设置**,只是别在选择器里列出来。

### 开新对话:startChat(2026-09-19 起)

插件的某个流程需要 **agent 接手**(例:「让 Agent 帮我导入这个模型」)时,用它开一个**用户看得见**的新对话,而不是后台偷跑:

```js
const r = await ctx.tangu?.startChat?.({
  agent: 'live3d-importer',            // 你捆绑包 agents/<slug>/ 里的 slug;不给 = 用户默认 Agent
  prompt: `Import the model at ${ctx.app.workFolder()}/incoming/a.vrm …`,   // 英文:模型读的
  send: true,                          // 直接送出 —— ⚠️只对你**自家捆绑包**的 Agent 生效
  folder: ctx.app.workFolder(),        // 库相对路径 → 新会话的工作目录(可选)
})
if (!r) copyToClipboard(prompt)        // 旧宿主 / 非 Tangu 宿主:没有这个方法,自己退化
else if (!r.ok) ctx.notify(r.error)    // 'unknown agent: x' / 'send failed' / 'prompt is required' …
```

- 宿主做的事 = 用户点「新对话」同一套:离开主页 Space → 主区聊天清成空白草稿 → 选 Agent → 打开聊天 → 送出或预填。
  `send:true` 成功时返回新会话 `sessionId`;**预填**(`send` 为假,或被降级)返回 `{ ok:true }` 不带 `sessionId`,由用户按回车。
- **`send:true` 只放行本插件捆绑包真正播种的 Agent**;别家 Agent / 不指定 Agent 一律**静默降级为预填** —— 插件不能替用户花
  别人 Agent 的 token、开别人的 host 工具。判据 = 清单里有(`agents/<slug>/config.toml`)**且**引擎当初是从你这个包播种的它
  (新播种时引擎写 `agents/<slug>/.bundle-origin` = 你的插件目录名)。⚠️**撞名拿不到直发权**:同 slug 在装你之前就已存在
  (用户自建的、默认 `xyra`、`muse`、别家插件先播的)时引擎永不覆盖,那个 Agent 不是你的 → 只预填。slug 起得独特些
  (带上插件名前缀,如 `live3d-importer`);非本机桌面宿主(web / 移动端)问不到播种标记,一律预填。
- `folder` 是**库相对**路径,宿主经与 `ctx.app.hostPath` 同一个函数解析成本机绝对路径;没有库 / 引擎不在本机
  (云端、web)/ 路径带 `..`、以 `/` 开头、带盘符 → **忽略**(用默认工作区),不报错。目录首写即现 —— 先把文件
  `writeBytes` 进去再开对话。工作区内的写入不会触发「工作区外写入」的升级审批(仍按用户自己的审批档)。
- Agent 名册里没有这个 slug 时,宿主会先刷一次名册再等最多 3s(插件刚装、捆绑 Agent 刚播种进引擎的情况),仍没有才回
  `unknown agent`。提示词上限 20000 字符,超了直接拒(不截断)。
- **别在 `setup` 里调**,只在用户点了按钮之后调 —— 它会切走用户当前的主区聊天。

### 把对话挂进自己的视图:mountChat(2026-10-04 起)

`startChat` 是把用户**送去**主区聊天。你的 Space 自己就需要一个常驻对话时(创作类工作台右栏那种:边看作品边让 Agent 改,
生成的东西直接落进项目文件夹),把宿主的原生对话**挂进你自己的视图**:

```js
let chat = null
ctx.registerView({ id: 'chat', title: 'Chat', mount(el) {
  el.style.height = '100%'                        // 对话撑满容器,容器得有确定的高度
  chat = ctx.tangu?.mountChat?.(el, {
    agent: 'my-director',                         // 名册里有就行;不给 = 用户默认 Agent
    folder: 'Video/My film',                      // 库相对路径 → 这条会话的工作目录(可选)
    title: 'My film',                             // 只在新建会话时用(可选)
  })
  if (!chat) { el.textContent = 'Chat needs a newer Forsion'; return }   // 旧宿主:没有这个方法,退回 startChat
  return () => { chat.dispose(); chat = null }
} })
ctx.openView('chat', { location: 'right' })

// 别处(时间线的右键菜单之类):把选中的东西引用进对话,由用户接着打字提问
chat?.quote('Scene "intro" · <h1 data-in="0.4" data-fx="rise">Hello</h1>')
// 一键任务:先把对话揭到前台,再把一句请求放进输入框,回车由用户按
ctx.openView('chat', { location: 'right' }); chat?.prefill('Write an original score for this video.')
```

- 挂进去的是**同一个**对话:输入框、模型 / 思考档、消息流、工具展示、审批都是原生的,只是固定在一条会话上(不跟随主区)。
- **会话**:一个(插件, `folder`)一条,宿主记在本机。下次挂载先问引擎它还在不在 —— 在就接回(历史照常在);用户把它删了 / 归档了
  就新开一条;换了 `folder` 就是另一条。它是一条普通会话,主区的会话列表里也看得到(用户想重新开始:在那里删掉它)。
- **`folder`**:库相对,宿主解析并钳在库内(与 `ctx.app.hostPath` 同一个函数)。给了它,会话在本机执行、相对路径都落在这个
  文件夹里 —— `generate_image` 写进 `<folder>/generated/`,Agent 改的就是你的项目文件。宿主**等后端就绪后才解析**,所以应用
  刚启动、桌面配置和笔记库还没回来时就挂载也没问题(别自己拿 `hostPath` 抢先判断,那一刻它可能还是 null)。
  ⚠️与 `startChat` 不同:给了 `folder` 却落不到本机路径(没有库 / 引擎不在本机 / 路径越界)→ `ready` 给 `ok:false`,
  **不会悄悄退成沙箱对话** —— 常驻对话接错目录比开不了更糟。不给 `folder` 才是不带工作目录的沙箱对话。
- **永不替用户送出**,回车由用户按。句柄给两条路:`quote(text)` 挂成输入框上方的引用条(不动草稿,适合「引用这个元素再提问」);
  `prefill(text)` 接在输入框草稿后面并聚焦(适合一键任务,同 Image Studio)。两条在对话还没接上时调用都不丢;
  `prefill` 在你的视图还压在后台标签里时也照样落进输入框,连调几次按先后都接上;想让用户马上看见,先 `ctx.openView`
  把视图揭到前台。都只有文字,没有附件。
  所以 `agent` 不要求是你捆绑的(与 `startChat` 的预填档同一口径)。
- `ready` → `{ ok:true, sessionId }`;后端没连上 / `unknown agent` / 建会话失败 → `{ ok:false, error }`,不抛,界面上自带「重试」。
  拿到的 `sessionId` 可以喂给 `agentStatus(sessionId)` / `subscribeAgentStatus(cb, sessionId)`,跟着这条对话的状态做反应。
- **已知限制**:同一个(插件, `folder`)同一时刻只挂一处 —— 挂两处是同一条会话的两个输入框,`prefill` 落到先接走的那个;
  `quote` 走的是全应用共用的一个引用位,连着引用两次只留后一次。
- 视图卸载时自己 `dispose()`;插件被禁用 / 重载时宿主统一卸掉,旧句柄的 `quote` / `prefill` 不再生效。
  `dispose()` 之后 `el` 立刻还给你(宿主只动自己挂进去的那一层,见「dispose 契约」):换一个 `folder` 时先 `dispose()`,再在同一个 `el` 上挂新的即可。
  **只在有对话能力的宿主上存在**:`ctx.tangu?.mountChat`,缺席时退回 `startChat`。

## 正文 AI:ctx.tangu.complete 与 registerSelectionAction(2026-09-28 起)

**别再直连 `POST /agent/runs` 做「改写这段」**:那是 Agent 的 run(带工具、落会话、slash 结果还有 8192 字符上限),又重又会
在用户的会话列表里留痕。正式接口是一次性补全(引擎 `POST /agent/inline`:**无工具、不落库、不进任何会话**):

```js
const r = await ctx.tangu?.complete?.({
  prompt: 'Turn this into a checklist',   // 给模型的指令(英文最稳;模型读的)
  selection: cx.markdown,                 // 可选:要处理的正文(按数据对待,不当指令)
  before, after,                          // 可选:前后文
  signal: ac.signal,                      // 可选:取消
  onDelta: (d) => preview.append(d),      // 可选:流式增量
})                                        // → { text } —— 待插入的 markdown;旧宿主 / 非 Tangu 宿主没有这个方法
```

写进笔记**必须经用户确认**:把「拿结果」包进 `registerSelectionAction`,宿主替你开预览面板(与内置的「润色 / 翻译…」同一块),
用户点「替换 / 插入下方」才写,Esc / 丢弃 = 一个字不动:

```js
ctx.registerSelectionAction({
  id: 'checklist',
  title: ctx.getLocale?.() === 'en' ? 'To checklist' : '转成清单',
  run: async (cx) => (await ctx.tangu.complete({ prompt: 'Turn this into a markdown checklist', selection: cx.markdown })).text,
})
```

- `cx` = `{ text, markdown, pagePath }`:选区纯文本、选区的 markdown(保留加粗 / 链接 / 列表符)、笔记库相对路径。
- `run` 返回 `''` = 什么都不提议;返回值按 slash `run` 同一套校验(必须是字符串、不许控制字符)。
- 模型缺省 = 主区聊天当前用的那个;额度与用量照主聊天口径扣、记。插件被停用时在飞的 `complete` 会被中止并 reject。
- 只有 v4 笔记的选区工具栏有「AI ▾」;宿主做不了(探针没有 `complete`)时整个菜单不出现,你的项也不会出现。

## Agent Desk 伴随面:ctx.desk(2026-09-19 起)

往 Tangu 聊天右侧的 **Agent Desk**(右栏那张卡片 + 展开后的侧板)里挂一块自绘区域,典型用法是会跟着 agent 状态做反应的 3D 形象:

```js
const h = ctx.desk?.registerCompanion({
  id: 'avatar',                          // 宿主拼成 plugin:<pluginId>:avatar
  mode: 'idle',                          // 'idle' | 'always',见下表;之后可 h.update({ mode }) 就地切,不重挂
  mount(el, host) {                      // el 已撑满可用区域、position:relative;返回卸载函数
    // host.surface: 'desk-card'(卡片,只读预览)| 'desk-panel'(展开侧板,可交互)
    // host.sessionId(): 这张 Desk 的会话;新对话草稿 = null。首条消息发出(null → 真 id)与切会话都**不重挂**
    // host.status() / host.onStatus(cb): 这张 Desk 所属会话的 agent 状态(同 ctx.tangu.agentStatus 的形状与变更过滤)
    const off = host.onStatus((s) => avatar.play(s.phase))
    return () => { off(); avatar.detach() }
  },
})
// 设置页切模式:h?.update({ mode: 'always' });撤下:h?.dispose()。禁用/重载时宿主统一收。
```

| 模式 | 卡片 | 展开侧板 | Desk 的文件展示 |
|---|---|---|---|
| `idle` | Desk **没有任何展示条目**时(草稿 / 空会话 / 清空后)显示伴随面;agent 一往 Desk 上放东西就让位,卡片与侧板头部出现「清空 Desk」把它请回来 | 照旧显示文件 | 照旧 |
| `always` | 永远只显示伴随面 | 只显示伴随面 | **整体停用**:`desk_present` / 编辑自动上台 / 直播格不再落状态,聊天里点引用、概览里点「正在编辑」一律走新标签页 |

- **同一时刻只有一个生效者**:最后注册的那个(栈顶),它 `dispose` 后退回前一个。用户在设置里关掉了 Agent Desk 时伴随面也不出现(注册照常成功)。
- 伴随面在场时(`always` 下,以及 idle 模式 Desk 为空)agent 的 `desk_screenshot` **照截你画出来的形象**,工具结果会写明「这是插件伴随面 `plugin:<你的 id>:<id>`,不是你放上来的内容」—— 所以别画会被误读成「agent 的产出」的东西(比如仿文件预览)。想让 agent 判读形象,在你的技能里写明它能 `load_tools(["desk_screenshot"])` 自己看。
- ⚠️**两个挂载点、可能同时多份**:卡片与侧板是两次独立的 `mount`,收起/展开在两者间切换;主区、右侧 chat-panel、分屏钉住的
  会话各有一张卡片。重资源(解析好的模型、贴图)**缓存在模块级**,每次 mount 只建自己的 renderer;卸载时
  `renderer.dispose()` + `renderer.forceContextLoss()` —— Chromium 同时存活的 WebGL 上下文上限约 16 个。
- **卡片正文是 `zoom: 0.75` + `pointer-events: none`**:卡片里收不到任何指针事件(只有整卡点击展开),旋转视角 / 戳模型这类交互只能
  放在 `desk-panel`。卡片宽约 280px、高约「聊天列高的一半」,圆角裁切。
- **WebGL 尺寸(zoom 下最容易错)**:canvas 的 CSS 保持 `width/height:100%`,绘图缓冲按**视觉尺寸**设:
  `renderer.setPixelRatio(devicePixelRatio); renderer.setSize(rect.width, rect.height, false)`,`rect = el.getBoundingClientRect()`。
  ⚠️第三个参数 **必须 `false`**:three 默认会把 278 这种视觉像素写回 style,在 zoom 0.75 里只铺满约 75%;用 `clientWidth`
  (局部像素 371)能铺满但多渲染约 1.33 倍像素。别信 ResizeObserver 的 `devicePixelContentBoxSize`(zoom 下给错值)。
- **resize 合并到 rAF**:侧板有 0.45s 的宽度过渡,拖宽把手逐帧改尺寸。指针换 NDC 一律用 `getBoundingClientRect()` 的比例(对 zoom 免疫),
  别把 `offsetX` 局部像素和视口 `clientX` 混用。
- **隐身但仍挂载**:聊天列窄于 760px 时卡片 `display:none`,组件却还在 —— canvas 变 0×0 而 rAF 照跑。尺寸为 0 / IntersectionObserver
  不相交 / `document.hidden` 时暂停渲染循环;`prefers-reduced-motion` 下减弱待机动画。
- 贴图 / glTF 的 CSP 注意事项见下「库内二进制资源」。

## 自动化规则播种:ctx.automation(2026-09-02 起)

插件给一批**多维表触发**(`db_changed`)的规则,宿主幂等 upsert 到引擎(`POST /agent/special/muse/triggers`),
每次 `setup` 重放即可 —— 同 `key` = 同一条规则(更新),不会越种越多。

```js
// setup 里:别 await —— ensure 会等后端与库就绪(最多 60s),阻塞 setup 等于把整个插件挂住
void ctx.automation?.ensure([
  {
    key: 'out-added',                       // [a-z0-9-]+;宿主拼成 plugin:<pluginId>:out-added
    desc: '出库新增 → 扣库存',
    cond_type: 'db_changed',
    path: `${ctx.app.workFolder()}/出库记录.db`,   // 库相对路径,**自己拼** workFolder,宿主不替你前缀
    event: 'row_added',                     // 或 'cell_changed' + column_id(+ equals)
    where: [{ column: '配件', op: 'notempty' }],   // 可选,≤10 条,与 equals AND;op: eq/ne/empty/notempty
    actions: [                              // 只许 notify / db_row_add / db_row_edit(agent_run / tool_call 该条被拒)
      { type: 'db_row_edit', path: `${ctx.app.workFolder()}/库存表.db`, rowFrom: '配件',
        cells: { 数量: '{{= {target.数量} - {row.出库数量} }}' } },
    ],
    // cooldown_hours 可省略:纯动作链缺省 0(链式规则需要);要冷却就显式给
  },
]).then(({ ok, errors }) => { if (!ok) console.warn('[pc-erp] automation', errors) })
```

- **返回** `{ ok, errors }`,永不抛。单条坏规则(key 形态 / path 不是库内 .db / where 超限 / actions 含 agent_run|tool_call /
  `skipIfEmpty` 不在 cells 键里)只拒那一条,其余照发;**没开库(等 60s 仍没有)→ 整批不发**,errors 里是 `No vault is open`;
  后端没起来(托管后端启动中)→ 整批不发。**失败的 ensure 宿主会自动重放**:后端下次从「未就绪」翻到「就绪」
  (托管引擎起来 / 重连 / 换 token 后重新连通)时,对上次失败且插件仍启用的规则集原样再发一次(同插件两次重放至少隔
  30s,最多 3 次);成功过的不重发。插件不必自己盯后端状态重试。
- `vault` 由宿主绑**当前库**,规则只在那个库里触发;`path` 归一与引擎同口径(反斜杠→正斜杠、去首尾斜杠与空段),
  拼法要稳定 —— path 一变引擎就认为条件变了、重新播种游标,期间新增的行不再触发。
- **恒 `enabled:true`**:用户在自动化面板里单独关掉你的某条规则,下次插件重载 ensure 会把它开回来;要"可关"就把开关做成自己的设置项、按设置项决定发不发。
- 用户**禁用插件** → 宿主把 `plugin:<id>:` 前缀的规则全部 `enabled=false`(不删);再启用时 ensure 置回 true,引擎重新播种游标(停用期间加的行**不会**一次性爆发)。
- 聊天里的 agent 经 `manage_automation` **不能改/删** `plugin:` 前缀的规则;用户能在自动化 Space 里看、编辑(构建器认得 where / rowFrom / match / skipIfEmpty)。
- 动作字段速查:`db_row_add.skipIfEmpty`(cells 的一个键,展开为空则跳过本步);`db_row_edit` 目标行 `rowId` > `rowFrom`(触发行的关联列,多值逐行)> `match {column, value}`(目标表全部命中行)> 触发行;
  单元格值支持 `{{row.X}}` / `{{target.X}}` / `{{= 算术 }}`。形状正典 = `desktop/frontend/src/types.ts` 的 `MuseTriggerUpsert` / `AutomationActionSpec`。

## 日历成员登记:ctx.calendar(2026-09-02 起)

Calendar Space 是**显式成员制**:有 `calendarDate` 列的表不会自动出现在日历里,得登记。插件种下任务表后:

```js
ctx.calendar?.ensureMember(`${ctx.app.workFolder()}/任务表.db`, 'c-date' /* 日期列 id */, 'c-done' /* 可选:完成勾选列 id */)
```

- 同步返回 void。已是成员 → **no-op**(不覆盖用户改过的列映射);库还没恢复 → 等库恢复后再登记(最多 60s)。
- 列给的是**列 id**(不是列名);日期列用 `calendarDate` 类型。
- 与 `ctx.automation` 不同,这条不需要 Tangu 宿主 —— 纯 Amadeus 壳也有;旧宿主没有,可选链。

## Floating Panel:正式第六种面板(2026-09-17 起)

设置、市场、成就、反馈这类独立工具页不再自己盖全屏，统一走 Floating Panel。插件也先 `registerView`，再开面板：

```js
ctx.openFloatingPanel?.('inspector', {
  title: 'Inspector', params: { source: 'command' },
  width: 880, height: 640, minWidth: 560, minHeight: 420,
})
```

- 桌面端是真 BrowserWindow：可拖、可缩放、可最小化/关闭，并保持在主窗口上方；相同插件 view id 复用窗口。
- Web 是主界面上方固定居中的面板，**故意不可拖**；移动端不伪造桌面窗口，回退普通主视图。
- `mount(el, view)` 收到 `view.surface === 'floating'`，没有 `extendView`；`getParams/setParams/onParamsChanged` 照常，`showInMainPanel?.()` 将当前参数交回主区。
- 宿主自动命名空间，插件只写自己的相对 id；禁用插件或反注册 view 后，已开的原生窗口/Web 面板自动关闭。`mount` disposer 必须收订阅和计时器。
- 详细契约见 `Forsion-Genesis/docs/customization/floating-panel-development.md`；桌面回归 `npm run build && npm run check:floatingpanel`。

## 自绘浮层 / HUD:三条纪律

整页工具优先用正式 Floating Panel。只有锚定菜单、短时 HUD、画布工具等不适合注册成独立 view 的小层，才在渲染进程自行挂 DOM。此时：

1. **接鼠标的覆盖层根必须 `-webkit-app-region: no-drag`,且 append 到 body**(DOM 顺序须晚于 Shell)。mac 拖窗区按 **DOM 顺序**合成、**与 z-index 无关**;ribbon 与左侧栏是拖窗区,重叠矩形内的点击/hover/滚轮全被吞。**浏览器台架照不到,只有真 Electron 能验。**
**⚠️反向纪律:不遮挡的「HUD 层」正相反,绝不能写 no-drag。** 全屏浮层要 no-drag 是因为它盖住了拖窗区
还要能点;而一层**贴在角落、`pointer-events: none` 的装饰层**(游戏式 HUD、演出提示、角标)落在 ribbon
的拖窗区上,写了 no-drag 等于把那块**从拖窗区抠掉** —— 用户从此拖不动窗口,而且这个 bug 与浮层本身
毫无关系,极难联想。`-webkit-app-region` 是**几何合成**,与 hit-test 无关:`pointer-events: none` 挡不住它,
默认值 `none` 才是「既不加也不减」。判据一句话:**浮层要接鼠标 → no-drag;浮层纯装饰不接鼠标 → 什么都别写。**

2. **别指望 z-index 压过 Shell**(`.shell-host{isolation:isolate}` 已封箱)—— 靠 DOM 后置取胜。
3. **锚定式浮层别手写 `left/top`**:`body` 常年带 CSS zoom,`fixed` 的 `left/top` 也吃 zoom。整屏 `inset:0` 不受影响;贴元素的走 `@lcl/engine` 的 `OverlayAt`/`clampMenu`。

**裸字母快捷键别注册成宿主热键**:`installHotkeys` 没有输入焦点闸,绑了 `f` 会在聊天框打字时触发。自挂 `keydown`,守卫必须含 `e.isComposing || e.keyCode === 229`(中文输入法选字)+ `INPUT/TEXTAREA/isContentEditable` + 「别的全屏浮层开着时让路」。顺带**也**注册一条 `registerCommand`,命令面板能搜、用户能改键。

参考实现 `Forsion-Instrumentality-Project/forsion-plugin-inspect`(检视台),`check.mjs` 把这几条做成了静态断言。

## 库内二进制资源 + 第三方库进包(2026-08-29 起)

`ctx.app.readFile` 只读 UTF-8。`.glb` / 字体 / 任意 blob 走资源协议:

```js
const buf = await fetch(`amadeus-asset://v/${encodeURIComponent(vaultRel)}`).then((r) => r.arrayBuffer())
```

按 vault 夹紧(越界 403)、支持 Range、`<img>`/`<video>` 也能当 `src`。⚠️**需要 Forsion ≥ 2.9.0**(CSP 的 connect-src 放行它是 2.9.0 才进的,2.8.1 及更早没有)—— 更早版本 CSP 的 `connect-src` 没放行它,症状是「`<img>` 能显示、fetch 一律 `Failed to fetch`」。文件让用户放进 `ctx.app.workFolder()`,`ctx.app.listFiles?.()` 列出来;**别随包分发大资产或有版权的第三方资产**。仪器:desktop 的 `npm run check:assetfetch`。

**写/读字节(2026-09-19 起)**:`ctx.app.writeBytes?.(path, bytes)` / `ctx.app.readBytes?.(path)`。导入用户选的文件
不需要宿主的文件对话框 —— 在自己的 DOM 里放 `<input type="file" accept=".vrm,.glb" multiple>`(或拖放区),
`File.arrayBuffer()` 没有大小上限:

```js
const bytes = new Uint8Array(await file.arrayBuffer())
await ctx.app.writeBytes?.(`${ctx.app.workFolder()}/models/${file.name}`, bytes)   // 原子写、父目录自动建、已存在即覆盖
const back = await ctx.app.readBytes?.(`${ctx.app.workFolder()}/models/${file.name}`)  // Uint8Array | null
```

- 路径口径同 `writeFile`(库相对、越界由宿主钳死);收 `Uint8Array` / `ArrayBuffer` / 任意 TypedArray 视图(按字节原样)。
  没有活动库 → `writeBytes` reject `'No vault is open'`,`readBytes` 给 `null`(见上「没有活动库」表)。
- ⚠️**不走自写账本**:同一路径上的 `watchFile` 会把你自己这次写当成外部改动回调一次 —— 别 watch 自己写的二进制。
- 多文件模型(`.gltf` + `.bin` + 贴图)要保留相对目录:`<input webkitdirectory>` 给每个 `File` 带 `webkitRelativePath`,逐个写到
  `${dest}/${f.webkitRelativePath}`。

**three.js 模型的两个坑**(`.glb` / `.vrm` / `.gltf`):
- **内嵌贴图**:GLTFLoader 在 Chromium 上用 `ImageBitmapLoader`,对内嵌图片走 `fetch(blob:)`;`.gltf` 里 base64 的 buffer 走 `fetch(data:)`。
  2026-09-19 起宿主 CSP 的 `connect-src` 放行了 `blob: data:`,原生 loader 直接能用;**更早的宿主**上贴图加载失败会被 loader 吞掉,
  症状是「模型出来了但一片白、只有一行 console.error」。兼容写法(贴图改走 `<img>`,`img-src` 一直放行 blob:):
  `loader.register((p) => { p.textureLoader = new THREE.TextureLoader(p.options.manager); return { name: 'forsion_csp_texture_fallback' } })`
  —— 旧宿主上 `.gltf` 的 base64 buffer 仍然不行。仪器:desktop 的 `npm run check:assetfetch`(T5–T7)。
- **相对 URI**:`amadeus-asset://v/<encodeURIComponent(整条路径)>` 把 `/` 编成了 `%2F`,`.gltf` 里 `tex/a.png` 这种相对引用按它解析会 404。
  用 `parse(buf, '')` + `manager.setURLModifier((u) => /^(blob:|data:|amadeus-asset:|https?:)/.test(u) ? u : ctx.app.assetUrl(join(dirOf(modelPath), decodeURI(u))))`,
  每端都对(web / unit 的资源 URL 是 `?ref=` 形,拼 base URL 那条路只在桌面成立)。

CSP 是 `default-src 'self'`(没有 CDN),依赖一律 esbuild `bundle: true` 打进单文件。`main.js` **没有大小上限**。需要 disposer 时:

```js
// build.mjs —— IIFE 的返回值会被丢掉,用 globalName + footer 把它 return 出去
globalName: 'myPlugin', footer: { js: 'return myPlugin.dispose;' }
```

## 插件文件读写与「工作文件夹」(2026-08-03 起)

桌面插件的文件面 = 活动笔记库(vault):`ctx.app.readFile/writeFile` 走 vault 相对路径,**整库可读写**,宿主钳死越界(路径逃逸抛错);写入原子落盘、父目录自动创建。落盘位置约定:**每个插件在设置详情页自动获得一条「工作文件夹」**(key `workFolder`,默认=插件显示名),产出一律写 `${ctx.app.workFolder()}/…`,别自造存储夹设置;给用户的产物存 **markdown**(可引用可检索),机器数据放点开头隐藏 sidecar。旧宿主没有 `workFolder`,兼容写法同 `ctx.notify`:

```js
const folder = ctx.app.workFolder ? ctx.app.workFolder() : '<插件名>'
// ⚠️workFolder() 照常返值 ≠ 写得进去:没有活动库时 writeFile 会 reject('No vault is open')。
//    启动期的写一律 try/catch(见上「没有活动库时的统一行为」表)。
try {
  await ctx.app.writeFile(`${folder}/笔记.md`, markdown)
} catch (e) {
  ctx.notify?.(`没写成:${e?.message || e}(先打开一个笔记库)`, { level: 'warn' })
}
```

要自定义这条设置的 label/描述,setup 里自注册同 key 的 setting(同 key 重注册即覆盖标准行);用户改文件夹不迁移旧文件,读端自己做旧夹兜底。范例:`bluebird` 1.3.0(分析完自动保存 + 旧夹兜底 + check.mjs 迁移断言)。Session 同款约定:Tangu 会话默认工作区在笔记库 `Sessions/`——插件产物与会话产物同库,都能被笔记引用。

## 块表面:当前这篇笔记的读写(2026-07-26 起;2026-08-20 改口径)

> **⚠️ 先看 `page.model`。** 普通笔记如今默认是 **v4/unified** 载体,**没有块 id** —— `blocks`/`order`
> 在它上面恒空,正文在 `page.text` 里。块寻址类调用在 v4 笔记上**诚实拒绝并 warn**(不静默),
> 改内容一律用两条路由都成立的 `insertMarkdown`:
>
> ```js
> const pg = ctx.app.getPage()
> const text = pg.text ?? (pg.order || []).map((id) => pg.blocks[id]).join('\n\n')  // 新老宿主通吃
> if (pg.model === 'blocks') { /* v3:可以按块 id 寻址 */ }
> ctx.app.insertMarkdown?.(pg.token, '> 一段引用', 'start')   // 'cursor'(缺省)/'start'/'end'
> ```
>
> **`mountBlocks` 完整可用的地方是插件自定义文件类型**(`.mindmap.md` / `.canvas.md`,经 `file.surface`)
> —— 那类文件按设计钉在 v3,思维导图那套一个字都不用改。下面这段讲的就是它。

**能力对等原则**:内置插件和外置插件拿到的 `ctx` 一模一样,唯一区别是内置的**已经装好了**。此前不是这样 —— 内置插件跑在进程内、能直接给 React 组件,所以只有它们能渲染真块;外置插件是裸 `setup(ctx)` 体,只有 DOM。补上 `ctx.app` 的块表面之后这条缺口关掉了。

想做「一个节点/一张卡片里就是一个可编辑的 Amadeus 块」这类界面(思维导图、看板、白板便签),别自己复刻编辑器 —— **把 DOM 交给宿主渲染**:

```js
const page = ctx.app.getPage()   // {token, path, status, text, model:'blocks'|'text', blocks, order, fmExtra}
const dispose = ctx.app.mountBlocks(el, {
  token: page.token,
  blockId,
  // 传了 onInsertAfter = 宣告「块结构归我管」:笔记式结构键(块首退格并块 / 方向键跨块 / 上下移块)
  // 被中和,而「会新建下一个块」的动作(/数据库 脚手架、非空块里 Shift+Enter)重路由到这里。
  onInsertAfter: (id, content) => addChildNode(id, content),
})
```

**改数据一律要带 `page.token`**:块 id 是**页内**递增的(两页都有 `b1`)。插件拿着 A 页的 id、用户已切到 B 页时继续提交,轻则把块插进 B、重则删掉 B 的同名块 —— 令牌不匹配宿主直接拒绝并 warn。每次 `await` 之后重新 `getPage()` 取新令牌。

| | 用途 | v4 笔记 |
|---|---|---|
| `getPage()` | 当前这篇的快照(**冻结且全插件共用,别改它**) | ✅ |
| `getPage().text` | 整篇正文 markdown(v3 = 块按 order 拼) | ✅ |
| `getPage().model` | `'blocks'`(v3)/ `'text'`(v4)。**分叉判据**;老宿主没这字段 → 当 `'blocks'` | ✅ |
| `subscribePage(cb)` | 正文/块/顺序/外来 frontmatter 变了才回调,返回退订函数 | ✅ |
| `insertMarkdown(token, md, where?)` | 插一段 md,`where` = `'cursor'`(缺省)/`'start'`/`'end'` | ✅ |
| `insertBlockAfter(token, afterId, content)` | 建块,返回新 id(`afterId=null` = 插到最前) | ❌ 返 `null` |
| `deleteBlock(token, id)` | 删块(async) | ❌ |
| `setFmExtra(token, text)` | 写**外来 frontmatter**——你的每页数据存这儿,进页面撤销栈 | ❌ 读可以,写还没开 |
| `undo(token)` / `redo(token)` | 走页面自己的撤销栈(结构改动天然可撤销) | ❌ |
| `requestFocus(id, place)` / `consumeFocus(id)` | 把光标送进某个块(只读焦点,不要令牌) | ❌ |
| `mountBlocks(el, {token, blockId, …})` | 宿主往你的 DOM 里渲染真块 | ❌ 插件文件类型面照常 ✅ |
| `prompt(title, initial)` | 模态输入。**Electron 没有 `window.prompt`,永远别用 DOM 那个** | ✅ |

坑,按踩到的顺序:

- **`page.text` 只读,而且在 v4 上是「上次保存那一刻」的快照**(≤800ms 陈旧)。**绝不「读全文 → 改 → 整篇写回」**:那 800ms 里用户敲的字会被你抹掉。改内容只有 `insertMarkdown`;插进去的文本必须能原样 markdown 往返(连续空格被压 → 宿主重载整篇 → 你的插件状态全没)。
- **不给 v4 合成块 id 是刻意的**:PM 顶层节点没有身份,按位置编号的 id 用户按一次回车就全体位移,而令牌只挡「换了一篇」挡不住「同一篇里 id 易主」。宁可空,不可假。
- **只服务活动页**。Amadeus 是「单活页」模型(同一时刻只加载一处,笔记编辑器和文件类型视图共用),插件跟着走。令牌闸是宿主兜的底,你自己也别拿旧快照连环操作。
- **`fmExtra` 要外科式改**:用户和别的插件的键也在同一份 frontmatter 里,整段重写会抹掉它们。**绝不把数据塞进 `amadeus_layout`**(zod 无 passthrough,未知键加载即被 strip)。
- **`blocks` 的引用是稳定的**:`subscribePage` 靠引用比较去重,自己缓存派生结果时也按引用判,别每帧深比较。快照本身是 `Object.freeze` 的(全插件共用一份,改它没用也不许改)。
- **块 id 会被复用**:落盘前剪掉指向已不存在的块的记录,否则新块会继承旧记录的状态。
- **自己的浮层要小心 `transform`**:`.slash-menu` / 行内工具栏这些是 `position: fixed` + 视口坐标;你的画布若带 pan/zoom 的 `transform`,它就成了 fixed 的包含块,浮层会被平移+缩放一次。把浮层传送到最近的 `.am-app` 下。
- **忘记清理宿主也会兜**:插件被禁用/重载/`setup` 抛错时,你开的 `subscribePage` 与 `mountBlocks` 由宿主统一收掉,之后整份 `ctx.app` 块表面变哑(在飞的异步任务改不动用户文件)。但这是安全网不是设计:该 dispose 还是要 dispose。`mountBlocks` 返回的 dispose 调用之后 `el` 立刻归还(见「dispose 契约」);dispose 再挂是一个新的编辑器,用户正在输入时别这么做(焦点和选区会丢)。
- **内置类型优先是硬规则**:`registerFileType` 的后缀若已被内置认领(`.excalidraw.md`/`.db`/`.pdf`/图片),宿主**拒绝注册并返回 `false`** —— 拿到 `false` 就整体退让,连创建器/斜杠项/命令一起别注册(那几个宿主拦不住,不退让用户会看到两份「新建 X」)。旧宿主返回 `undefined`,所以判定写 `=== false`。
- **四条新建主路径都要注册**:文件树右键(`registerFileCreator`)、命令面板(`registerCommand`)、笔记里的 `/`(`registerSlashItem` + `run()`,建完就地嵌入)、**新建标签页启动器**(2026-07-26 起也列 `registerFileCreator`,与内置的「新建白板」并排)。少注册一条,用户就会问「为什么 XX 里没有它」。
- **想做「节点/卡片里是真块」的界面,照 `forsion-plugin-mindmap` 3.0.0 抄**:它是块表面 seam 的样板 —— 一层薄适配(`src/host.tsx`)把 `ctx.app` 伪装成宿主 store/组件的形状,画布本体几乎原样;令牌只在适配层管一次。⚠️那层里按内容去重的缓存**不是优化是正确性**:`getPage()` 每次返回新对象,不去重则 `useSyncExternalStore` 每次判「变了」→ 无限重渲挂死。React 也内联进包(插件拿不到宿主模块图;两份 React 共存没问题,边界就是 `mountBlocks` 那个 DOM 节点)。

## 伸进编辑器 + 自绘设置面板(2026-08-15 起)

「能力对等」的第二批兑现。此前只有宿主内置能碰笔记编辑器的按键与装饰,插件的设置也只能是一排
number/boolean/text 旋钮 —— 这两条卡死了一整类插件(输入法式片段展开、语法高亮、规则表编辑器)。
参考实现:`Forsion-Instrumentality-Project/forsion-plugin-latex-suite`(四条接缝全用上了)。

```js
// ① 往笔记编辑器里注 ProseMirror 插件。外置插件**没有 import**,所以宿主把自己那份 PM 递进来。
ctx.registerEditorExtension?.((pm) => [
  new pm.Plugin({
    key: new pm.PluginKey('my-thing'),
    props: {
      handleTextInput(view, from, to, text) {
        if (view.composing) return false      // ⚠️中文输入法组合中途绝不介入
        return false                           // 不处理就 false,把输入还给宿主
      },
    },
  }),
], { priority: 'high' })   // 'high' = 排在宿主全部插件之前(要抢 Tab 这类已占用的键才用)

// ② 自绘设置面板:宿主给裸容器,里面画什么全归你
ctx.registerSettingsView?.({ id: 'main', title: '高级', mount(el) { /* … */ return () => {} } })

// ③ 每插件一份 JSON blob(<Forsion 家目录>/plugins-data/<id>.json,dev 与安装版各一份,原子写)
const data = (await ctx.loadData?.()) ?? { rules: [] }
await ctx.saveData?.(data)

// ④ 库内文件的外部改动订阅(热重载用户手写的配置文件)
const off = ctx.app.watchFile?.('Snippets/latex.js', () => reload())
```

坑,按会栽的顺序:

- **`priority: 'high'` 是有义务的**:它坐在每一次按键最前面,**不该自己处理的必须 `return false`** ——
  少一个 false,宿主的列表缩进/回车分块在用户那里就静默消失了。只为「要接管宿主已占用的键」用它,
  纯装饰(高亮、隐藏、气泡)一律缺省 `'normal'`。
- **`pm` 里有什么就用什么**:`Plugin PluginKey Selection TextSelection NodeSelection Decoration
  DecorationSet Slice Fragment keymap InputRule inputRules`。`import type` 拿类型可以(会被擦掉),
  **运行时不许 import prosemirror** —— 打进包里就是第二份 PM,`instanceof` 与 PluginKey 全对不上。
- **factory 每个编辑器实例调一次**:一篇 v3 笔记是很多个小编辑器,别把「每编辑器状态」挂在工厂外的共享对象上。
- **零 schema / 零序列化**:只能产生纯文本改动 + 装饰 + 按键拦截。想改落盘格式的不走这条路。
- **`props.*` 宿主包了 try/catch,`state.apply` 没包** —— 后者吞异常等于放任状态损坏。状态迁移自己写稳。
- **设置面板会被反复挂载卸载**(用户来回进出详情页):状态别放模块级单例,dispose 要真收干净
  (定时器、DOM 监听、内嵌的 CodeMirror 实例)。容器上有宿主主题变量但**没有样式重置**,自己带样式、深浅色都要过。
- **大块数据用 `loadData/saveData`,别塞 localStorage**:`registerSetting` 是每键一个字符串,没有原子性。
  用户手改坏了 JSON,宿主返回 `null` 当没写过 —— 插件要能靠默认值起来。
- **`watchFile` 缺位时整条方法不挂**(不是空壳):`if (ctx.app.watchFile) … else 轮询` 才走得对。
  它只报「内容变了」,新建/删除/改名不报;自己 `writeFile` 落的盘不会回声。

## 在 Coding Studio 里边写边看:Sandbox(2026-09-21 起)

桌面插件(Forsion 插件,`manifest.json` + 文件即 `setup(ctx)` 函数体的 `main.js`)可以直接从 Coding Space 的项目文件夹加载进正在运行的 Forsion,不用先拷进 `~/.forsion/plugins/`:

- **项目形态**:`manifest.json` 与 `main` 指向的文件放在**项目根**。Coding Studio 据此把项目判成「插件」(PWA 那种 `manifest.json` 不算——要同时有 `id` / `apiVersion` / `main`)。
- **加载**:用户在 Studio 底部工具条点开 **Sandbox** 面板 →「在 Forsion 中加载」。你(agent)点不了这个按钮——写完后请用户去点,别假装已经加载。
- **热重载**:项目开在 Coding Studio 期间,存盘即重载(宿主会把上次开着的插件视图重新打开)。关掉该项目后不再热重载。
  ⚠️监听器不看 `dist/` / `build/` / `node_modules/` 与点目录:`main` 指向构建产物(如 `dist/main.js`)的插件,改源码不会自动重载到新包 —— 构建完点面板里的「立即重载」(显式重载一律真拆真装)。桌面插件本来就建议 `main.js` 直接放项目根、不走构建。
- **报错在哪看**:Sandbox 面板收口三样——`setup` 抛错、视图 `mount` 抛错、这个插件自己的 `console` 输出(经 `ctx` 闭包归属,不会和别的插件混)。用户可以一键把它们发回对话;**以这些为准**,别凭空猜。
- ⚠️**这不是隔离沙箱**:dev 插件跑在真应用、用户的真笔记库上,与已安装插件同权。试验期间不要写、挪、删用户数据;定时器与监听必须在 disposer 里清(热重载会反复 `setup`,漏清一次就叠一层)。
- ⚠️**同 id 影子**:dev 副本会顶掉同 id 的已安装副本(卡片带 DEV 徽标,期间该插件的「卸载」被禁用)。要对比已安装版,先在 Sandbox 里卸载 dev 副本。
- ⚠️**声明了 `fileExtensions` 的插件不能从 Sandbox 加载**(宿主的毁档防线只覆盖已安装目录)——这类插件必须装上再测,面板会直说。
- 引擎插件(`tangu-plugin.json`)**不在 Sandbox 范围**:装进插件目录后重扫生效;同 id 覆盖升级可热换代(单文件 bundle,或纯 ESM 多文件包),带 CommonJS / node_modules / 软链 / 引到包外文件的仍须重启后端。

`check.mjs` 仍然要留(通用纪律 4):Sandbox 证「在真宿主里能起来」,`check.mjs` 证「逻辑回归得了」,两个证的不是一件事。

## 发布到市场

推成独立 GitHub 公开仓库(引擎插件记得含 `dist/`)→ 个人中心 → 投稿 选对应类型给仓库链接或传 zip(zip 内容放根或单层文件夹,两层路径装不了)。捆绑包(默认形态)按 **amadeus-plugin** 类投稿(桌面按包内 manifest 实测路由,自然落进 `~/.forsion/plugins/`)。GitHub 来源会**锁定过审时的 release tag**,发新版需重新过审。升版号必写 `CHANGELOG.md` 一节(`## x.y.z — YYYY-MM-DD`),宿主会渲染成插件详情页的更新日志。

### 共享账号 `ctx.account`（可选）

发布到 Unit 网页且安装账号提供方时，宿主提供 `ctx.account`：`status()` 返回经过服务端验证的 `loggedIn/userId/username/role/tenantId/workspaceId`，`login()` 打开共享 Forsion 登录页，`logout()` 吊销当前会话后退出，`request(path, init)` 在账号 API 基址下发送请求（例如 `/admin/users`），`subscribe(listener)` 订阅账号变化并返回退订函数。宿主在插件禁用或重载时自动退订。账号变更会取消旧请求，并使尚未消费的响应体失败；调用方仍需释放自己的视图与任务。不要保存凭据或从其他页面的 localStorage 导入令牌。个人 workspace 由服务端身份提供方确定，不接受客户端指定；组织与成员关系不在当前契约内。旧宿主与远程独立管理模式应先判断能力存在性。

### Unit 与浏览器资源路径（2026-09-09）

插件应以能力判断运行环境；Forsion Unit 是框架宿主。
- `ctx.app.assetUrl?.(vaultRelativePath)` 将库内相对路径转换为当前宿主可加载的资源 URL；Web/Unit 带资源授权，不要硬编码 `amadeus-asset://`。需要活动库；没有活动库时不要绘制库资源。
- `ctx.app.hostPath?.(vaultRelativePath)` 只在当前引擎和真实笔记库共享文件系统时返回绝对输出路径；无活动库、云库、浏览器虚拟库、远程引擎或未声明能力时返回 `null`。返回 null 时不要拼接 `vaultRoot()` 强行写本机路径。
- `window.tangu.executionCapabilities?.host` 是 Unit 对主机执行能力的声明；不存在不证明可用。网络视频分析还需网络、媒体工具和模型。
- 本地 Unit 通过安装包 `runtime: { apiVersion: 1, main: "runtime.mjs" }` 加载本地能力，公开多用户投射不加载该入口。业务包无需依赖 Server 才能显示 UI 或使用本地能力。

### API-backed Markdown editor

`ctx.ui?.mountMarkdownEditor(el, { value, label, readOnly, onChange })` mounts native Amadeus without using the active vault. The caller owns save/publish. It offers visual/source/publishing preview modes. `getValue()` reads the latest synchronous editor transaction; `update`, `insertMarkdown`, `focus`, and idempotent `dispose` are available; after `dispose` the element is yours again at once. The host revokes it on plugin unload. Feature-detect; absent hosts should ask for an upgrade.


### Plugin Chat Box selection and Director hand-off (2026-09-30)

When `ctx.tangu.chatSelection === true`, `startChat` accepts optional `modelId` and `thinkingLevel` from the native `ctx.ui.mountChatBox` submission. The host validates the live model catalog and supported thinking levels before changing the UI, then applies the explicit selection after Agent defaults, before prefill/send. Unrecognised selections return `ok:false`; keep the draft for retry. Older hosts omit the capability: retain a plain prompt adapter instead of showing a model picker whose selection cannot be honoured. Bundle ownership, vault-relative `folder`, plugin liveness and send gating remain unchanged.

For API-backed public documents, `ctx.ui.mountMarkdownEditor` accepts `previewBaseUrl` for resolving relative images and videos in a cross-origin host.


### Startup appearance / 开屏与图标

`ctx.registerAppearance?.({ id, label, labelEn, icon?, splash? })` registers a choice in Settings → Appearance → Startup and icons. `id` is a stable ASCII slug; the host namespaces it by plugin ID. Provide both localized labels. `icon` and `splash` are embedded base64 data images (`image/png`, `jpeg`, `webp`, `gif`, `svg+xml`), each at most 2,000,000 characters and 4096 × 4096 pixels. URLs, HTML, executable scripts and arbitrary CSS are not accepted by this contract. Render SVG as an image, never inject it into the host DOM.

Registration never selects or replaces the user's appearance. On selection, the host validates the image and snapshots it for offline startup before plugin code loads. Icons become static 256 × 256 PNGs for the application, macOS Dock and running Windows taskbar windows; installers and pinned shortcut artwork are unchanged. Animated GIF/WebP/SVG may be used as splash artwork. Reduced motion uses the static icon. The host owns the readiness exit and 10-second safety ceiling, so a plugin cannot extend loading time.

The returned disposer removes only its own current registration. Disable, unload and failed setup revoke registrations; disabling or removing the plugin clears selected cached assets. A normal reload retains the selected snapshot: select the preset again to refresh artwork after editing it. Stale contexts cannot register again. Always feature-detect with optional chaining. A complete installable example is in `samples/forsion-sample-appearance/`.

中文：插件只贡献选项，不自动改用户选择。选择后缓存图像供离线启动使用，图标同步到应用内部及运行中的 Dock／任务栏；普通重载保留快照，重新选择可更新素材。禁用或移除插件时恢复默认，旧上下文不能重新注册。安装包与系统固定的快捷方式图标不随此设置修改。
