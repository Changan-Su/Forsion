---
name: Forsion 扩展开发
description: 当用户要给 Forsion / Tangu 做插件、主题、Space、智能体(agent)或捆绑包(bundle)——或要把某个能力做成可分发/可上架市场的扩展——时使用。内置五类官方模板(samples/),讲清各自的格式基线与硬约束(尤其两种"插件"是完全不同的系统),照抄模板改比从零写靠谱。
version: 1.12.0
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
> - **Amadeus/Forsion 桌面插件**:UI 层,`manifest.json` + 裸 `main.js`(宿主 `new Function('ctx', code)` 跑),加命令/斜杠项/视图/文件类型。桌面端 设置 → 插件 有一键脚手架(hello-amadeus);捆绑包模板的根即这一形态。
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
- 类型契约 `types/tangu-agent.d.ts` 是 apiVersion 1 的 API 拷贝,随模板分发;宿主升 apiVersion 时替换它并同步 manifest 的 `apiVersion`。

装本机:整夹拷到 `~/.forsion/plugins/<id>/` → 重启后端(同 id 原位升级受 ESM 缓存影响,必须重启)。

## 主题(samples/forsion-sample-theme)

双轴模型:**语言(结构:圆角/字体/阴影/布局)× 配色(颜色)× 明暗**。磁盘主题装 `~/.forsion/themes/<id>/`,**目录名必须 == id**。

- 主题 CSS 是**全局注入**(非隔离),因此**每条规则都要 scope 在 `[data-theme='<id>']` 下**,否则污染其它主题。
- **不要硬编码颜色**:配色由 skin 提供,主题只定结构,消费 `var(--bg)`/`var(--text)`/`var(--accent)` 等词表 token —— 这样任意配色/明暗都成立。
- 可选 `settings[]`(number/select/boolean/color)让用户在设置页调主题内参数:`key` **就是** CSS 自定义属性名,宿主把值写进 `:root` 内联变量,主题用 `var(--key, 默认值)` 消费。参考本仓内置 `genesis-glass` 主题(`desktop/frontend/src/theme/themes/genesis-glass/`)。

## Space(samples/forsion-sample-space)

`space.json` 声明视图布局配方(引用视图类型 id;插件视图用 `plugin:<插件id>:<视图id>` 并在 `requires.views` 声明)。纯数据,无代码。

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
     spaces/<slug>/space.json          ← 内嵌 Space:随插件启停显隐
```

**三种生命周期,发包前必须分清**:

| | 谁 | 升级时 |
|---|---|---|
| **随包** | 引擎插件、Space | 父插件禁用即级联关闭/收起,卸载一并消失 |
| **播种一次** | Agent 的**人格面**(config.toml / SOUL.md / Library / MEMORY) | 首次发现拷入引擎成为活体,**永不覆盖**,卸载保留 |
| **指纹自愈** | Agent 的 `skills/`(2026-08-25 起) | 每次启动比指纹:用户没动过的跟着 bundle 更新;动过的(含无指纹老副本)保护不覆盖并在引擎日志报出来 |

包根 `skills/`(全局技能)是原地扫描、不落盘拷贝,不在上表内。因此 onboarding 里**不要** recommends 自家已内嵌的 agent/skill(会引导去市场重复装)。真实范例:`Forsion-Instrumentality-Project/bluebird/`。

### 把动作搬进引擎侧:三档路由(通用纪律 5 的落地写法)

发现某个能力「只有点命令面板才能用」时,把它做成 bundle 的引擎侧资产(形态按纪律 5 选:默认包根 `skills/`,真需要专属人设/上下文预算/自动化入口才加 `agents/<slug>/`),然后在**通用技能**里写一张降级路由表(照抄 `bluebird/skills/bluebird-link/SKILL.md`)。**只发全局技能时第 2 档不适用**,直接写「自己做 / 指去工作台」两档即可:

1. **我自己就有那份技能**(即我就是那个专门 agent)→ `use_skill` 直接做。**这一档必须排最前**,否则专门 agent 会委派自己。
2. **有 `delegate` 工具且当前是本地库** → `delegate({ agentSlug: "<slug>", task })`,task 里带**真实库根路径**并要求它自己落盘、回报路径;顺带如实说明「委派产物不进插件侧栏索引」。
3. **都不行**(没 delegate / 云端库 / 第 2 档失败)→ 让用户从命令面板打开工作台自己操作。

需要桌面主进程能力时(语音转写、系统面)引擎侧已有 MCP 桥工具,如 `transcribe_audio(path, timestamps?)` —— 它在没开桌面/云端 worker 上自动隐身。**调用方明确说了「我自己接力转写」时,即使工具可见也不要调**。子 agent 继承**父会话**的审批档位,不是它 config 里的 `approval_mode`。
## 桌面插件:贡献点全表(动手前先看这张表)

`ctx` 上的注册口就这些 —— **内置与外置拿到的是同一份**(`pluginStore.makeContext`,能力对等原则)。
细节正典 = 仓根 `docs/Function/生态内容制作指南.md`(本表每一行都能在那儿找到对应小节);
类型契约 = `Forsion-Genesis/desktop/frontend/src/amadeus/plugins/types.ts`。

| 贡献点 | 给用户的入口 | 备注 |
|---|---|---|
| `registerCommand` | 命令面板 | id 处于全局命名空间,裸名会互顶;**只做导航**——动作性能力走引擎侧 agent/技能(通用纪律 5) |
| `registerSlashItem` | 笔记里的 `/` | 静态 `scaffold`,或动态 `run()`(先建文件再返回嵌入语法) |
| `registerView` | 独立标签页(`ctx.openView(id)` 打开) | **DOM 挂载**(`mount(el)` 返 disposer),外置插件的主力;加 `workspaceSource` 可让左栏跟着它切到自家列表 |
| `registerListSource` | **统一左栏**里的一条列表(收藏/任务/订阅…) | 宿主渲染,与会话/笔记行同一套 UI;⚠️`subscribe()` 里**必须重读一次数据**,见下 |
| `registerFileType` | 自定义 `.x.md` 文件类型 | 撞内置后缀返回 **`false`** → 整体退让(判定写 `=== false`) |
| `registerFileCreator` | 文件树右键 + 新建标签页启动器 | 与文件类型配套;**四条新建路径都要注册**,少一条用户就会问「为什么这儿没有」 |
| `registerEmbedRenderer` | `![[x]]` 嵌入的自绘渲染 | |
| `registerSetting` | 详情页声明式表单(number/boolean/text) | 每键一个字符串,**没有原子性**;同 key 重注册即覆盖 |
| `registerSettingsView` | 详情页里自己画的面板 | 会被反复挂载卸载,状态别放模块级单例 |
| `registerEditorExtension` | 笔记编辑器的按键 / 装饰 | `'high'` 档不处理**必须 `return false`** |
| `registerStatusItem` | 全局状态栏 | 返回 handle,可原位 `update({text,title})` |
| `registerTheme` | 强调色主题 | 与磁盘主题包(`~/.forsion/themes/`)是两件事 |
| `registerPanel` | 右侧栏面板 | ⚠️收 **React 组件** —— 外置插件得自带一份 React(mindmap 有先例),多数场景改用 `registerView` |
| `registerPropertyType` | 多维表自定义列类型 | ⚠️同上,`Cell` 是 React 组件;`baseType` 决定落盘形状 |
| `ctx.notify(msg, {level})` | 右上角通知 | 自动标插件名,用户可按插件静音 |
| `ctx.achievements` | 成就系列 + `track(event, n)` | 宿主强制 `plugin:<id>:` 前缀,伪造不了官方成就 |
| `ctx.activity.log(event, detail)` | 写进活动日志(Muse 读得到) | 同款前缀纪律 |
| `ctx.loadData() / saveData()` | 每插件一份 JSON blob | 大块数据走这条(见下「编辑器」节) |
| `ctx.getLocale / subscribeLocale` | 跟随宿主中英切换 | 见下「双语」 |
| `ctx.tangu` | 当前模型 / 模型目录 / 当前 Space / 会话用量(只读) | ⚠️**非 Tangu 宿主上整个不存在** → 一律 `ctx.tangu?.`;见下「当前模型」 |
| manifest `events[]` | 自动化(Automation)可订阅的事件 | 纯声明无代码;⚠️目前只有中文 `label`,英文界面下也显示中文 |
| manifest `onboarding` | 装完的首启引导卡 | **别 recommends 自家已内嵌的 agent/skill**(会引导去市场重复装) |

`ctx.app` 上另有三组:**整库文件读写**、**只读全库查询**、**块表面** —— 各占下面一节。

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
- `drop` 不声明就完全没有拖放;声明了也是宿主判形点亮、插件决定接不接。
- 细节与全部字段语义见正典文档同名小节 + `amadeus/plugins/types.ts` 的 `ListSourceContribution`。

### 双语与图标

- `ctx.getLocale()` 取初值 + `ctx.subscribeLocale(cb)` 只报变化。判定 = **切语言时视图不重挂也要变**;
  但整树重建会吃掉用户没提交的输入 —— 重建前快照、重建后回填。
- ⚠️`t()` 的占位符替换**必须单趟正则**:`s.replace(/\{(\w+)\}/g, (m,k)=> (k in vars ? String(vars[k]) : m))`。
  逐个 `split('{k}').join(v)` 会让先替进去的值被后面轮次再吃一遍(用户把卡组命名成 `{n}` → 自己的数据被当占位符)。
- ⚠️**会落盘的兜底默认名(文件名、frontmatter 值)一律钉死中文常量,不许取 `t()`** —— 否则英文界面建出来的
  文件名与中文界面对不上,同一个库里冒出两套。
- 贡献点的**标题是注册时的单字符串**(命令 title / slash label / view title / setting label / 成就标题),
  宿主不做运行时重解析 → 切语言要等重启。**不许**用「语言变了就 teardown 重注册」绕(会打断录音、写队列、已开的视图)。
- `icon` 一律写宿主词表里的名字(`'template'` / `'pin'` / `'callout-warning'`…),**别塞 emoji** ——
  命中词表宿主就画和内置项同一套 SVG。全表见正典文档「图标」节与 `components/icons` 的 `PLUGIN_ICONS`;
  ⚠️词表键全是 `[a-z0-9-]`,只增不改不删。


## 当前模型与当前 Space:ctx.tangu(2026-08-29 起)

```js
const m = ctx.tangu?.activeModel()        // {id, name} | null —— 输入栏药丸显示的那个
const sp = ctx.tangu?.activeSpace()       // 'tangu' / '__home__' / 用户 Space id | null
const off = ctx.tangu?.subscribe(() => rerender())   // 只在这两个值**真变了**时回调,不是每次 store 变更
```

```js
const models = ctx.tangu?.models?.()   // 全部对话模型(只含 llm)—— 逐模型设置用
const s = ctx.tangu?.session?.()       // {contextWindow, contextTokens, sessionTokens, effort} | null
```

- ⚠️**`ctx.tangu` 在非 Tangu 宿主上整个不存在**(纯 Amadeus 壳 / unit 设备页 / 云端)—— 一律可选链 + 降级路径。
- `session()` **拉取式**:这几个值流式回答里每帧都在动,**故意不进 `subscribe` 的变更键**(进去 = 把订阅插件按帧敲一遍)。要跟着动就自己定时拉,或"开面板那一刻读一次"。`contextWindow` 未知给 **0**、`effort` 未知给 **null** —— 别把 0/空串当档位画出来。
- **能力探测,不是权限闸**:模型名不敏感,**不用**写 manifest `capabilities`(那道双闸给 `system.activeWindow` 那类)。
- 只读。要换模型 / 发消息,走引擎侧 agent(通用纪律 5),别指望这里。

## 全屏浮层:三条纪律(没有 API,但踩了就静默出事)

插件跑在渲染进程主世界,`document.body.appendChild` 一个 `position:fixed; inset:0` 的层就能盖住整个界面 —— 不需要新接缝。但:

1. **浮层根必须 `-webkit-app-region: no-drag`,且 append 到 body**(DOM 顺序须晚于 Shell)。mac 拖窗区按 **DOM 顺序**合成、**与 z-index 无关**;ribbon 与左侧栏是拖窗区,重叠矩形内的点击/hover/滚轮全被吞。**浏览器台架照不到,只有真 Electron 能验。**
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

按 vault 夹紧(越界 403)、支持 Range、`<img>`/`<video>` 也能当 `src`。⚠️**需要 Forsion ≥ 2.8.1** —— 更早版本 CSP 的 `connect-src` 没放行它,症状是「`<img>` 能显示、fetch 一律 `Failed to fetch`」。文件让用户放进 `ctx.app.workFolder()`,`ctx.app.listFiles?.()` 列出来;**别随包分发大资产或有版权的第三方资产**。仪器:desktop 的 `npm run check:assetfetch`。

CSP 是 `default-src 'self'`(没有 CDN),依赖一律 esbuild `bundle: true` 打进单文件。`main.js` **没有大小上限**。需要 disposer 时:

```js
// build.mjs —— IIFE 的返回值会被丢掉,用 globalName + footer 把它 return 出去
globalName: 'myPlugin', footer: { js: 'return myPlugin.dispose;' }
```

## 插件文件读写与「工作文件夹」(2026-08-03 起)

桌面插件的文件面 = 活动笔记库(vault):`ctx.app.readFile/writeFile` 走 vault 相对路径,**整库可读写**,宿主钳死越界(路径逃逸抛错);写入原子落盘、父目录自动创建。落盘位置约定:**每个插件在设置详情页自动获得一条「工作文件夹」**(key `workFolder`,默认=插件显示名),产出一律写 `${ctx.app.workFolder()}/…`,别自造存储夹设置;给用户的产物存 **markdown**(可引用可检索),机器数据放点开头隐藏 sidecar。旧宿主没有 `workFolder`,兼容写法同 `ctx.notify`:

```js
const folder = ctx.app.workFolder ? ctx.app.workFolder() : '<插件名>'
await ctx.app.writeFile(`${folder}/笔记.md`, markdown)
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
- **忘记清理宿主也会兜**:插件被禁用/重载/`setup` 抛错时,你开的 `subscribePage` 与 `mountBlocks` 由宿主统一收掉,之后整份 `ctx.app` 块表面变哑(在飞的异步任务改不动用户文件)。但这是安全网不是设计:该 dispose 还是要 dispose。
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

## 发布到市场

推成独立 GitHub 公开仓库(引擎插件记得含 `dist/`)→ 个人中心 → 投稿 选对应类型给仓库链接或传 zip(zip 内容放根或单层文件夹,两层路径装不了)。捆绑包(默认形态)按 **amadeus-plugin** 类投稿(桌面按包内 manifest 实测路由,自然落进 `~/.forsion/plugins/`)。GitHub 来源会**锁定过审时的 release tag**,发新版需重新过审。升版号必写 `CHANGELOG.md` 一节(`## x.y.z — YYYY-MM-DD`),宿主会渲染成插件详情页的更新日志。
