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

常驻提示段只讲通识;模型在一轮里出不出卡,主要看这一轮有没有那句「本轮提醒」(`sketchTurnSignalFor`,
`src/tools/builtin/sketch.ts`)。它按用户这条消息的字面分四类,都不调用模型、不带回用户原文:

| 类别 | 消息长什么样 | 提醒 | 收尾补催 |
|---|---|---|---|
| explicit | 点名要图、要卡、要可视化 | 必须交付 | 有 |
| implicit | 比较、流程、结构、三个以上数字加分析词 | 默认出 | 有 |
| actionable | 没有「图」的字眼,但答案要照着做、逐项勾、从里面挑:行程与安排、要带要买的清单、几样里选一个、做法 | 默认用 `intelligent_ui` | 没有 |
| shape | 上面三类都没命中的普通消息(跟进句、「怎么分配」「吃什么」「为什么」这类没有可抓的词的问法) | 不替模型判断:让它按「答案会长什么样」自己定,并写明什么时候不出 | 没有 |

- shape 是 2026-10-13 加的(用户反馈「触发时机和融入时机不如 ChatGPT 自然」)。把同样 18 句话发给 ChatGPT 网页版和改动前的引擎:
  ChatGPT 出了组件的 13 条里引擎只出 5 条,其中 4 条跟进句(「那四次挥手呢」「预算一千五以内呢」)只出 1 条。词表只读得到最后一句话的字面,
  这几句里没有可抓的词;所以不再往词表里加词,而是每条普通消息都给模型同一句提醒,由看得见整段对话的模型按答案的形状定:
  一两句话、用户要的一段文字(邮件、翻译)、代码、要办的事 → 不出;有要勾的、要挑的(含「A 还是 B」)、要照着做的、随某个数变的量、
  靠猜的偏好 → 一次 `intelligent_ui`;讲完整的机制 / 流程 / 结构(不是其中一个细节)→ 先读 `visualize` 技能再出一张 `intelligent_ui_html` 图。
  跟进只改一处时只重出那一处。改后同题连跑 3 次:13/13、10/13、11/13(跟进 4/4、2/4、3/4),不该出的 0/5;对照表与逐条命中率在仓根
  `harness-runs/2026-10-13/Intelligent-UI-对标ChatGPT-触发与融入.md`。
- shape 只在原生文档可用(`intelligent-ui.v1`)且档位是「自动」时发;三种消息不发:改 / 查 / 讲代码的、处理一段现成文字的(同 actionable 的两条),
  和「继续」「好的」这种三个字以内的应答。它每轮多带约 500 tokens(2,000 字符);一条出卡的回答中位 4.0 万 tokens、9 秒,不出卡的 1.9 万、3 秒。
- ⚠️ 只问流程里一个细节的事实题(「TCP 三次握手里的第三次是做什么的?」)不配图:配图那条写的是「whole … not one detail」,
  `visualauto` 的 fact 那条钉着(这半句去掉时它 1 次里 1 次出了图)。

- actionable 是 2026-10-11 加的(用户反馈「没明说就不出」)。改动前这类消息 6 条里只有 1 条出卡,
  只加这句提醒之后 7 次合计 39/42;一句事实、翻译这类不该出的 14 条里一条都没出(`harness-runs/2026-10-11/`)。
  没出的 3 条都是「两样里选一个」:2 次回了 Markdown 表,1 次把文档 JSON 写进了正文而没有调用工具(见下面「文档 JSON 写进了正文」)。
- actionable 不做收尾补催:这类说法宽,模型判断不该出卡时不值得再烧一轮。也因此词表只收指向明确的说法,
  「怎么做」「计划」这类在 agent 对话里天天出现的词不收(「接下来怎么做」「按计划继续」不是要一张卡)。
- 两种消息不发 actionable(`SKETCH_ACTIONABLE_SKIP_RE`):让模型改、查、讲代码的,和让模型处理一段现成文字的(翻译、润色、总结 —— 命中的词多半在那段文字里)。
  「还是」不在词表里(它多半是「仍然」的意思)。用户说了不要图、只要文字的不发任何一类。
- 提醒里写明了什么时候不出:整个回答只有一两句话,或者用户要的是把一件事办了(改代码或文件、建任务或日程)而不是一份可读的答案。
- 设置 → 模型 → 默认模型 里的「少一点」只留 explicit;「关闭」时工具与提示段一起撤下(这一行 2026-10-14 从「外观」搬到「模型」,检查 `npm run check:intelligent-ui-setting`)。
- 真模型验收:`--only visualauto`(6 条该出 + 2 条不该出,判据是该出的至少 4 条、不该出的 0 条)。
  加词之前先在这个场景里加一条对应的消息,基线用 `--kind base` 跑改动前的引擎。
- 和 ChatGPT 同题的对照:`--only iuiparity`(14 条首问 + 6 条跟进,共 20 个 run)。除了出没出卡,还记每条回答的形状:
  是不是以结论开头、末尾有没有追问、「说了有却没出」几条、卡几秒上屏、被拒收几次。判据是 ChatGPT 出了组件的 13 条里至少 12 条出卡,
  这条线目前 3 次里过 1 次(轮流没出的是「那里有什么值得去的?」「晚饭吃什么」「预算一千五以内呢」);别为了过线去调判据。
  看样子用 `desktop` 的 `npm run replay:intelligent-ui -- <归档里的 iuiparity-evidence.json> [--only=camp,dinner]`:
  把真模型的回答原样放进隔离的真 Electron,每条截开头和结尾各一张(走 e2e 锁)。

### 文档 JSON 写进了正文

模型偶尔把文档 JSON 当正文写出来、不调用工具,用户看到的是回答里夹一大段 JSON、没有卡。agentLoop 在收尾前认这种正文
(`looksLikeLeakedUiDocument`:不在代码围栏里的 `{"version":1,…"blocks":[…`),认出来就:

- 那条正文不进终稿(流式时已经上屏的那段,客户端在 `done` 时按终稿重排,会消失);
- 回灌一句 `<ui_document_check>`,让模型真的调用 `intelligent_ui`;用户就是要看 JSON 的话,让它放进代码块重答;
- 一个 run 只纠正一次。这一轮已经调过 `intelligent_ui` 的不纠正(卡已经有了,再纠正会多出一张),下一轮是不带工具的收尾轮时也不纠正。

状态事件 `ui_document_recovery`。真模型验收:`--only uileak`(用户说「工具点了没反应,把 JSON 写进正文」,把这种情况逼出来;
判据是终稿里没有裸的文档 JSON、且纠正过的那几条最后都出了卡)。

### 卡和正文怎么接

ChatGPT 的整条回答是一棵组件树(正文段落、标题、清单、表单是同级兄弟),没有「工具卡」这一层。这边对应的做法:

- **文档就是回答,不是回答的附件。** 模型直接调用,不在调用前用正文预告;文档第一个区块是不带标题的文字块,写结论和它替用户做的假设;
  组件之间的道理也写成文字块。调用之后就收尾,只有文档里没有的注意事项才补一句,不复述结论。只有文字块的文档不算视图,那种回答直接写正文。
  ⚠️ **别改回「先写一两句话、再调用工具」**:真模型第 1 次(10-13)照这个说法,GPT-6 Luna 的 11 条里有 5 条写完那句话
  (「下面的清单可以逐项勾选」)就收尾了,卡没出。场景里「说了有却没出」单列一项计数。
- **末尾的追问做成表单。** 答案建立在会改变它的假设上(给谁、几个人、预算、水平、口味)时,给这些假设各配一个选择输入,文档以一枚追问钮收尾
  (model action:按所选的值重做答案),不用正文去问。只喂给这枚钮的输入放在它前面的控件块里;上面已经出现过的输入不重复。
- **同一个输入被列了两次不再拒收。** 模型爱在追问钮前面把同一组输入再列一遍;校验器现在只保留第一次出现的位置,后面的重复去掉(整块空了就去掉整块)。
  拒收的代价是多等一轮,而且回答里会留一张残缺的卡。
- 渲染端(`desktop` 的 `partitionToolSegment`):生成中和成功的 `intelligent_ui` 调用不在文档上面挂工具行;被拒收的那次留工具行(错误在里面),
  如果模型在同一段里重写了一份,残缺的那份不画。文字块用和聊天正文相同的 CJK 友好解析(`**怎么选：**如果` 不再露出星号)。

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
