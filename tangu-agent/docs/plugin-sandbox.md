# 插件沙箱(Plugin Sandbox)· 接缝契约

> 状态:v1(2026-10-23,方案 A);第二轮(2026-11-03):纯净沙箱、Space 列得出来、在沙箱里动手、右栏沙箱卡;
> 安装体验(2026-11-28,方案 A):装没装三态、确认框挂在点按钮的那扇窗上(仓根 `docs/ToBeImproved/插件沙箱安装体验方案_2026-11-28/`)。
> 方案页与取舍见 Forsion 仓根 `docs/ToBeImproved/插件沙箱方案_2026-10-23/` 与 `插件沙箱第二轮方案_2026-11-03/`。
> 本文件是引擎(`tangu-agent`)、桌面渲染层(`desktop/frontend`)、桌面主进程(`desktop/electron`)三方的唯一契约。
> 线协议沿用 [phone-control.md](phone-control.md) 的 `client_cmd`(§3),这里只写插件沙箱自己的部分。

## 1. 是什么

agent 开发插件时没有验证环境、用户也没有试用环境,只能直接装进用户的 Forsion。插件沙箱 = 桌面宿主**按需另起的一份
Forsion 进程**,只装这一个插件的开发副本:

- 自己的 `--user-data-dir`、`TANGU_HOME`、工作区、智库,全在 `<forsionHome>/sandbox/<插件 id>/{userdata,home,workspace,vault}`;
- 不登录(home 里没有 auth.json)、引擎地址指向死端口(`TANGU_BACKEND_URL=http://127.0.0.1:1`,不起引擎)、不连电脑操作助手;
- 不碰整机共享的东西:协议注册、托盘、全局快捷键、CLI、MCP 固定端口、更新检查、自动 Mini;关窗即退出;
- 插件以开发副本加载(`amadeus/ipc.ts` 的 `readDevPlugins`,来源 = `FORSION_SANDBOX_PLUGIN`),监视插件目录,保存即重载;
  它带的 `spaces/<slug>/space.json` 也列进 Space 清单(`main.ts readSpacesList({dev:true})`,开发副本排在安装版前、遮住同 id 的安装版;
  设备页那份清单不带开发来源);
- **纯净**(11-03):内置插件只播种被测插件 `requiresPlugins` 点名的那几个(`sandboxRequiredPlugins`;旧版沙箱播种过的一并撤掉,
  删前核路径确在 `<forsionHome>/sandbox/<id>/home` 下);Ribbon 只放被测插件自己的 Space,一个都没带时留主位那一格
  (`sandboxWindow.ts pureRibbon`,内置 Space 照旧注册、只是不上条);装载落定、Space 配方扫完后落到插件的第一个 Space,没带 Space 就开它的第一个视图;
- 窗口标题「Forsion 沙箱 · 名字」/「Forsion sandbox · name」,页面自己的 `<title>` 盖不掉;
- 沙箱窗口平时压在别的窗口底下:子进程启动前加 `disable-renderer-backgrounding` 等三个开关、窗口关掉后台节流,
  截图前先 `invalidate()` 再等两帧,截到的是新画面;
- 跟随用户那份的界面语言与主题(起沙箱时带过去),跳过首启引导和开屏;
- 同一时刻只有一个沙箱;沙箱窗口不在前台、15 分钟没人用就自动停(状态要不回来也停)。起 / 停 / 重置 / 安装 / 闲置停排成一队,一件做完再做下一件。

⚠️ **隔离的是数据和登录,不是权限**:沙箱不是防恶意插件的安全边界。插件代码在沙箱里拿到的宿主 API 与装进用户那份之后一样
(读写文件、终端等照样能用),只是缺省目录、智库、登录、引擎都换成了沙箱自己的。按插件 API(`ctx.vault` 等)走的读写碰不到用户的数据。

与 Coding Studio「我的 Forsion」那一档(`devLoad`,开发副本直接装进用户正在用的 Forsion)并存:那一档不是隔离环境。

## 2. 分层

```
model → plugin_sandbox / plugin_sandbox_inspect(tangu-agent builtin,deferred)→ ctx.requestClientAction({ns:'plugin', op, args})
  → client_cmd {ackId, ns:'plugin', body} → 桌面渲染层 services/pluginSandboxSurface.ts
  → claim(digest = body 的 sha256)→ window.tangu.pluginSandbox.exec(op, args, {sessionId, ui})
  → 主进程 electron/pluginSandbox.ts(父)── 本机 socket + 一次性令牌 ──→ electron/sandboxChild.ts(沙箱进程的主进程)
                                                                         → executeJavaScript → frontend/src/sandbox/sandboxWindow.ts
  → result {ok, code?, error?, text = SandboxStatus JSON, image? = JPEG 截图}
```

- **能力**:`plugin.sandbox`,ns `plugin`。引擎门控 `toolRegistry.CLIENT_FOR_NS`:`plugin` 只给 `^desktop/` 客户端。
  只有用户那份桌面 Forsion 注册这个面(`window.tangu.pluginSandbox` 在);沙箱自己、web、mobile 都不声明。
- **桌面在 JS 里回执**(与手机不同):动作在主进程,渲染层与主进程同属被信任的宿主。引擎 pending 表照样是唯一权威。
- **控制通道**:父进程开 unix socket / Windows 命名管道(tmpdir,路径带 pid 与随机段),子进程用环境里的一次性令牌连回来,
  第一行 `{hello: token}`,不对就断。之后按行 JSON:父 → 子 `{id, op, args}`(`status / screenshot / command / reload / show / quit`,
  11-03 起加 `read / click / type / press / scroll / space / files`,11-15 起加 `settings`,子进程回 `{action, image?, error?}`),
  子 → 父 `{id, ...}` 应答或事件 `{event: 'state' | 'report' | 'install' | 'reset' | 'forward'}`。不开远程调试端口。
  11-28 起:父 → 子多 `confirmInstall`(带文案的确认框,子进程挂在沙箱主窗上弹,回 `{response}`)与三条 id 0 的通知
  `installed {installed}` / `installResult {...SandboxInstallResult, origin}` / `yieldPinned {on}`;子 → 父事件多
  `install {force?}`、`openHost {settings?}`、`close`(沙箱窗口回执卡上的按钮)。
  控制通道一断(父进程退出 / 崩溃),沙箱跟着退。

## 3. 工具

| 工具 | 动作 | 审批 | 说明 |
|---|---|---|---|
| `plugin_sandbox` | `start {path}` / `stop` / `reset` | `approval: 'command'`(与 run_bash 同档) | start 的相对路径按会话工作目录解析;同一个插件再 start = 就地重载,另一个插件 = 先停前一个。reset = 清空沙箱目录后重起 |
| `plugin_sandbox_inspect` | `status` / `screenshot {view?}` / `logs` / `command {command, args?, screenshot?}` | 无 | 只读状态,或在沙箱里跑插件自己注册的命令(参数原样交给 `run(args)`;`screenshot:true` 落定后截一张) |
| 同上(11-03) | `read {target?}` / `click {target}` / `type {target?, text, append?}` / `press {key, target?}` / `scroll {target?, amount?}` / `space {space}` / `files {paths?, mode?}` | 无 | 在沙箱里动手,见 §3.1 |
| 同上(11-15) | `settings {close?}`;read / click / type / press / scroll / screenshot 多一个 `window: 'main' \| 'settings'` | 无 | 插件的设置页在独立的设置窗口里,见 §3.2 |

### 3.1 在沙箱里动手(11-03)

agent 不该用 computer use 去点沙箱窗口(它故意压在用户的窗口底下,截图里看不到原生对话框)。改由这几个动作:

- `read`:页面大纲。看得见的控件一行一个、带引用(`[e12] button "Add book" (disabled)`),标题与成段的字只列出来;`target` 收窄到一块。
  名字后面的括号是状态:`disabled` `checked` `selected` `pressed / not pressed`(aria-pressed,开关按钮)`read-only`(aria-readonly,
  或收字的控件 readonly / contenteditable=false)`expanded / collapsed` `focused` `value "…"`。开关按钮的名字说它管什么、状态看 pressed
  (笔记的阅读 / 编辑切换:名字固定「阅读模式」,按下 = 正在阅读;以前名字跟着变,读到的是「编辑,已按下」,意思正好反了)。
  大纲 ≤ 16k(`SANDBOX_OUTLINE_BUDGET`);引用每次 read 重编,页面变了旧引用作废(会说「read again」)。沙箱条(报告问题 / 安装 / 重置)不给 agent 点。
- `target` 三种写法:read 给的 `eN`;`css:<选择器>`;控件看得见的字(先按名字精确、再包含,最后任意元素的字,取面积最小的)。
- 目标中心点上压着宿主的通知卡(`.ntf-wrap`,插件 `ctx.notify` 也弹在这里):先把通知全关掉、等它退场让开,再点;回执的 did 说
  「a notification was covering it」,通知的字进 target(数据区)。一秒内让不开(新的一直在弹)就不点,报错。不先点再说:点下去落在
  通知上,碰到的可能是它的「撤销」。底部吐司 `.amx-toast` 不接指针,不挡。
- `click` / `type` / `press` 是**真输入**:渲染层只负责找元素、滚进视野、给坐标(还报「上面压着别的元素」),主进程发
  `sendInputEvent`(鼠标按下 / 抬起、键盘)与 `insertText`。`type` 缺省先选中框里原有的字再插入(替换),`append:true` 接在后面;
  `press` 认 `Enter` `Escape` `Tab` `Backspace` `ArrowDown` `a` `Mod+K`(Mod 在 mac 是 Meta)等,空格分隔可连按。
- `scroll`:渲染层对 target 所在的滚动区(缺省 = 屏上最大的那块)`scrollBy`,正数往下。
- `space`:切到插件带的 Space(按 id 或名字),别的 Space 不给切。
- 这五个做完都等界面落定(DOM 静 200ms,最多 1.5s,再两帧),截一张,回执带「动作期间插件新写的 console(最多 15 条)」与「新弹的提示」。
- `files`:给**下一个**文件对话框备好答案。路径只认插件目录与沙箱目录里的(按真实路径核,软链指出去、`../` 绕出去的都不收);
  `mode:"save"` 时文件可以还不存在、父目录得在里面;不给 paths = 下一个对话框当用户点了取消。
  两条路都拦:主进程的 `dialog.showOpenDialog / showSaveDialog`(包一层);`<input type="file">` 弹的选择框不走 dialog 模块,
  备着的时候经 CDP `Page.setInterceptFileChooserDialog` 拦下、`DOM.setFileInputFiles` 填进去(没备就是普通系统框)。
  没备时插件弹出原生框:状态里 `dialog` 报出来,动作一律拒绝(「先 files 再点」)。

### 3.2 设置窗口与等对话框的命令(11-15)

- **能力协商**:11-15 起的桌面多声明 `plugin.sandbox-v2`。老桌面不认 `window`,会把「设置窗口里的点击」静默做在主窗上,
  所以引擎没看到 v2 时:`settings` 和 `window: 'settings'` 不发、直接说桌面比工具旧;`window: 'main'` 不带;command 不带 `allowPending`。

- **设置窗口**:设置是独立的顶层浮动窗口(不是主窗的子窗),插件的 `registerSetting` 行与 `registerSettingsView` 面板画在
  「设置 → 插件 → 本插件」的详情页里。`settings` 动作经主窗的 `openSettings('fplugin:<id>')` 打开它(与用户点齿轮同一条路),
  等这扇窗的渲染层装上钩子、插件在它那份插件仓里装上,落定后回这扇窗的大纲和截图;`close: true` 关掉。
  之后 read / click / type / press / scroll / screenshot 带 `window: 'settings'` 在这扇窗里做;不写 window = 主窗。
  引用按窗口分:主窗 `e12`、设置窗口 `s12`;没写 window 而 target 是 `sN` 的自动去设置窗口,拿 `sN` 去主窗点 → 报错,不点同号的别的元素。
  space 只在主窗。设置窗口没开着时带 `window: 'settings'` → 报「没开,先 settings」。
  每扇窗各有一份插件实例:保存即重载 / reload 时设置窗口跟着 `reloadPlugin()`。`files` 的 `<input type=file>` 拦截两扇窗都挂。
  静默模式(macOS)下 agent 开的设置窗口压到普通窗口之下(同主窗);用户进了沙箱(任一扇窗获焦 / 卡片上「打开沙箱窗口」)就放回普通层级。
- **等对话框的命令**:引擎带 `allowPending: true`(v2)时,渲染层的 `command` 跑 1.5 秒还没完(多半弹了自己的选择框在等人点),先回 `{ok, pending: true}`,
  父进程挂在结果 text 的 `command: {pending: true}` 上(老引擎不看它,照旧说「跑了」),工具说「开始了、还在跑,去读窗口接着做,别重跑」。
  之后才抛的错记进插件的 console(`[sandbox] command "x" failed after it had started: …`)。
  不带 `allowPending`(老引擎)照旧等它跑完:老引擎把回执当「跑完了」,早回会让它以为写完了;等满 10 秒还没完,说「命令没跑完、可能在等它弹的框」。
- **钩子没拿到值分四种说法**:窗口没开 / 渲染层还没装上钩子(「还在启动」)/ 等超时(「页面忙或卡住」,带秒数)/ 调用本身失败(「页面可能刚重载,再试」)。
  以前一律报「还在启动」(`sandboxChild.ts` 的 `hookMissText`)。

回执挂在桌面回来的 text 的 `action` 键上(`{...SandboxStatus, action: SandboxActionReport}`),`parseSandboxStatus` 不看它,
`parseSandboxAction` 单独解析;状态 + 大纲超 46k 时先削大纲。老桌面不认这些动作:回 `unsupported`,工具说「Forsion 比工具旧」。

start / reset 的结果末尾挂 `<sandbox-status>{JSON}</sandbox-status>`(尖括号转义),对话卡据此画历史状态。
插件自己说的话(名字、console、报错、视图名)进模型前圈进 `<sandbox_data>` 数据区,尖括号换成 `‹›`。

失败码沿用 phone-control §3.4,另加:`no_sandbox`(没有在跑的沙箱,先 start)、`invalid_args`(不是绝对路径 / 没有 manifest.json /
manifest id 不合规或是商店身份 `market-*`)。

## 4. 状态(`contracts/pluginSandbox.ts` 的 `SandboxStatus`)

`{v:1, state, pluginId, name, version, dir, views, spaces, hiddenSpaces[{slug,reason}], setupError, blocked, mountErrors[{view,message}],
logs[{level,text}](最近 40 条), warnCount, errorCount, loads, windowVisible,
vault, activeSpace, notices[{level,text}](最近 8 条), dialog{kind,title}|null, filesArmed:'paths'|'cancel'|null,
installed{state,version,changed,folder}|null}`(vault 起五个 11-03 起;installed 11-28 起由父进程填,子进程不报;老桌面不报 = 空值)

- `installed`:用户那份 Forsion 里这个插件的安装情况。父进程逐文件比 `<forsionHome>/plugins/<id>` 与沙箱目录的内容(sha256,
  范围同安装:真实目录、软链跟进、跳过 node_modules / .git / .forsion / .DS_Store;超 4000 个文件或 256 MB 不比 = `unknown`):
  `none` 没装 / `same` 装的就是这一份 / `older` 装过、之后改过(`changed` = 不同的文件数,版本号没变也按内容算)/
  `store` 同一个 id 以别的目录名装着(`folder`,多半是商店的 `market-…`,`.installing-` / `.old-` 临时目录不算)/ `unknown`。
  起好、保存即重载(`loads` 变了)、装完各重算一次;变了就广播(卡片)并推给沙箱窗口(顶条按钮)。引擎把它写成一行给模型。

- `state`:`starting`(插件宿主还没装载落定)/ `running` / `failed`(setup 抛错或没列出来)/ `blocked`(宿主拒载)/ `stopped`;
- `loads`:自启动以来装载了几次(保存即重载会累加);
- `windowVisible`:用户此刻正在用沙箱窗口(它在前台)。窗口平时压在普通窗口之下,看得见不算;闲置判定靠它。
- `vault`:沙箱自己的智库路径;`notices`:最近弹出的提示(通知中心 + Amadeus 的小提示),插件的「保存成功 / 出错了」多半只在这里;
  `dialog`:正开着的原生对话框(挡着窗口、截图里看不见);`filesArmed`:下一个文件对话框备好了没有。
- 引擎的状态文字另数插件目录里的 `spaces/*/space.json`:「带了 N 个、显示了哪些、隐藏了哪些(原因)、连列都没列出来的是哪些」。

引擎与卡片都过 `parseSandboxStatus`(不像状态就 null,超长截断;整份按转义后长度封顶 `SANDBOX_STATUS_BUDGET` = 24k,超了轮流丢最早的
console 与最后的挂载报错 —— client_cmd 结果 text 与工具结果都是 48k 帽,截断的 JSON 解析不出来)。

## 5. 界面

- **对话卡**(`frontend/src/views/chat2/PluginSandboxCard.tsx`,任务卡一族,在 Tangu 界面边界里):plugin_sandbox start / reset 成功后替掉那行工具调用。
  头:「沙箱:名字 版本」+ 状态签 + 「隔离数据 · 未登录」;事实行(视图 / 隐藏的 Space / 报错 / 控制台计数);
  按钮:打开沙箱窗口 / 重置数据 / 安装到我的 Forsion,沙箱停了换成「重新启动」。手机 / 网页只读,提示到电脑上打开。
- **右栏沙箱卡**(`frontend/src/views/chat2/SandboxRailCard.tsx`,11-03,摘要栏卡片栈里排在进度下面):只在发起沙箱的那个对话里出现
  (`PluginSandboxState.sessionId` / 停了以后看 `last.sessionId`)。缩略图 = 最近一张截图(`lastShot(sessionId)` 另取,`shotAt` 变了才取;
  点图 = 打开沙箱窗口)、事实行(视图数 · Space · 控制台错误数)、「最近一步」(`lastOp`,看状态不算一步)、安装到我的 Forsion;
  停了变灰 + 「重新启动」+ 停的原因(`last.reason`:`idle` 闲置 15 分钟 / `exited` 窗口关了 / `stopped`);装载失败给报错 + 打开窗口 / 重置数据。
- **沙箱窗口**(`frontend/src/sandbox/SandboxChrome.tsx`):标题栏右侧「沙箱 · 名字 版本」胶囊 + 重置 / 报告问题 / 安装到我的 Forsion,
  首次打开垂一条说明。按钮只把意图交给父进程:报告问题 → 回到发起沙箱的那个对话,话放进输入框(用户自己决定发不发)。
- **Coding Studio Sandbox 面板**:两档,隔离沙箱(缺省)/ 我的 Forsion(原来的开发加载器,原样保留)。
- **安装到我的 Forsion**:先确认,再把插件目录拷进 `<forsionHome>/plugins/<id>`(先拷到旁边再换,不带
  `node_modules` / `.git` / `.forsion`;按真实目录拷,软链拷成实体;换的那一步失败就把旧的放回去);同一个插件已从商店装在别的目录名下就拒绝(code `store`)。
  同意绑在确认框里那个插件上:等用户点的工夫沙箱换了插件 / manifest 换了 id,就不装(code `changed`)。装好广播 `extensions-changed`,各窗自己重载。
  - **确认框挂在点按钮的那扇窗上**(11-28 方案 A):沙箱窗口顶条点的 → 父进程把文案交给子进程,子进程在沙箱主窗上弹系统框
    (⚠️ 不画在沙箱网页里:插件代码和沙箱条同在一个渲染层,网页里的「同意」插件能自己点掉;系统框它够不着),弹着时状态 `dialog` 有值、agent 动作先拒;
    卡片 / 右栏 / Coding Studio 点的 → 用户那份主窗上弹,主窗用 `app.focus({steal})` 抬到最前。两种都先让开置顶的东西
    (钉住的浮动面板、插件桌面小窗,`main.ts yieldPinnedWindows`;沙箱那边经 `yieldPinned`),关掉放回去。
    等确认的工夫沙箱没了 → 当取消,不再到主窗上问。同一时刻只开一个确认框。
  - **装的就是这一份时不再覆盖**(code `same`,不弹框);沙箱窗口回执卡上的「重新安装」带 `force`。`older` 时按钮叫「更新」、确认框问「用沙箱里这份更新…」。
  - **装完**:沙箱留着(插件开发一轮轮改,装完常要再对一遍)。顶条「安装」→ 灰的「已安装 ✓」,从顶条点的那次在按钮下垂回执卡
    (在我的 Forsion 打开 / 关闭沙箱);装不上垂说明(`store` 带「打开插件设置」)。对话卡 / 右栏 / Coding Studio 读同一份 `installed`:
    已安装 → 「在我的 Forsion 打开」(主窗切到插件的 Space,没有就开设置页,`mainAction open-plugin`)+ 打开沙箱窗口 / 关闭沙箱;
    沙箱停了的历史卡向主进程问 `installedOf(dir)`;手机 / 网页看工具结果里存的那份。报错按 code 说人话,原文只在 `error` 时带上。
  - 台架替用户点子进程的确认框:`FORSION_HARNESS_SANDBOX_CONFIRM=0|1`(只认开发构建,打包版不起作用)。

## 6. 不做(v1)

快照回滚、商店里「在沙箱里试」、多个插件同时开、云端沙箱、沙箱里起引擎(插件的引擎半身 / agent / 技能)、
能力级沙箱(收窄插件能用的宿主 API)。沙箱里的设置页也起不了整机共享的东西:对外 MCP、设备互联、托管引擎、写系统图标在入口处一律跳过。

## 6b. 演示舞台(2026-11-20+,插件的 `ctx.stage`)

同一套「另起一份、目录隔离」的第二个槽位,给插件拍演示图 / 录演示视频(方案:仓根 `docs/ToBeImproved/沙箱开放给插件方案_2026-11-20`)。
和开发沙箱互不挤占;父进程那侧 `desktop/electron/pluginStage.ts`(`createPluginSandbox({ base: 'stages' })` 的第二个实例 + 主人 / 确认 / 回放服务),
参数与错误码 `desktop/shared/pluginStage.ts`,插件入口 `desktop/frontend/src/amadeus/plugins/stageCtx.ts`。

- 目录 `<forsionHome>/stages/<插件 id>/`(和 `sandbox/` 分开,id 以 stage- 开头的插件撞不上);每次 open 先整个清空;同意记录 `stages/.grants.json`。
- 子进程认 `FORSION_SANDBOX_INFO.stage`:不装开发副本、不监视目录、没有沙箱条、Ribbon 照旧;就绪 = 点名的插件都列出来且装载落定;
  窗口内容区按参数(`useContentSize` + `enableLargerThanScreen`),像素密度用 `force-device-scale-factor`;不透明、玻璃关。
- 装进去的是用户已安装插件的**包**(按 id 在 `plugins/` 里找、按真实目录拷,不带 `plugins-data/`);内置插件也要点名。演示库只拷 fixture/vault 里的普通文件。
- 截图 `capture`:`capturePage` 原生密度 PNG 写进 `out/`,父进程核过路径读出来交给插件;录像:渲染层 `getDisplayMedia` 录本页签
  (子进程的 `setDisplayMediaRequestHandler` 只给武装过的那一次、只给主窗顶层 frame),录完经 `pluginSandbox:saveRecording` 落盘。
  暂停 / 继续(11-26):`recordPause` / `recordResume` 两个操作直通渲染层 `MediaRecorder.pause()` / `resume()`;暂停的时长从
  `durationMs` 里扣掉,到点自停的计时也只数录下的时间(继续时按剩余时长重新定时)。收尾中或没在录 → error。
  这两个操作走 `rawNow`、不进父进程的串行队列：动作要等画面稳住约 1.5 秒才回，排在它后面的暂停只能等动作做完，插件就剪不掉这段收尾。子进程按消息并发处理，回包按 id 对。
- `engine: 'scripted'`:父进程起 `stageEngine.ts` 的本机回放服务,舞台的引擎地址指向它(`tangu-desktop-config.json` 与 `TANGU_BACKEND_URL`)。
  第 6 节的「沙箱里不起引擎」对舞台的这一档不成立:起的是回放,不是真引擎。
- 互斥:同一时间一个舞台;别的插件 open → `busy`;闲置 5 分钟自停;插件停用 / 重载时宿主替它关。
- 已知限制(11-20 Codex 评审,按方案「隔离的是数据和登录,不是权限」接受):插件 id 是渲染层的宿主入口填的,同一渲染层里冒用别的
  插件 id 拦不住(主进程能做的:只收 id + 相对路径、按装着的 manifest 核 `stage` 能力、每次 open 带代号);舞台里装的插件照样有终端、
  屏幕共享列表这些本机能力,和开发沙箱一样。截图 / 录像独占新建、录像只收正在收尾的那一段、码率上限 16 Mbit/s。

## 7. 仪器

- 引擎:`src/tools/builtin/pluginSandbox.test.ts`、`src/tools/clientCapabilityGate.test.ts`(plugin.* 只给桌面);
- 桌面主进程:`desktop/electron/pluginSandbox.test.ts`(假子进程走真 socket:握手 / 令牌负对照 / 就地重载 / 闲置自动停 / 安装与同意绑定 /
  起停排队 / spawn 失败马上报;11-28 起:装没装 none → same → 不覆盖(same)/ force → older、store、临时目录与 node_modules 不算、超上限 unknown);
- 子进程纯函数:`desktop/electron/sandboxChild.test.ts`(按键映射、files 路径门禁:软链 / `../` / 沙箱外);
- 演示舞台:`desktop/electron/pluginStage.test.ts`(参数清洗、目录守卫、找插件、fixture 软链、只拷普通文件、同意记录、主人与互斥);
  真 Electron `npm run check:pluginstage`(确认框两次、2560×1600 PNG、Space、时钟、隔离、selector 截图、录像能解码、脚本回放、busy、负对照、close);
- 真 Electron:`desktop` 的 `npm run check:pluginsandbox`(父进程 + 它真起的沙箱:claim 电文、主题色跟随、隔离、保存即重载、命令、报告问题、
  对话卡、setup 抛错、安装、停止与不留孤儿、负对照;11-03 起加:插件 Space 列出来并落在上面、Ribbon 没有内置 Space、没播种内置插件、
  read → type → click → press 拿到插件的 console 与提示且截图是新的、files + `<input type=file>`、沙箱外路径负对照、右栏卡运行 / 停止两态);
  `SHOT_DIR=<目录>` 落沙箱窗口、点完之后、对话卡、右栏卡截图;
- 真模型:live 台架 `--only pluginsandbox`(台架扮桌面应答 `plugin.*`,含无能力 / 手机端两个负对照;⑤ 在沙箱里 read → type → click 并转述点完冒出的报错;
  ⑥ settings 打开设置窗口、在那扇窗里填字点保存;⑦ 命令回 pending 时不重跑、读窗口在框里选)。
