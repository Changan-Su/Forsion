# Forsion Intelligent UI v1 / v2

普通交互计划、图片候选、网页来源与定性比较走受控原生组件；v2 起计算器、预算、换算、分步、闪卡、计分小测验、
可筛可排的列表也走原生文档（白名单计算层）。图表、示意图、动画模拟与小游戏继续走 HTML 卡沙箱（工具 `intelligent_ui_html`，10-20 前叫 `sketch`）。
这是一套 Forsion 实现，不是 ChatGPT 内部协议复刻。用户侧名称为 Intelligent UI。

## 边界

- `client_capabilities: ["intelligent-ui.v1"]` 是渲染能力握手。没有握手的旧客户端不获得新工具。
  初版仅 desktop/web 可生成；保留原有移动端 HTML 卡禁用规则。原生文档本身没有脚本。
- `"intelligent-ui.v2"` 与 v1 一起发：引擎据此多发一段 `INTELLIGENT_UI_V2_SECTION`、换两段工具描述（`definitionFor`），
  并接受 `version: 2`。没有 v2 握手的客户端照旧只收 v1，引擎对它们拒收 v2（报错回给模型）。
- `"widget.v1"`（小组件，10-31）：客户端能按 id 画原件、画得出只发 `edits` 的更新时才上报，引擎对本机 run 才认。两张卡的工具多 `widget` / `summary`（HTML 卡另有 `edits`），
  多一段 `WIDGET_SECTION` 和按需装载的 `manage_widget`；没有握手的客户端工具定义逐字节不变，带这些参数的调用直接报错。带 `widget` 的调用按写文件过审批。
  存法见 `src/services/widgetStore.ts` 和方案页 `docs/ToBeImproved/Widget与Dashboard方案_2026-10-30/storage.html`。桌面要等 WidgetHost 接好再上报。
- HTML 卡 10-20 改名：工具 `sketch` → `intelligent_ui_html`、卡内脚本接口 `window.forsionSketch` → `window.forsionIntelligentUi`、
  笔记交互块 ```` ```forsion-sketch ```` → ```` ```forsion-intelligent-ui-html ````。兼容层（只在模型那头换名）：
  - 引擎与客户端之间（上屏事件、落库的会话记录、卡里的 HTML）仍叫 `sketch` / `forsionSketch`：已发客户端只认这套，而会话会在
    新旧两版之间来回打开。`agentLoop` 在模型产出调用的入口经 `htmlCardToWire` 换成旧名（HTML 里的 `forsionIntelligentUi` 一并换），
    发给模型的历史经 `withHtmlCardName` 换回新名（含 Responses 的 `providerItems`）。旧客户端都升级之后再把这一层换掉。
  - `TOOL_NAME_ALIASES` 把 `sketch` 归到新名：模型照着旧历史叫、HARNESS 收起名单、profile / toolsList / 代码里的白名单、审批规则、能力查询都认。
  - 渲染层两种工具名都画（`isHtmlCardTool`）；卡内运行时两个全局名指向同一个冻结对象。
  - 笔记里两种围栏都认，新插入的写新围栏。已知缺口：同一个库在 10-20 之前的旧版上打开，新围栏显示成普通代码块（内容不丢）。
  - `tool_stream` 的参数增量不换接口名（可能被切在两段之间）：旧客户端的草稿卡里脚本可能报错，收口那次是换过的。
  - 文件名、CSS 类、内部变量（`SketchCard`、`.sketch-*`、`sketchTurnSignalFor`、`sketch-ask` 消息类型）没改。
  已发的客户端（≤ 2.13.4）遇到同步来的 v2 历史只显示「这部分界面未能生成」那行；从本版起，渲染层对比自己新的版本
  显示标题、第一段文字和「这张卡要新版 Forsion 才能显示」。
- HTML 卡的随包库（10-28，`"intelligent-ui-libs.v1"`，desktop / web 发，手机原生包不发）：客户端随包带 three（含
  `three/addons/controls/` 两个相机控件）、d3、chart.js/auto、gsap，卡里用 `<script type="module">` 按裸名 import。仍然断网：
  桌面经 `forsion-iui://lib/…`（`desktop/electron/iuiLibProtocol.ts`，只读库目录里的 `.js`），网页经本站 `/iui-lib/`（nginx 带
  `Access-Control-Allow-Origin: *`——卡是无源 iframe，module 脚本按 CORS 取）；内层 CSP 只在 `script-src` 多这一个来源，
  `connect-src` 不变。importmap 在 `sketchWrapper.ts`（`IUI_LIB_IMPORTS`），文件由 `desktop/build/copy-iui-libs.cjs` 从 npm 包现生成、不入库，
  目录只带大版本（three 带到 0.x 次版本），装到的版本和目录名对不上就构建失败。引擎只在握手里有这一项时把工具描述里「不许用库」那句换掉
  （`sketch.ts` 的 `WITH_LIBS`）。没握手的客户端（旧版、手机）打开带库的卡：库画的那块是模型留的一行占位字，其余照常。
  升大版本时旧目录留着、新目录并排，卡里得记一个库代号让历史卡继续指旧目录——第一代没有代号，没代号 = 第一代。
- 复用 `tool_stream`、`tool_call`、`tool_result` 与现有历史 JSON 存储，不创建另一套 SSE 协议或数据库表。
  `document` 是 JSON 字符串，参数完整落库；工具结果只提供短确认或纠错信息。
- 服务端及客户端使用同一纯 TypeScript 验证器：`src/contracts/intelligentUi.ts`。渲染入口位于
  `desktop/frontend/src/components/IntelligentUi.tsx`，消息顺序由 `EditorialMessage` 保持。
- 声明式内容不接受 HTML、JavaScript、CSS 或任意 API 动作。富文本不执行代码，不内嵌图片。
  外部来源经现有链接路由打开，不是嵌入任意网页的 iframe。
- v2 表达式（`src/contracts/intelligentUiExpr.ts`，引擎与渲染层同一份）：纯函数、结果确定，只读本文档的输入、state 与
  derived，碰不到网络、时钟、随机数、DOM 或任何没递给它的对象。函数只有 20 个（白名单见技能），没有 random 与日期
  （历史回放必须算出同样的数）。取字段只认自有属性，`__proto__` / `constructor` / `prototype` 一律拒；每次产出的
  文字 ≤ 10,000 字、列表 ≤ 200 项、数字必须有限；单个表达式 ≤ 300 字、each/filter/sortBy 嵌套 ≤ 2 层；
  一次渲染求值 ≤ 20,000 步。写了白名单外的函数、名字、参数个数不对、引用后面才声明的名字 → 校验时报回模型；
  运行时失败（除以 0、字段不存在、空列表求平均）→ 那个值显示「—」，引擎把初值下失败的列在成功结果后面。
- 插值 `{{ }}` 的结果在 markdown **解析之后**才作为纯文字节点填进去（私用区占位符），算出来的字符串变不成链接、
  自动链接、强调或表格格子；单靠反斜杠转义挡不住 GFM 自动链接（渲染层测试实测过）。打开链接仍只认静态 `resourceId`。
- 图库使用浏览器加载经过 URL 校验的公开 HTTPS 图片，禁用 referrer；失败保留替代文字及重试。
  引擎不代替浏览器请求这些 URL。URL 规则不是 DNS 或重定向防火墙。图片描述必须有实际看图或用户提供的依据。

## 什么时候出卡

2026-11-10 修订：以阅读、观察和操作的具体收益选择形式，不按出卡比例验收。
讲解、笔记、推导、总结、教材定位和静态比较默认用聊天 Markdown；有标题、表格、公式或“结构、关系、步骤”等词不等于需要界面。
需要观察关系时补一张图；调整参数、切换条件或跟踪进度确有帮助时加入局部交互。拿掉控件后几乎没有信息损失的内容保留正文，不为满足出卡要求添加选择框、测验或折叠。
每轮重新判断；上一轮用了卡片，下一轮问教材页码仍用正文。用户要求的格式优先。

`sketchTurnSignalFor` 保留 explicit / implicit / actionable / shape 分类，但后三类都是收益判断提醒，**不再收尾补催**。
只有明确视觉请求保留交付检查；少一点只认明确请求，关闭同时移除工具和提示。
原生客户端用 `intelligent_ui` 做局部交互，HTML 用于图表、示意图、模拟器；生成文件和代码仍走相应工作工具。
真模型回归 `--only iuireading` 覆盖五段式教学→微观态交互→教材阅读→主动即时计算→五段式推导；
`visualauto` 记录可选卡片使用情况，不再要求至少 4/6 出卡。

### 文档 JSON 写进了正文

模型偶尔把文档 JSON 当正文写出来、不调用工具,用户看到的是回答里夹一大段 JSON、没有卡。agentLoop 在收尾前认这种正文
(`looksLikeLeakedUiDocument`:不在代码围栏里的 `{"version":1,…"blocks":[…`),认出来就:

- 那条正文不进终稿(流式时已经上屏的那段,客户端在 `done` 时按终稿重排,会消失);
- 回灌一句 `<ui_document_check>`,让模型真的调用 `intelligent_ui`;用户就是要看 JSON 的话,让它放进代码块重答;
- 一个 run 只纠正一次。这一轮已经调过 `intelligent_ui` 的不纠正(卡已经有了,再纠正会多出一张),下一轮是不带工具的收尾轮时也不纠正。

状态事件 `ui_document_recovery`。真模型验收:`--only uileak`(用户说「工具点了没反应,把 JSON 写进正文」,把这种情况逼出来;
判据是终稿里没有裸的文档 JSON、且纠正过的那几条最后都出了卡)。

### 卡和正文怎么接

连续的论述、公式和引用留在聊天正文，局部交互只承载需要操作的部分；两处不重复整篇答案。
不再要求“卡就是整条回答”、先调工具再停止写正文，也不因文档里有一张表就把讲解搬进去。

卡片 `text` / `disclosure` 通过 `ReadOnlyMarkdown` 共享聊天解析、KaTeX、公式复制和笔记/PDF/文件引用。
聊天入口传入会话工作目录，以正确解析相对文件路径；历史卡片使用同一个渲染器。
保持禁用原始 HTML、内嵌图片、笔记嵌入、代码执行和链接预览请求。动态值在解析后替换，公式中的值转义为 TeX 文本，链接标签可动态变化，链接目标不能动态注入；异常编码的引用降级成文字。
窄容器里的长公式在自身区域横向滚动。验证：`node desktop/scripts/intelligent-ui.e2e.cjs --reading-only`（先构建 desktop）。

## 内容、状态与流式

文档含 `inputs`、`resources`、`blocks`，v2 另有 `state`、`derived`（排在 inputs 之后、blocks 之前，流式时区块上屏前
名字已齐）与 `stats` / `table` 两种区块、`kind:"set"` 按钮；完整格式和示例见 `skills/intelligent-ui/SKILL.md`。
Chat 模式不开放技能工具，必需格式也包含在 `INTELLIGENT_UI_SECTION` 中。工具定义保持简短，
通过既有 Chat GUI 12,000 B 预算；不是每次都让模型生成完整网页代码。

文档上限 64 KiB（UTF-8）、8 个输入、24 个资源、40 个区块、总共 200 个清单条目。
每个输入必须且只能出现在一个始终可见的 controls 区块。资料完整并且引用有效后才提交区块；
流式中断或后续区块无效时，显示最长有效前缀，并标明内容不完整。刷新回放采用同一逻辑。
模型默认值只初始化未编辑的输入；后续内容补齐不覆盖用户选择，不重新挂载已有控件。

状态键为 `[session:message, callId, documentId, 1]`，不用内容哈希或流事件版本作为 React key。
本机状态独立保存输入、已购数量、展开状态与 v2 按钮改过的 state（`vars`，可存列表）；派生量不保存、不自动发送给模型。
v2 的追问消息另带「卡片里改过的」state（列表只带条数和前 5 项），不带 derived。正文含插值的折叠块按算出来的内容记展开，
内容一变就收回（背单词换词时释义收起）。状态损坏会恢复为空，
下一次编辑重建存储；存储不可用时保持本轮内存交互。最多 48 份快照，每份 64 KiB；没有跨设备同步。

采购清单先按语义 itemKey 和单位合并再缩放。不同单位不会混算。已购数量随菜单切换保留；
人数增加后不足的项目显示差额与部分完成状态。小数步进统一归一化，避免显示 0.3 而条件拿到浮点残差。

本地操作包括人数、选择、勾选、折叠、图片展开与复制。只有显式点击 model action 才发起新一轮，
且以可见的用户消息携带当前输入选择；open 走来源链接，copy 走剪贴板。初版没有泛化业务 API 动作，
没有跨回答的文档补丁 API；新模型调用产生新文档，不静默重写旧消息。

## 外观

沿用 Genesis 字体、主题、边框、圆角、动效角色。模型写的内容平铺在回答里（不垫卡面），只有实时应用卡是对象卡。
读的地方（文字区块、折叠里的内容、一项一句话的清单）跟回答正文同一个字号和行距，文档标题等于回答里二级标题的大小；
控件、数量、计数仍走六档界面字号。区块按可用容器宽度堆叠，最多三列，320px 容器可用。

- 选择：原生 radio 留在节点里（方向键、空格、读屏照旧），外观自己画，选中 = 强调带加一个勾。没有说明的短选项收成一枚分段控件；
  选项带 `imageId` 时是一排可选图卡：点卡片就是选它，左上角的按钮只放大、不改选择；一排最多三张，正好四张时排成两行两列。`imageId` 要么每个选项都给，要么都不给。
  已经当成选项的图只画一次：模型又把它们放进图库或对比时，图库只留不是选项的图（一张不剩就整块不画），对比项留文字、不带图。
- 清单：标题、进度（已完成数 / 总数）、复制、清空同在一行；勾掉的行退后并划线。
- 对比：各项的名字、一句话、要点落在同一条横线上，要点用淡线分行。
- 折叠：三角在左，不画整行底线。来源：标题和域名一行，摘要直接露两行，点一下看全文。
- 追问（model action）用回答末尾「建议」那枚芯片；复制、打开来源仍是普通按钮与链接。
- 生成中：还没到的部分用骨架占位，到了的区块淡入；回放历史时不动。减少动态效果时全部静止。
- 聚焦圈统一走 `--focus-ring`；checkbox / details 保留原生键盘行为。

## 可重复验收

0. 画廊：`desktop/scripts/fixtures/intelligent-ui-gallery.json`（手写 v2 文档：房贷、AA、换算、预算、背单词、分步、
   筛选列表、小测验、成绩、按人数缩放的清单、两百项边界）。`src/shared/intelligentUiExpr.test.ts` 要求每份过校验、
   初值下零失败；技能里的 JSON 例子同样过校验，且 v2 例子必须就是画廊里的房贷卡（改了一边另一边会红）。
1. `tangu-agent`: `npm run build`，相关 Vitest：`src/shared/intelligentUi.test.ts`、`src/shared/intelligentUiExpr.test.ts`、
   `src/tools/intelligentUi.test.ts`、`src/tools/sketch.test.ts`、`test/chatPreset.test.ts`。
2. `desktop`: `npm run build`、`npm run typecheck`，相关 Vitest：`intelligentUiState.test.ts`、
   `editorialSketch.test.ts`、`agentRunService.client.test.ts`、`i18nCoverage.test.ts`、`intelligentUiV2.test.ts`。
3. 真模型：仓根归档工具 `harness-runs/archive.mjs run --label "…" -- --only intelligentplan,intelligentmedia,intelligentplain --model codex/gpt-6-luna`。
   晚餐运行 Chat 预设，图库运行 Work 并实际查看图片，关闭偏好是负向行为回归。证据文件以 `-evidence.json` 归档。
4. 真 Electron：遵循仓根 gui-verify 的 e2e 锁与独立数据目录流程，运行 `npm run check:intelligent-ui`。
   `--evidence=<raw 目录>` 可回放真模型结果。脚本覆盖流式焦点、数量与采购差额、复制、刷新、键盘、来源、
   图片展开/失败重试、图卡（点选、放大不改选择、方向键、放大钮不挤偏卡片）、320/375/768 容器、减少动态、英文深色和历史 Sketch；结果在 `desktop/outputs/intelligent-ui`。
5. `npm run demo:intelligent-ui` 打开已验证样本的隔离窗口（`--evidence` 可加真模型记录），关闭后删除临时数据。`--demo` 则先验收再保留窗口。演示不更新安装版、不上线。
6. 普通用户端到端：通过归档工具运行 `--only intelligentusers --timeout 1800000`（或 desktop 的 `npm run e2e:intelligent-live` 后补归档）。
   五个独立会话覆盖聚餐、搬家、学习、相册与网页比较；提示不指定 UI 工具或 schema。真实引擎先完成启动，隔离编译版
   Electron 再连入；提示从实际输入框发出，卡内追问也真实调用 GPT-6 Luna。没有假后端或结果注入。
   `--intelligent-cases user-dinner,user-moving` 可只重跑失败场景。证据在 `intelligent-users-evidence.json`，截图在
   `intelligent-ui-shots/`；需人工复核语义和截图，自动断言不能单独证明推荐质量。
   「点击来源实际打开官方网页」认的是「点击之后、从链接地址加载出来的那张页」（`desktop/scripts/lib/opened-page.cjs`），
   不比地址栏当前的地址：站点加载完可以自己改写它。这条判定不靠模型的验证是 `desktop` 的 `npm run check:sourceopen`
   （`-- --real` 另外真开一次 Obsidian 帮助站）；链接被服务器跳转走的照旧判红。

2026-10-09 独立评审的 8 项 P2 已补回归：损坏/禁用存储、状态截断、错误后有效前缀、
小数默认与条件、带结尾点的本地域名、来源与折叠键冲突。未发现需变更旧历史格式的迁移需求。

## Live application cards

`app-card` blocks reference client-advertised IDs, with an optional bounded `query` only for
searchable sources. `list_intelligent_cards` discovers metadata; the engine checks IDs and
query support before accepting a document. Only complete successful documents mount live
cards (a streaming prefix cannot trigger plugin subscriptions or native writes).

Native Calendar and Todo reuse their existing compact Dashboard components and stores.
Installed plugins opt existing `registerListSource` contributions in with
`intelligent: { description, viewId }`; full contract: `docs/customization/plugin-development.md`.
Catalogs are normalized at ingress and run assembly, limited to 64 entries, with no user
records. The renderer resolves current availability again and tears down on disable.
Displaying a card is not model access to records, nor a save operation. Completed tasks
use the existing domain write path; newly generated checklists remain message-local.

A live card is the one object card in a document (DESIGN §5 recipe: `--bg-card`, `--radius-md`,
`--card-shadow`; the glass language drops the hairline). Its header is drawn by the host: the
app's own icon and name (a plugin card leads with the plugin's name), a dot with “Live”, and the
open-full-view button. A block `title` written by the model is not drawn on app cards. Plugin
rows show each item's own `iconUrl` / `icon`.

Acceptance: build engine and desktop, set `TANGU_IUI_BLUEBIRD` to the adapted Bluebird
checkout, then run `desktop/scripts/intelligent-cards.e2e.cjs` through the e2e devlock.
For real GPT-6 Luna discovery/rendering, use the archive wrapper with
`--only intelligentcards --model codex/gpt-6-luna`. Data fixtures live in a temporary vault;
the plugin, components, IPC and on-disk task writes are real. User-facing reports are HTML
with screenshots, provenance and explicit release boundaries.

The compact native surfaces also consume the full views' Markdown task/calendar projections.
Markdown completion uses `patchMark`, with note navigation as the fallback on hosts without
that write capability. Calendar and its compact cards share one mount-counted Agent schedule
poller (initial fetch, 60-second refresh, config changes, cleanup at the final unmount).
Bluebird navigation never primes a model run; saved transcript context accompanies an explicit
question. Its list cache is vault/work-folder scoped and rejects out-of-order prior-scope reads.
