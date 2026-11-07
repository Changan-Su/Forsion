# 插件沙箱(Plugin Sandbox)· 接缝契约

> 状态:v1(2026-10-23,方案 A);第二轮(2026-11-03):纯净沙箱、Space 列得出来、在沙箱里动手、右栏沙箱卡。
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
  11-03 起加 `read / click / type / press / scroll / space / files`,子进程回 `{action, image?, error?}`),
  子 → 父 `{id, ...}` 应答或事件 `{event: 'state' | 'report' | 'install' | 'reset' | 'forward'}`。不开远程调试端口。
  控制通道一断(父进程退出 / 崩溃),沙箱跟着退。

## 3. 工具

| 工具 | 动作 | 审批 | 说明 |
|---|---|---|---|
| `plugin_sandbox` | `start {path}` / `stop` / `reset` | `approval: 'command'`(与 run_bash 同档) | start 的相对路径按会话工作目录解析;同一个插件再 start = 就地重载,另一个插件 = 先停前一个。reset = 清空沙箱目录后重起 |
| `plugin_sandbox_inspect` | `status` / `screenshot {view?}` / `logs` / `command {command, args?, screenshot?}` | 无 | 只读状态,或在沙箱里跑插件自己注册的命令(参数原样交给 `run(args)`;`screenshot:true` 落定后截一张) |
| 同上(11-03) | `read {target?}` / `click {target}` / `type {target?, text, append?}` / `press {key, target?}` / `scroll {target?, amount?}` / `space {space}` / `files {paths?, mode?}` | 无 | 在沙箱里动手,见 §3.1 |

### 3.1 在沙箱里动手(11-03)

agent 不该用 computer use 去点沙箱窗口(它故意压在用户的窗口底下,截图里看不到原生对话框)。改由这几个动作:

- `read`:页面大纲。看得见的控件一行一个、带引用(`[e12] button "Add book" (disabled)`),标题与成段的字只列出来;`target` 收窄到一块。
  大纲 ≤ 16k(`SANDBOX_OUTLINE_BUDGET`);引用每次 read 重编,页面变了旧引用作废(会说「read again」)。沙箱条(报告问题 / 安装 / 重置)不给 agent 点。
- `target` 三种写法:read 给的 `eN`;`css:<选择器>`;控件看得见的字(先按名字精确、再包含,最后任意元素的字,取面积最小的)。
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

回执挂在桌面回来的 text 的 `action` 键上(`{...SandboxStatus, action: SandboxActionReport}`),`parseSandboxStatus` 不看它,
`parseSandboxAction` 单独解析;状态 + 大纲超 46k 时先削大纲。老桌面不认这些动作:回 `unsupported`,工具说「Forsion 比工具旧」。

start / reset 的结果末尾挂 `<sandbox-status>{JSON}</sandbox-status>`(尖括号转义),对话卡据此画历史状态。
插件自己说的话(名字、console、报错、视图名)进模型前圈进 `<sandbox_data>` 数据区,尖括号换成 `‹›`。

失败码沿用 phone-control §3.4,另加:`no_sandbox`(没有在跑的沙箱,先 start)、`invalid_args`(不是绝对路径 / 没有 manifest.json /
manifest id 不合规或是商店身份 `market-*`)。

## 4. 状态(`contracts/pluginSandbox.ts` 的 `SandboxStatus`)

`{v:1, state, pluginId, name, version, dir, views, spaces, hiddenSpaces[{slug,reason}], setupError, blocked, mountErrors[{view,message}],
logs[{level,text}](最近 40 条), warnCount, errorCount, loads, windowVisible,
vault, activeSpace, notices[{level,text}](最近 8 条), dialog{kind,title}|null, filesArmed:'paths'|'cancel'|null}`(最后五个 11-03 起,老桌面不报 = 空值)

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
- **安装到我的 Forsion**:先在用户那份主窗弹确认框,再把插件目录拷进 `<forsionHome>/plugins/<id>`(先拷到旁边再换,不带
  `node_modules` / `.git` / `.forsion`;按真实目录拷,软链拷成实体;换的那一步失败就把旧的放回去);同一个插件已从商店装在别的目录名下就拒绝。
  同意绑在确认框里那个插件上:等用户点的工夫沙箱换了插件 / manifest 换了 id,就不装。装好广播 `extensions-changed`,各窗自己重载。

## 6. 不做(v1)

快照回滚、商店里「在沙箱里试」、多个插件同时开、云端沙箱、沙箱里起引擎(插件的引擎半身 / agent / 技能)、
能力级沙箱(收窄插件能用的宿主 API)。沙箱里的设置页也起不了整机共享的东西:对外 MCP、设备互联、托管引擎、写系统图标在入口处一律跳过。

## 7. 仪器

- 引擎:`src/tools/builtin/pluginSandbox.test.ts`、`src/tools/clientCapabilityGate.test.ts`(plugin.* 只给桌面);
- 桌面主进程:`desktop/electron/pluginSandbox.test.ts`(假子进程走真 socket:握手 / 令牌负对照 / 就地重载 / 闲置自动停 / 安装与同意绑定 /
  起停排队 / spawn 失败马上报);
- 子进程纯函数:`desktop/electron/sandboxChild.test.ts`(按键映射、files 路径门禁:软链 / `../` / 沙箱外);
- 真 Electron:`desktop` 的 `npm run check:pluginsandbox`(父进程 + 它真起的沙箱:claim 电文、主题色跟随、隔离、保存即重载、命令、报告问题、
  对话卡、setup 抛错、安装、停止与不留孤儿、负对照;11-03 起加:插件 Space 列出来并落在上面、Ribbon 没有内置 Space、没播种内置插件、
  read → type → click → press 拿到插件的 console 与提示且截图是新的、files + `<input type=file>`、沙箱外路径负对照、右栏卡运行 / 停止两态);
  `SHOT_DIR=<目录>` 落沙箱窗口、点完之后、对话卡、右栏卡截图;
- 真模型:live 台架 `--only pluginsandbox`(台架扮桌面应答 `plugin.*`,含无能力 / 手机端两个负对照;⑤ 在沙箱里 read → type → click 并转述点完冒出的报错)。
