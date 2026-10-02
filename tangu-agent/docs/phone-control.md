# 手机操控(Phone control)· 接缝契约

> 状态:MVP-1(T1 快通道)实现中。方案与取舍见 Forsion 仓根
> `docs/ToBeImproved/PokeClaw_安卓版地基评估_2026-09-25.md` 与实施计划。
> 本文件是**三层之间的唯一契约**:引擎(`tangu-agent`)、共享渲染层(`desktop/frontend`)、
> 移动端(`mobile/src` + `mobile/android`)。改线协议必须同时改本文件。

## 1. 分层与信任

```
model → phone_* 工具 (tangu-agent, builtin) → ctx.requestClientAction
  → services/clientAck.ts: publish 'client_cmd' {ackId, ns, body}
  → 网关 SSE → appStore case 'client_cmd'(G2 发起者 / G3 去重 / stopped:只是早筛)
  → clientSurfaces.get(ns).exec({runId, ackId, body})           (JS 不回执)
  → Capacitor PhoneControl.exec → 原生:校验 → claim → 分级 →(确认 → commit)→ 执行 → result
```

- **引擎的 pending 表是唯一权威**:原生没 claim 到 nonce 就绝不执行。重放、至少一次投递、
  worker 重启、JS 伪造,都在 claim 这一步 fail closed(410)。
- **token 与 apiBase 由原生自取**,绝不接受 JS 传入:token 读 SharedPreferences
  `CapacitorStorage` 的 `forsion_token`;apiBase 读 APK 内 `assets/public/forsion-native.json`
  (vite 构建时生成,与 `mobile/src/capacitorAuth.ts` 的 `apiBase()` 同一规则)。
- **开关在原生**:`setEnabled(true)` 必须经原生对话框确认,存原生自有 SharedPreferences
  `forsion_phone_control`;`exec` 先查它,关着回 `disabled`。JS 的开关 UI 只展示原生回报的状态。

## 2. 能力握手

- run 请求体字段 `client_capabilities: string[]`(`POST /agent/runs`)。
- 引擎消毒:数组、≤16 项、每项 `/^[a-z][a-z0-9-]{0,23}\.[a-z0-9-]{1,16}$/`、去重、排序 →
  `input.clientCapabilities`。不合法项静默丢弃。
- 已定义能力:`phone.intents`(T1)、`phone.ui`(T2,伴随包健康时才声明)。
- 工具闸(`toolRegistry.ts` 中央闸,default-deny):`ctx.client` 匹配 `^mobile/` **且**
  `ctx.clientCapabilities` 含该工具的 `clientCapability` **且** 非子代理 / 计划模式 / 通道会话 /
  讨论 **且** 工具名以 `<ns>_` 开头(`phone.intents` → `phone_`)。chat 预设按「带 clientCapability」
  放行,不看工具来源(内置与插件等价)。
- 请求通道按工具收窄(`toolRegistry.bindClientActionToTool`,由 `registry.executeTool` 每次调用套上):
  agentLoop 装配的 `ctx.requestClientAction` 是 run 级原件(只按本 run 的能力判 ns);工具执行时,
  **没声明 `clientCapability` 的工具拿到 undefined**,声明了的只能发自己能力的 ns(`phone.intents` → `phone`),
  别的 ns 立即 `undeclared`、不发事件。工具的 `isEnabledFor` 一律拿不到它。否则同 run 里任何插件工具都能
  直调 `requestClientAction({ns:'phone',…})` 绕过上面的中央闸。

## 3. 线协议

### 3.1 出向事件 `client_cmd`(事件名 ≤24 字符,`agent_run_events.type` 是 VARCHAR(24))

```json
{ "ackId": "cc_<ts36>_<seq>_<12 字符 base64url 随机>", "ns": "phone", "body": "<JSON 字符串>" }
```

`body` 解析后:

```json
{ "v": 1, "runId": "…", "sessionId": "…", "ackId": "cc_…", "ns": "phone",
  "op": "view", "args": { … }, "iat": 1790000000000, "target": { "kind": "origin" } }
```

原生必须校验:`v===1`、`body.runId===入参 runId`、`body.ackId===入参 ackId`、`ns==='phone'`、
`op` 在本机 verb 表内、`target.kind==='origin'`(远程驱动以后走另一条信任路径,老包不接)、`args` 缺省或为对象、
ackId 不在本机 LRU(256)。任何一条不符 → 不 claim、不执行、不回执。
参数层面的问题(缺字段、越界、危险 scheme)不在此列:照常 claim,再回 `invalid_args` / `refused`。

### 3.2 回程(借 inquiries 路由,前缀 `cc_`)

`POST {apiBase}/agent/runs/:runId/inquiries/:ackId`,头 `Authorization: Bearer <token>`。

| phase | 请求体 | 成功 | 失败 |
|---|---|---|---|
| `claim` | `{phase:'claim', digest, claimant}`,digest = body 的 UTF-8 字节 sha256 小写 hex;claimant 见下 | `200 {ok:true, nonce, execMs}` | `404` run 非本人;`410` 其余一切 |
| `commit` | `{phase:'commit', nonce}`(仅需确认的 op,在用户点确认后、执行前) | `200 {ok:true}` | `410`(已 abort / 超时 / nonce 错) |
| `result` | `{phase:'result', nonce, ok, code?, error?, text?, image?, app?, handoff?, verified?}` | `200 {ok:true}` | `410` |

- **引擎状态机**:`pending`(claimMs,缺省 15s,钳 3–30s)→ `claimed`(execMs,缺省 20s,钳 5–120s,
  claim 成功时重置计时)→ 兑现并删除。abort(run 级或工具级 signal)立即兑现并删除,码按状态分:
  pending 期 → `aborted`(之后的 claim 拿 410,协议保证什么都没做);claimed 期 → `aborted_claimed`
  (手机已领走,不需确认的 op 可能已执行完;需确认的 op 之后的 commit 拿 410 不会执行,但引擎分不清手机停在哪一步)。
- `claimant`:原生**每次 exec** 生成的随机 id,`/^[A-Za-z0-9_-]{16,64}$/`(如 16 字节随机数的 hex / base64url),
  只在这次 exec 的 claim 与它唯一一次重试之间复用;不落盘、不跨 exec、不进日志。带了但不合规 → 410。
- claim 对同 `(ackId, digest, claimant)` 在 claimed 期内**幂等**返回同一 nonce(网关丢响应时原生可重试一次);
  重复 claim 回的 `execMs` 是**剩余**时长且不重置计时(原生照常按 `收到响应时刻 + execMs` 记本地期限)。
  **重领只认首次 claim 的 claimant**(`timingSafeEqual`):另一个 claimant、或不带 claimant → 410。
  为什么:同账号两台手机都可能持有同一条 run 的 G2 归属(转向会追加归属),两台会各自 claim 同一条指令 ——
  digest 与 token 都相同,只比 digest 就会把同一枚 nonce 发给两台,两台都执行。
  首次 claim 不带 claimant 的老原生仍能领到,只是失去重领资格(丢响应后的重试 410 → 不执行 → 引擎按 `no_report` 兑现)。
  digest 不符、nonce 不符(`timingSafeEqual`)、runId 不符、已兑现 → 一律 410,不泄露存在与否。
- 原生重试:claim 与 result 遇网络错 / 5xx 各重试一次;410 即终局。
- 原生本地期限:记 `claimedAt + execMs`,`claimedAt` = **成功那次** claim 响应的到达时刻(不是第一次发出的时刻:
  重试拿到的是剩余时长,再从首发算起就把等待扣了两遍);execMs 只钳上界 120s、不钳下界(剩余可以合法地 < 5s)。
  确认框到期自动关闭并按 `declined` 回执;**迟到的确认永不执行**。主线程上的执行等待超时时,未开跑的任务必须撤掉,
  已开跑的等它跑完按真实结果回执 —— 绝不在回执失败之后迟到执行。
- 期限在**副作用前一刻**现查,不是只在开头查一次:commit 返回后查一次(commit 是阻塞请求,可能慢回),
  主线程里 `startActivity` / 写剪贴板之前、`setTorchMode` 之前再各查一次。过了期限 → 不执行、**不回执**
  (引擎按 `no_report` 兑现);期限内但 Forsion 已不在前台(确认之后按了 Home)→ `needs_foreground`。
- **claim 并发、执行串行**:原生为每条指令各开一个线程(池上限 8)去 claim,一条 R3 确认框挂着(最长 60s)
  不会让别的指令错过 claim 窗口;确认框 / 启动 Activity / 系统调用走一条执行道,一次只有一条,先领先做。
  排执行道排到本地期限还没轮到 → 什么都没做,立即回 `error`(文案写明「另一个操作在等用户,这条没来得及开始,
  什么都没做」),赶在引擎期限之前 —— 不能沉默,否则引擎会按 `no_report` 说「可能已经发生」。

### 3.3 结果消毒(引擎)

- `code`:`/^[a-z_]{1,32}$/`;`error` `sanitizeText(…, 500)`;`app` `sanitizeText(…, 80)`;
  `text` 保留 `\n\t`、剥其余控制字符与 bidi、≤48000;`image` 仅 `data:image/(jpeg|png);base64,…` ≤2.5MB;
  `handoff` / `verified` 布尔。

### 3.4 结果码

`ok` 以外:`disabled`(原生开关关)· `needs_foreground`(要启动 Activity 但 Forsion 不在前台)·
`no_handler`(没有 App 能处理)· `not_found`(按名字找不到 App)· `ambiguous`(名字多义,text 给候选)·
`busy`(排在另一条等用户确认的动作后面,轮到时已过本地期限;**什么都没做**)· `declined`(用户在确认框拒绝或超时)· `refused`(原生策略拒绝,如危险 scheme)· `invalid_args` ·
`unsupported`(本机/本版本不支持该 op)· `error`。

引擎自产(不经原生,`ClientActionResult.code` 同一正则):`undeclared`(本 run 没声明该 ns 的能力,或调用的工具没声明该 ns 的 `clientCapability`)·
`not_picked_up`(pending 超时:手机没 claim,**协议保证什么都没做**)· `no_report`(claimed 超时:领了没回,**可能已发生**)·
`aborted`(pending 期被 run 或工具信号中止,**协议保证什么都没做**)· `aborted_claimed`(claimed 期被中止,**可能已发生**)。
两对码的文案必须分开:「可能已发生」那两个(`no_report` / `aborted_claimed`)要让模型先请用户看一眼手机再重试,绝不能说「没做 / 什么都不会发生」。

## 4. T1 verb 表(原生 op,`phone.intents`)

| op | args | 分级 | 行为 |
|---|---|---|---|
| `launch` | `{pkg?, name?}` | R1 | LAUNCHER 解析;name 模糊匹配 label,多义回 `ambiguous`(≤8 个 `label (pkg)`) |
| `view` | `{candidates: string[]}`(≤6) | R1 / R3 | 逐个尝试。`https/http/geo` 先 resolveActivity:目标是浏览器或地图白名单包 → R1;否则按目标包 R3。地图自家导航 scheme(`amapuri/androidamap/baidumap/qqmap`)接手者全在地图白名单 → R1,否则 R3。其他 App scheme → R3。`intent:/android-app:/file:/content:/javascript:/data:` 以及 Forsion 自己的 `tangu:`(大小写不敏感)→ `refused`;任何一个候选命中即整条拒绝。解析到的接手者含 Forsion 自身(包名 = 本 App)→ `refused`(登录回跳无 state,自开深链 = 登录 CSRF) |
| `sendto` | `{uri: 'smsto:…'\|'mailto:…', text?, subject?}` | R2 | ACTION_SENDTO 草稿 |
| `dial` | `{number}` | R2 | ACTION_DIAL;号码只留 `[0-9+*#]`(引擎侧 phone_compose 更严,只发 `[0-9+]`:模型生成的号码不给 MMI/暗码口子) |
| `send` | `{text, subject?}` | R2 | ACTION_SEND + chooser(分享给任意 App) |
| `insert_event` | `{title, start, end?, location?, description?}`(ISO 8601) | R2 | CalendarContract INSERT 草稿 |
| `alarm` | `{hour, minute, days?: int[], label?}`,**`days` 取 1=周日 … 7=周六**(`java.util.Calendar`,即 `AlarmClock.EXTRA_DAYS` 的口径) | R1 | AlarmClock.ACTION_SET_ALARM + SKIP_UI(OEM 可能不尊重 → `verified:false`) |
| `timer` | `{seconds, label?}` | R1 | AlarmClock.ACTION_SET_TIMER |
| `settings` | `{page}`,闭集:`wifi\|bluetooth\|display\|sound\|battery\|location\|notifications\|app_details\|date\|language\|accessibility\|main` | R1 | Settings.ACTION_* |
| `media` | `{key: play_pause\|next\|previous}` | R1 | AudioManager.dispatchMediaKeyEvent(后台可用) |
| `volume` | `{dir: up\|down\|mute}` | R1 | adjustStreamVolume(后台可用) |
| `torch` | `{on: boolean}` | R1 | CameraManager.setTorchMode(后台可用) |
| `clip` | `{text}` | R1 | 写剪贴板(后台可用) |

- 启动 Activity 的 op(launch/view/sendto/dial/send/insert_event/alarm/timer/settings)要求 Forsion 在前台,
  否则 `needs_foreground`。开头查一次(早筛,不弹确认框),**主线程 `startActivity` 前一刻再查一次**
  (只查开头的话:后台启动要么被系统静默拦下、不抛异常而谎报 `handoff:true`,要么落在系统的宽限期里真把目标 App
  顶到用户眼前 —— 模拟器 API 35 实测后者:确认后按 Home,地图照样被拉起)。成功时 `handoff:true`、`app` = 目标 App 显示名。
- 包可见性(Android 11+):manifest `<queries>` 只声明要用的 Intent,不申请 `QUERY_ALL_PACKAGES`:LAUNCHER、
  VIEW `https` / `geo`、地图导航 scheme(`amapuri` / `androidamap` / `baidumap` / `qqmap` / `google.navigation`,
  与引擎 `phoneLinks.ts` 同步)、DIAL `tel`、SENDTO `smsto` / `mailto`、SEND `text/plain`。
  不在其中的 App scheme 解析不到接手者 → 该候选被跳过。
  `handoff:true` 且 `verified:false`(目前只有 alarm / timer:SKIP_UI 生效时 Forsion 仍在前台,原生分不清)=
  **不确定的交接**:引擎给模型的尾句只说「可能切走了,切走了下一个开 App 的动作会回 `needs_foreground`」,不叫模型收尾。
- R3 确认框:原生构造,文案模板来自 `configure` 且**必须含 `{app}` 与 `{target}` 占位符**,
  由原生填入 `resolveActivity` 得到的 App label 与 `scheme://host`。缺占位符的模板拒收。

## 5. 渲染层 surface API(`desktop/frontend/src/services/clientSurfaces.ts`)

```ts
registerClientSurface(ns: string, s: {
  capabilities(): string[]                         // 同步;移动端读原生 status 的缓存
  exec(req: { runId: string; ackId: string; body: string }): void | Promise<void>
  onRunEnd?(runId: string): void                   // 尽力而为
  onReset?(): void                                 // 登出 / 鉴权重置(不走 endRun 的路径)
  SettingsRow?: React.ComponentType                // 设置 → 高级 页里渲染
}): () => void
collectClientCapabilities(): string[]              // startRun body 用;desktop/web 为 []
```

## 6. 原生插件 API(`Capacitor.Plugins.PhoneControl`)

| 方法 | 入参 | 返回 |
|---|---|---|
| `status` | — | `{enabled, capabilities: string[], foreground: boolean, proto: 1}` |
| `setEnabled` | `{enabled}` | `{enabled}`(开启需原生确认框;用户拒绝返回 `enabled:false`) |
| `configure` | `{strings: Record<string,string>}` | `{}` |
| `exec` | `{runId, ackId, body}` | 立即 resolve `{accepted: boolean}`;执行与回执在原生线程异步完成 |

`configure.strings` 键:`enableTitle`、`enableBody`、`enableConfirm`、`cancel`、`confirmTitle`、
`confirmBody`(含 `{app}` `{target}`)、`confirmAllow`、`confirmDeny`。

## 7. 后台存活(依赖灵动岛前台服务)

执行链路要求 Forsion 在后台时 WebView 仍能收 SSE、原生仍能发 claim。**唯一保证它的是灵动岛的
dataSync 前台服务**(`LiveIslandService`,有 run 在跑时由 `mobile/src/liveIsland.ts` 无条件拉起)——
它若被删或改成可关,手机操控在后台会整条静默失效。模拟器实测(2026-09-26,API 35,Clock 在前台 300s,
每 10s 一条):无前台服务 1/30 送达(进程被冻结);有前台服务 30/30,p50 20ms / p95 34ms。
仪器 `node mobile/scripts/phone-control-emu.cjs soak 300 [island]`。国产 ROM 的冻结器未实测。

## 8. 仪器

- 引擎单测:`tangu-agent/src/services/clientAck.test.ts`、`src/tools/builtin/phoneTools.test.ts`、闸矩阵测试。
- live:`cd tangu-agent && npm run build && npm run live:harness -- --only phone --exec-mode sandbox`。
- 模拟器:`mobile/scripts/phone-control-emu.cjs`(AVD + CDP + 假引擎)。含 commit 慢回过期、确认后按 Home、
  确认框挂着时另一条指令的 claim / 排队 / 排队超期(假引擎的 `commitDelayMs` 旋钮)。
