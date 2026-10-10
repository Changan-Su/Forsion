# Forsion Intelligent UI v1

普通交互计划、图片候选、网页来源与定性比较走受控原生组件；自定义图表与模拟器继续走 Sketch 沙箱。
这是一套 Forsion 实现，不是 ChatGPT 内部协议复刻。用户侧名称为 Intelligent UI。

## 边界

- `client_capabilities: ["intelligent-ui.v1"]` 是渲染能力握手。没有握手的旧客户端不获得新工具。
  初版仅 desktop/web 可生成；保留原有移动端 Sketch 禁用规则。原生文档本身没有脚本。
- 复用 `tool_stream`、`tool_call`、`tool_result` 与现有历史 JSON 存储，不创建另一套 SSE 协议或数据库表。
  `document` 是 JSON 字符串，参数完整落库；工具结果只提供短确认或纠错信息。
- 服务端及客户端使用同一纯 TypeScript 验证器：`src/shared/intelligentUi.ts`。渲染入口位于
  `desktop/frontend/src/components/IntelligentUi.tsx`，消息顺序由 `EditorialMessage` 保持。
- 声明式内容不接受 HTML、JavaScript、CSS、表达式或任意 API 动作。富文本不执行代码，不内嵌图片。
  外部来源经现有链接路由打开，不是嵌入任意网页的 iframe。
- 图库使用浏览器加载经过 URL 校验的公开 HTTPS 图片，禁用 referrer；失败保留替代文字及重试。
  引擎不代替浏览器请求这些 URL。URL 规则不是 DNS 或重定向防火墙。图片描述必须有实际看图或用户提供的依据。

## 内容、状态与流式

文档含 `inputs`、`resources`、`blocks`；完整格式和示例见 `skills/intelligent-ui/SKILL.md`。
Chat 模式不开放技能工具，必需格式也包含在 `INTELLIGENT_UI_SECTION` 中。工具定义保持简短，
通过既有 Chat GUI 12,000 B 预算；不是每次都让模型生成完整网页代码。

文档上限 64 KiB（UTF-8）、8 个输入、24 个资源、40 个区块、总共 200 个清单条目。
每个输入必须且只能出现在一个始终可见的 controls 区块。资料完整并且引用有效后才提交区块；
流式中断或后续区块无效时，显示最长有效前缀，并标明内容不完整。刷新回放采用同一逻辑。
模型默认值只初始化未编辑的输入；后续内容补齐不覆盖用户选择，不重新挂载已有控件。

状态键为 `[session:message, callId, documentId, 1]`，不用内容哈希或流事件版本作为 React key。
本机状态独立保存输入、已购数量与展开状态；派生量不保存、不自动发送给模型。状态损坏会恢复为空，
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

1. `tangu-agent`: `npm run build`，相关 Vitest：`src/shared/intelligentUi.test.ts`、
   `src/tools/intelligentUi.test.ts`、`src/tools/sketch.test.ts`、`test/chatPreset.test.ts`。
2. `desktop`: `npm run build`、`npm run typecheck`，相关 Vitest：`intelligentUiState.test.ts`、
   `editorialSketch.test.ts`、`agentRunService.client.test.ts`、`i18nCoverage.test.ts`。
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
`intelligent: { description, viewId }`; full contract: `docs/customization/plugins.md`.
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
