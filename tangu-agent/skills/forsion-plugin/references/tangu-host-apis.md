# Tangu host APIs: ctx.tangu, ctx.desk, ctx.summary, ctx.automation

Split out of the forsion-plugin SKILL.md (1.63.0) because the model only sees the head and tail of a long tool result (capToolResult keeps 34k + 12k of anything over 48k chars). All of these are missing on non-Tangu hosts: always use optional chaining (`ctx.tangu?.`, `ctx.desk?.`, `ctx.summary?.`, `ctx.automation?.`). A 见「…」 that is not in this file points back to SKILL.md.

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
//     agentSlug?, agentName?, speechLevel? }
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
  `messageId` 变了(换了一条气泡)重置基线,负增量钳 0。这是 token 速率包络,不是语音响度。
- **语音通话的真实口型(`speechLevel`,2026-10-04 起)**:会话正在语音通话时状态里多一个 `speechLevel`(0..1,模型输出的真实电平,
  ~20Hz 更新,正常说话多在 0.2–0.8,没出声 = 0)。**有这个字段就按它张嘴,别走 `textChars`**:`typeof st.speechLevel === 'number'`
  → 张嘴量 = 平滑后的 `speechLevel × 增益`(上升 ~40ms、回落 ~90ms;音节起伏已经在信号里,别再叠正弦开合)。通话相位也叠在 `phase` 上:
  模型出声 → `speaking`(压过包括 `waiting` 在内的其余相位);用户说完、模型还没开口且没有 run 在跑 → `thinking`;通话里交给 Agent 代办的
  run 照常报 `tool` / `waiting` / `speaking`(此时 `speechLevel` 是 0 —— 聊天区在出字但没有声音,嘴别动)。拉取式,不进变更过滤;
  不在通话 / 旧宿主 → 字段不存在,照旧用 `textChars`。朗读(TTS)的响度目前仍拿不到。
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

### 新对话输入区:mountComposer(2026-10-18 起)

要一个「在这里打字、按发送就去 Tangu 开新对话」的输入区(主页就是这么用的),别自己拼 `mountChatBox` + `startChat`:
那样没有附件、模式、项目栏、运行位置、额外文件夹、Agent 条、语音、通话和技能。`mountComposer` 挂的就是内置主页那一整块。

```js
const box = ctx.tangu?.mountComposer?.(el, {
  onFocusChange: (focused) => root.classList.toggle('typing', focused),   // 输入区连同它的菜单拿到 / 失去焦点
  beforeSend: () => playLeaveAnimation(),   // 宿主发送前先等它;回 false = 这次不发
  call: true,                               // 要通话按钮(只在挂载时所在的 Space 是当前 Space 时画)
})
// 句柄:box.focus() / box.startVoice()(在点击处理里同步调,麦克风权限只认用户那一下)/ box.draft()(只读)/ box.dispose()
```

- **发送归宿主**:用户按发送 → 宿主建新会话、切到 Tangu、发出去。插件改不了要发的内容(`draft()` 只读);和 `ui.mountChatBox` 正好相反(那个草稿和提交都归插件)。
- `beforeSend` 抛错、超过 2 秒、或者插件这时被停用 / 视图被卸,宿主**照样发**:用户按下的那一下不能因为动画丢掉(它是放动效用的,别在里面弹确认框)。发送和开通话共用一把锁,同一时刻只放一次,动效没放完又按 = 不动。
- 没有 Tangu Space 的宿主(单品档案)上按发送不动;没有对话能力的宿主 / 旧宿主上整个缺席:`ctx.tangu?.mountComposer`。
- `dispose()` 之后 `el` 立刻还给你;插件被禁用 / 重载时宿主统一卸掉。

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
用户点「替换 / 插入下方」才写,Esc / 丢弃 = 一个字不动。入口在选中文字后那一条的「⋯ → 插件」(桌面 2.13.3 及更早在「AI ▾ → 插件」);
想让它在聊天或别的视图里也出现、按视图过滤、带图标,见上「Selection bar」:

```js
ctx.registerSelectionAction({
  id: 'checklist',
  title: ctx.getLocale?.() === 'en' ? 'To checklist' : '转成清单',
  run: async (cx) => (await ctx.tangu.complete({ prompt: 'Turn this into a markdown checklist', selection: cx.markdown })).text,
})
```

- `cx` = `{ text, markdown, pagePath }`:选区纯文本、选区的 markdown(保留加粗 / 链接 / 列表符)、笔记库相对路径
  (`pagePath` 只有笔记里有;新宿主另给 `view` / `editable` / `source` / `signal` / `onDelta`)。
- `run` 返回 `''` = 什么都不提议;返回值按 slash `run` 同一套校验(必须是字符串、不许控制字符)。
- 模型缺省 = 主区聊天当前用的那个;额度与用量照主聊天口径扣、记。插件被停用时在飞的 `complete` 会被中止并 reject。
- 笔记里宿主做不了正文 AI(探针没有 `complete`)时「AI ▾」「翻译」「⋯」都不出现,你的项也不会出现。

### 翻译:ctx.tangu.translate(2026-10-13 起)

逐句翻译、批量翻译这类**量大**的活别用 `complete`:那条恒用主区聊天当前的模型(往往是最贵的一档)。`translate` 走同一条
一次性通道,但模型取用户在「设置 → 模型 → 翻译」里选的那个;没选时目录里有机器翻译模型就用它,都没有才跟聊天模型
(桌面 2.13.3 及更早:没选就跟聊天模型):

```js
const tr = ctx.tangu?.translate
  ? (text) => ctx.tangu.translate({ text, language: 'Simplified Chinese', before: prev, signal })   // → { text } = 译文本身
  : (text) => ctx.tangu.complete({ prompt: 'Translate the text in <selection> into Simplified Chinese. Output only the translation.', selection: text })
```

- `language` 是写给模型看的目标语言(自由文本,英文名最稳);`before` 是原文前面的一段上下文,只供消歧、不翻。
- **只做翻译**:返回的就是译文,不会顺带改错字、不会按你的格式回话。要这些请另外用 `complete` 自己写指令(隔一段做一次,别逐句做)。
- 引擎每个用户同时最多 3 个一次性请求(`complete` + `translate` 合计),超出回 429。自己排队,并发开 2 就够。
- 旧宿主没有这个方法,先特性探测再退回 `complete`(上面的写法);不要为它抬 `minAppVersion`。
- 额度与用量按所用模型照常扣、记;插件被停用时在飞的请求被中止并 reject。

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
- **卡片正文是 `zoom: 0.75` + `pointer-events: none`**:卡片里收不到任何指针事件(点正文 = 展开侧板),旋转视角 / 戳模型这类交互只能
  放在 `desk-panel`。卡片宽约 280px、正文高 380px(2026-10-25 起 Desk 是摘要栏栈里的一张卡,原来是「聊天列高的一半」),底部圆角裁切。
- **卡片可以被用户收起**(2026-10-25 起):收起时 `desk-card` 挂载点**卸载**,再展开重挂 —— 和换会话、换面板一样,别假设卡片一直挂着。
- **WebGL 尺寸(zoom 下最容易错)**:canvas 的 CSS 保持 `width/height:100%`,绘图缓冲按**视觉尺寸**设:
  `renderer.setPixelRatio(devicePixelRatio); renderer.setSize(rect.width, rect.height, false)`,`rect = el.getBoundingClientRect()`。
  ⚠️第三个参数 **必须 `false`**:three 默认会把 278 这种视觉像素写回 style,在 zoom 0.75 里只铺满约 75%;用 `clientWidth`
  (局部像素 371)能铺满但多渲染约 1.33 倍像素。别信 ResizeObserver 的 `devicePixelContentBoxSize`(zoom 下给错值)。
- **resize 合并到 rAF**:侧板有 0.45s 的宽度过渡,拖宽把手逐帧改尺寸。指针换 NDC 一律用 `getBoundingClientRect()` 的比例(对 zoom 免疫),
  别把 `offsetX` 局部像素和视口 `clientX` 混用。
- **隐身但仍挂载**:聊天列窄于 760px 时卡片 `display:none`,组件却还在 —— canvas 变 0×0 而 rAF 照跑。尺寸为 0 / IntersectionObserver
  不相交 / `document.hidden` 时暂停渲染循环;`prefers-reduced-motion` 下减弱待机动画。
- 贴图 / glTF 的 CSP 注意事项见下「库内二进制资源」。

## 摘要栏插件卡:ctx.summary(2026-10-25 起)

Tangu 聊天右侧的**摘要栏**是一叠卡片:进度、后台(后台进程)、产物、来源、工作范围、Agent Desk。插件可以加一张卡,和内置卡同一个栈 ——
用户能折叠、拖动排序(悬停露拖动块,右键卡头有「移到最上 / 最下 / 恢复默认」),收起状态和顺序由宿主按卡片记住。插件卡按注册顺序排在 Agent Desk 前面。

```js
const h = ctx.summary?.registerCard({
  id: 'today',                               // 宿主拼成 plugin:<pluginId>:today,收起状态与顺序按它记
  title: { zh: '今天', en: 'Today' },        // 跟随界面语言;也可以给一个字符串
  defaultCollapsed: false,                   // 用户没点过时收不收;缺省展开
  mount(el, host) {                          // 每个会话的摘要栏各挂一份,返回卸载函数
    // host.sessionId: 这份挂在哪个会话(恒定:换会话 = 卸载重挂);host.cwd: 会话默认目录或 null
    // host.update({ count, hidden }): 只改这一份 —— 卡头计数(null = 不显示)、hidden = 先不画这张卡(仍挂着,之后可再亮出)
    const render = (events) => { el.replaceChildren(...events.map(rowOf)); host.update({ count: events.length, hidden: !events.length }) }
    const off = subscribeToday(render)
    return () => off()
  },
})
// 撤卡:h?.dispose()。禁用 / 重载时宿主统一收。
```

- **只在桌面 Tangu 上存在**(同 `ctx.desk`):web / 移动端 / 纯 Amadeus 壳整个没有 `ctx.summary`,一律可选链。
- **挂载次数**:每个会话的摘要栏一份;同屏两个聊天面板(主区 + 右侧 chat-panel)就是两份;换会话卸载重挂。新对话草稿(还没有会话)不挂插件卡。
- **正文高度上限 240px**,超出宿主内滚,底部自动渐隐;宽约 252px(卡宽 280 减内边距)。别在正文里再套一层滚动。
- **没内容就藏起来**:`host.update({ hidden: true })` 不画这张卡(栈里不留空位),有内容了再 `hidden: false`。不要靠渲染空 div 让卡片「消失」。
- 摘要栏只在聊天列够宽(≥ 760px)时出现;窄了整栈收起,但你的 `mount` 仍挂着 —— 别在不可见时跑重活(`IntersectionObserver` 判)。
- 正文是普通 DOM:用宿主的 CSS 变量(`--text` / `--text-muted` / `--ui-font-meta` …),行样式可以借 `.t2-tsum-row`(图标 + 文字的一行)。

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
