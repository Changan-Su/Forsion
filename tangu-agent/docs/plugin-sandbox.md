# 插件沙箱(Plugin Sandbox)· 接缝契约

> 状态:v1(2026-10-23,方案 A)。方案页与取舍见 Forsion 仓根 `docs/ToBeImproved/插件沙箱方案_2026-10-23/`。
> 本文件是引擎(`tangu-agent`)、桌面渲染层(`desktop/frontend`)、桌面主进程(`desktop/electron`)三方的唯一契约。
> 线协议沿用 [phone-control.md](phone-control.md) 的 `client_cmd`(§3),这里只写插件沙箱自己的部分。

## 1. 是什么

agent 开发插件时没有验证环境、用户也没有试用环境,只能直接装进用户的 Forsion。插件沙箱 = 桌面宿主**按需另起的一份
Forsion 进程**,只装这一个插件的开发副本:

- 自己的 `--user-data-dir`、`TANGU_HOME`、工作区、智库,全在 `<forsionHome>/sandbox/<插件 id>/{userdata,home,workspace,vault}`;
- 不登录(home 里没有 auth.json)、引擎地址指向死端口(`TANGU_BACKEND_URL=http://127.0.0.1:1`,不起引擎)、不连电脑操作助手;
- 不碰整机共享的东西:协议注册、托盘、全局快捷键、CLI、MCP 固定端口、更新检查、自动 Mini;关窗即退出;
- 插件以开发副本加载(`amadeus/ipc.ts` 的 `readDevPlugins`,来源 = `FORSION_SANDBOX_PLUGIN`),监视插件目录,保存即重载;
- 跟随用户那份的界面语言与主题(起沙箱时带过去),跳过首启引导和开屏;
- 同一时刻只有一个沙箱;沙箱窗口不在前台、15 分钟没人用就自动停。

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
  第一行 `{hello: token}`,不对就断。之后按行 JSON:父 → 子 `{id, op, args}`(`status / screenshot / command / reload / show / quit`),
  子 → 父 `{id, ...}` 应答或事件 `{event: 'state' | 'report' | 'install' | 'reset' | 'forward'}`。不开远程调试端口。
  控制通道一断(父进程退出 / 崩溃),沙箱跟着退。

## 3. 工具

| 工具 | 动作 | 审批 | 说明 |
|---|---|---|---|
| `plugin_sandbox` | `start {path}` / `stop` / `reset` | `approval: 'command'`(与 run_bash 同档) | start 的相对路径按会话工作目录解析;同一个插件再 start = 就地重载,另一个插件 = 先停前一个。reset = 清空沙箱目录后重起 |
| `plugin_sandbox_inspect` | `status` / `screenshot {view?}` / `logs` / `command {command, args?}` | 无 | 只读状态,或在沙箱里跑插件自己注册的命令(参数原样交给 `run(args)`) |

start / reset 的结果末尾挂 `<sandbox-status>{JSON}</sandbox-status>`(尖括号转义),对话卡据此画历史状态。
插件自己说的话(名字、console、报错、视图名)进模型前圈进 `<sandbox_data>` 数据区,尖括号换成 `‹›`。

失败码沿用 phone-control §3.4,另加:`no_sandbox`(没有在跑的沙箱,先 start)、`invalid_args`(不是绝对路径 / 没有 manifest.json /
manifest id 不合规或是商店身份 `market-*`)。

## 4. 状态(`contracts/pluginSandbox.ts` 的 `SandboxStatus`)

`{v:1, state, pluginId, name, version, dir, views, spaces, hiddenSpaces[{slug,reason}], setupError, blocked, mountErrors[{view,message}],
logs[{level,text}](最近 40 条), warnCount, errorCount, loads, windowVisible}`

- `state`:`starting`(插件宿主还没装载落定)/ `running` / `failed`(setup 抛错或没列出来)/ `blocked`(宿主拒载)/ `stopped`;
- `loads`:自启动以来装载了几次(保存即重载会累加);
- `windowVisible`:用户此刻正在用沙箱窗口(它在前台)。窗口平时压在普通窗口之下,看得见不算;闲置判定靠它。

引擎与卡片都过 `parseSandboxStatus`(不像状态就 null,超长截断)。

## 5. 界面

- **对话卡**(`frontend/src/sandbox/PluginSandboxCard.tsx`,任务卡一族):plugin_sandbox start / reset 成功后替掉那行工具调用。
  头:「沙箱:名字 版本」+ 状态签 + 「隔离数据 · 未登录」;事实行(视图 / 隐藏的 Space / 报错 / 控制台计数);
  按钮:打开沙箱窗口 / 重置数据 / 安装到我的 Forsion,沙箱停了换成「重新启动」。手机 / 网页只读,提示到电脑上打开。
- **沙箱窗口**(`frontend/src/sandbox/SandboxChrome.tsx`):标题栏右侧「沙箱 · 名字 版本」胶囊 + 重置 / 报告问题 / 安装到我的 Forsion,
  首次打开垂一条说明。按钮只把意图交给父进程:报告问题 → 回到发起沙箱的那个对话,话放进输入框(用户自己决定发不发)。
- **Coding Studio Sandbox 面板**:两档,隔离沙箱(缺省)/ 我的 Forsion(原来的开发加载器,原样保留)。
- **安装到我的 Forsion**:先在用户那份主窗弹确认框,再把插件目录拷进 `<forsionHome>/plugins/<id>`(先拷到旁边再换,不带
  `node_modules` / `.git` / `.forsion`);同一个插件已从商店装在别的目录名下就拒绝。装好广播 `extensions-changed`,各窗自己重载。

## 6. 不做(v1)

快照回滚、商店里「在沙箱里试」、多个插件同时开、云端沙箱、沙箱里起引擎(插件的引擎半身 / agent / 技能)。

## 7. 仪器

- 引擎:`src/tools/builtin/pluginSandbox.test.ts`、`src/tools/clientCapabilityGate.test.ts`(plugin.* 只给桌面);
- 桌面主进程:`desktop/electron/pluginSandbox.test.ts`(假子进程走真 socket:握手 / 令牌负对照 / 就地重载 / 闲置自动停 / 安装);
- 真 Electron:`desktop` 的 `npm run check:pluginsandbox`(父进程 + 它真起的沙箱:claim 电文、隔离、保存即重载、命令、报告问题、
  对话卡、setup 抛错、安装、停止与不留孤儿、负对照);`SHOT_DIR=<目录>` 落沙箱窗口与对话卡截图;
- 真模型:live 台架 `--only pluginsandbox`(台架扮桌面应答 `plugin.*`,含无能力 / 手机端两个负对照)。
