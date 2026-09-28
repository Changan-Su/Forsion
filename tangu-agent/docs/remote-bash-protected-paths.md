# 远程会话经 `run_bash` 写保护路径(宿主沙箱关)· 评估

> 设备能力方案 §6.8 残余风险「保护路径被 `run_bash` 写(沙箱关):远程污点 run 对保护路径另开宿主沙箱写保护(P1 评估)」。P1 · K10b(INTEGRATION §4 G5),2026-09-28。执行路径未改;评审发现的零审批链(R5)已在本包的审批闸里堵上。

**TL;DR (English).** A remote-tainted run cannot write protected paths with the structured write tools. The same write through a shell, with the host sandbox off (the default), is limited only by the approval gate. Until this package it took **zero** approvals: the run could plant a git directory in its workspace with approval-free `write_file` calls, set `core.fsmonitor` in that directory's config, and run `git status`, which was classified known-safe. Git then ran the planted command, which raised `remote.maxApprovalMode` to `full-auto`. This package closes that path in the gate: known-safe `git` now only trusts repository discovery that lands on a protected `.git` (R5). Escalation now costs one approval, and the card may still read like a harmless command (`git status` in a planted directory, `python3 fix.py`, `npm install`). After that approval, remote runs execute shell commands with no approval at all. Recommendation: a per-run Seatbelt write-deny profile for remote-tainted shell processes on macOS, shipped as its own package right after K2. Accept the gap on Linux and Windows for now, and say so plainly. Do not deny `run_bash` for remote runs.

## 现状(证据)

结构化写工具走 `protectedRemoteWrite`,对远程污点 run 硬拒,不进审批。这道检查只看 `writeTargetsOf`,也就是 `write_file` / `edit_file` / `multi_edit` / `apply_patch` 四个工具。`run_bash` 在远程 run 里只被当成「跑命令」,审批理由是 `mode`。K3 只给 `reason.kind === 'protected'` 的审批卡打本机专属(`localOnly`),所以这张卡在手机上就能批。宿主沙箱关时,`spawnHostShell` 等于 `spawn(command, { shell: true })`,只剥掉凭据环境变量,对写入没有任何限制。远程会话最高审批档存在共享域 `config.json` 的 `remote.maxApprovalMode` 里(K4 写入,见 `desktop/electron/remoteSessions.ts:7`),引擎每次工具调用都现读(`remoteOrigin.ts` 的 `remoteApprovalCap`)。

`isKnownSafeBash` 的字符过滤不放行 `>`、引号和替换,命令本身写不了文件。但 known-safe 里的 `git status` / `log` / `diff` / `show` / `rev-parse` / `describe` 会读**仓库发现落到的那个 git 目录**的 config,而 config 可以让 git 执行任意命令(`core.fsmonitor`)。git 的发现在每一级先看 `D/.git`,再看 `D` 自己像不像 git 目录(HEAD + `objects/` + `refs/`)。后一种布局不含 `.git` 段,远程 run 在 auto-edit 下用 `write_file` 就能在工作区里摆出来,每一步都免审批。本包之前,这条链**一张审批卡都不用**(R5)。评审在本工作树上用真 `gateToolCall` 与 `spawnHostShell` 复现过,Apple Git 2.50.1。本机 auto-edit run 若被网页或文件内容注入,也会走同一条链,只是改的不是远程上限档,而是以用户身份执行任意命令。

本包把 known-safe `git` 收紧为:对每个 git 子命令(含 `branch` / `remote` 的列表形态;探针里只有 `status` 触发了 fsmonitor,但 `log.showSignature` 加 `gpg.program` 这类只看 config 的执行点不止一个,不逐个论证),按 git 的发现顺序走一遍 cwd 的字面路径链与真实路径链,只有落在一个 `.git` 目录(内含 HEAD)上,或落在指向带 `.git` 段路径的 `gitdir:` 文件(worktree、submodule)上,才免审批。结构化写对 `.git` 段一律硬拒(`fsPolicy.isProtected`),所以这两种 git 目录里的 config 模型改不了。途中遇到含 `HEAD` 的目录、`--separate-git-dir` 指向普通目录、环境里设了 `GIT_DIR`、字面链与真实路径链结论不一,一律要审批。两条链一路到根都没有 `.git` 也没有 `HEAD` 时(不在任何仓库里),git 不读任何仓库的 config,只会报「不是 git 仓库」,所以无参数的读照旧免审批,Tangu 默认文件夹里开局的 `git status` 不会平白多一张卡。这是分类器的收紧,不是边界:它把「经 shell 提权至少要一张卡」这个前提补回来,但卡上的文字依然可能看不出后果。

钉住现状的测试是 `test/remoteBashProtectedResidual.test.ts`,形态照桌面托管搭建:`TANGU_HOME=<tmp>/tangu`,共享域为 `<tmp>`。本机那一半在 `test/knownSafeGitDiscovery.test.ts`。R5 与后者是回归钉,必须一直绿;等缓解落地,要有意识翻过来的只有 R2 与 R3。

| # | 做了什么 | 结果 |
|---|---|---|
| R1 | 远程 run 用 `write_file` 写 `config.json` | 硬拒,不出审批卡 |
| R2 | 同一次写换成 `run_bash`(`printf … > config.json`) | 出审批卡:`reason={kind:'mode'}`,**没有** `localOnly`;手机以隧道身份批准后闸门放行 |
| R3 | 批下来后在宿主沙箱关的执行路径上跑 | 退出码 0,`config.json` 被改写,`remoteApprovalCap()` 变成 `full-auto`。改写前,远端起 run 要 `full-auto` 会被钳到 `auto-edit`,`run_bash` 仍要批;改写后不再被钳,`run_bash` 直接放行、不出审批卡 |
| R4 | 同一条命令放进宿主沙箱 `workspace-write`(Seatbelt)跑 | 写不进 `config.json`,上限档不变;工作区照常可写。原因是 `protectedHostPaths()` 已含 `configFile()` |
| R5 | 远程 run 用 `write_file` 在工作区摆出 HEAD / config / `objects/` / `refs/`,config 里 `core.fsmonitor` = 把 payload 拷到 `config.json`,再跑 `git status`。两种布局:工作区根本身(工作区没有 `.git`,如 Tangu 默认文件夹),以及真仓库里的子目录被设成会话 cwd(`remoteCwdForbidden` 放行) | 摆放的五次写入都免审批。**修复前** `git status` 也免审批,零张卡就把上限档抬到 `full-auto`(负对照实跑为红)。**修复后** `git status` 出审批卡(`reason=mode`,手机可批);批了以后 git 仍会执行 fsmonitor、上限档仍被抬高,卡上却只写着 `git status`。同一真仓库的根目录照旧免审批 |

改写对象不限于上限档。K4 的 `userData/remote-sessions.json`(开关与信任列表)、将来 K2 的 `remote-lock.json`(急停锁)、hooks、插件、技能,以及 Agent 的 `config.toml`,只要进程能写到,都可以用同样的方式改掉。它们都属于方案 §6.1 的「执行设备专属」一类,或 §6.3 列出的保护路径。审批卡不是可靠的信号:`printf … > ~/.forsion/config.json` 这样直白的命令,人还有机会看出来;换成摆好目录后的 `git status`、`python3 fix.py`、带 postinstall 脚本的 `npm install`,手机上看不出后果。远程上限档设为 `full-auto` 时这一步本来就不经审批(§6.4 已如实写明)。

以下为 macOS 26.3 上的系统层探针,本机临时目录现场跑过,没有写入任何仓库:

- 拒写名单式 profile `(version 1)(allow default)(deny file-write* (subpath P))`:写 P 内文件、把它 `mv` 出去、`rm -rf` 它所在目录,都报 `Operation not permitted`;同一 profile 下写工作区、`git init` + `commit` 都正常。
- 嵌套沙箱:在该 profile 里再调 `sandbox-exec` 报 `sandbox_apply: Operation not permitted`(exit 71)。`swift package dump-package` 因此失败(SwiftPM 编译 manifest 会自己开沙箱);加 `--disable-sandbox` 后通过。
- 经 cfprefsd 中转的写入:`defaults write P/probe k v` 被拒(对照:写进允许的目录成功)。这说明按路径指定的 domain 会遵守调用方的沙箱。标准 domain、`launchctl`、`crontab`、登录项都没有探,因为会改动本机真实状态,见下文「A 仍挡不住的」。
- 开销:`/bin/sh -c true` 裸跑 7.1 ms/次,套上 `sandbox-exec` 后 19.2 ms/次,每次多 12 ms,取 50 次平均。

## 选项

| 方案 | 做法 | 代价 | 风险 / 副作用 |
|---|---|---|---|
| **A · 远程污点 shell 套写入拒绝 profile** | 宿主沙箱为 `off` 且 `effectiveRemote(ctx)` 时,`prepareHostCommand` 用 `(allow default)` 加一组 `deny file-write*` 包住 `run_bash` / `run_background`,名单即 §6.3 的保护路径。可直接复用 `hostSandboxProtection` 的四张表:`protectedHostPaths`、`credentialPaths`、`forsionConfigPaths`、`remoteForbiddenRoot` 的根(含 userData 整片)。Agent Library 例外用后写的 `allow` 规则实现,Library 内的 `.tangu` 再单独拒;家目录启动项(`~/.zshrc`、`~/.config`、`~/Library/LaunchAgents`)与 `.agents` / `.codex` 用 regex 表达。本机 run 完全不受影响 | macOS 约 1–1.5 人日:生成 profile、接进 `prepareHostCommand`、`processRegistry` 的作用域键、翻转 R2/R3、补 Seatbelt 用例,再跑 `live:harness --only remoteclamp,tool`。Linux 另需 0.5–1 人日:bwrap `--bind / /` 加 `--ro-bind`,缺失的路径保护不了,要先建出来或拒绝执行。Windows 没有后端 | ① 远程 run 里自己开沙箱的工具会直接失败,如 SwiftPM、部分 Homebrew 源码构建、Bazel darwin-sandbox、在 `run_bash` 里跑 Codex CLI,要在工具结果里附上提示(例如「加 `--disable-sandbox`」)。② 被拒的写入在模型那里表现为 EPERM,可能换别的写法重试,但结果同样被拒。③ 每次起进程多约 12 ms。④ `sandbox-exec` 已被 Apple 标记弃用,但 26.3 仍随系统提供,Codex 与 Claude Code 都在用。⑤ 跑在引擎外的长寿进程不在覆盖范围内,例如 MCP 服务器,它们照旧走审批 |
| **B · 沙箱关时远程 run 禁用 `run_bash`** | 远程污点 run 在 `hostSandbox=off` 时拒绝 `run_bash` / `run_background` / `write_process_input` | 约 0.25 人日 | 缺省安装(沙箱关)下 M1 退出标准「带 `run_bash` 的任务在手机上批审批」直接不成立;等于推翻 09-27 按 D1 撤掉的「宿主沙箱强制」。用户要恢复只能打开 `workspace-write`,而它会对**所有** run 停用 hooks、MCP、插件与委派,并默认断网。只适合做 D8 严格档下的可选项 |
| **C · 接受** | 维持现状,在设置页与 CHANGELOG 写明:手机上批准的命令能改本机的 Forsion 配置,包括远程上限档。现在就想挡住的用户可以打开宿主沙箱 `workspace-write`(R4) | 几乎为零 | R3 这条提权链一直存在,而且只需**一次**看起来无害的批准(摆好目录后的 `git status`、`python3 fix.py`):批准后远程上限档被永久抬高,信任列表可改,hook 与插件可埋,之后的本机 run 同样受影响。本包之前连这一次批准都不用(R5,已堵) |
| D · 按命令文本打本机专属 | 远程 run 的 `run_bash` 命令文本里出现保护路径时,把审批理由记为 `protected`,卡片变成只能在本机批 | 约 0.5 人日 | 靠文本识别 shell,不构成边界:脚本、变量、编码都能绕过,R5 的 `git status` 文本里根本没有路径;读操作(`cat ~/.zshrc`)会被误标。只能拦住模型被 `write_file` 拒绝后改用 `sed -i` 重试这种直白情形,而 A 本来就能盖住这一类 |

## A 仍挡不住的

A 只限制**文件写入**,以下这些不在覆盖范围内:读凭据(仍由审批把关,§6.8「shell 读凭据」);联网外发;经系统守护进程落地的持久化,例如 `launchctl submit` / `bootstrap`、`crontab`、System Events 登录项、Keychain 写入;以及不在名单里的路径。它堵住的是「远程 run 借 shell 改掉限制自己的那几份配置」这一类,也就是 §6.1 与 §6.3 要求只能在本机改的东西。对手握任意代码执行能力的攻击者,它不构成隔离。那种情况对应的是 forsion_token 泄露那一行,缓解靠的是新调用方首次须本机确认(K4)与急停(K2)。

R5 这类「命令文字无害、真正执行的是工作区里摆好的东西」的链,A 能挡住它对保护路径的写入,原因只是 A 包住**每一个**远程污点 shell,git 起的 fsmonitor 子进程继承同一个 Seatbelt profile。A 不看命令文字,所以对 `git status`、`python3 fix.py`、`npm install` 一视同仁。本机 run 不在 A 的范围内:本机 auto-edit run 被注入后,同样能摆出 git 目录、再请求批准 `git status`。本包的 known-safe 收紧让这一步必须出卡,但批不批取决于人能否看穿一条看似无害的命令,这不是边界。本机那一侧要真正挡住,只能打开宿主沙箱 `workspace-write`。

## 建议

1. **不做 B。** 它与 D1 冲突,也会让 M1 的退出标准不成立。
2. **known-safe `git` 的收紧随本包落地(已做)。** 改动局限在审批闸的分类器,只会让更多命令出卡,不会让任何命令少出卡;worktree 与 submodule 照旧免审批。它把 C 的前提从「零张卡」拉回「一张卡」,但不能代替 A。
3. **做 A,只做 macOS,作为 K2 合入后的第一个独立小包,不塞进 K10b。** R5 说明审批卡上的命令文字不是可靠信号,而手机上批卡正是 M1 的主路径,所以能按真实路径拦写入的只剩内核这一层。排在 K2 之后,`remote-lock.json` 从第一天起就在名单里。取舍理由:改动局限在执行入口,本机 run 零影响;由内核按真实路径判定,软链、改名、间接执行都绕不过去,比文本检查可靠;还能让 `full-auto` 上限下的远程 run 也改不了保护路径,补上 §6.3「远程一律硬拒」在 shell 这条路上的缺口。代价是自带沙箱的工具需要显式关掉自己的沙箱,落地时必须把失败提示做清楚,并在 live 台架里跑一次 SwiftPM 或同类任务。
4. **Linux 与 Windows 暂按 C 处理。** 在设置页的远程会话说明与 CHANGELOG 里如实写明:在手机上批准的命令能改这台电脑上的 Forsion 设置,包括远程会话的上限档,而命令文字未必看得出来;打开 `workspace-write` 即可挡住。Linux 的 bwrap 版等 A 在 macOS 上跑稳后再评估。
5. D 不单独做。

本轮落地三样:known-safe `git` 的收紧(`src/services/approvals.ts`),现状与回归测试(`test/remoteBashProtectedResidual.test.ts` R1–R5、`test/knownSafeGitDiscovery.test.ts`),以及这份评估。执行路径与工具定义没有改动。审批闸改了,因此跑了 live 台架的 `tool`、`remoteclamp`、`remotemgmt` 三个子集,结果见交付报告。
