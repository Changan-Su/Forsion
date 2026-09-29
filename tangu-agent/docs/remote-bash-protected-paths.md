# 远程会话经 `run_bash` 写保护路径(宿主沙箱关)· 评估

> 设备能力方案 §6.8 残余风险「保护路径被 `run_bash` 写(沙箱关):远程污点 run 对保护路径另开宿主沙箱写保护(P1 评估)」。P1 · K10b(INTEGRATION §4 G5),2026-09-28。执行路径未改;评审发现的零审批链(R5)已在本包的审批闸里堵上。**同日 P1 · G5 落地方案 A(macOS),Linux / Windows 按 C 如实告知,见文末「落地」;git filter 的本机一半随后按方案 B 收口,见文末「方案 B」。**

**TL;DR (English).** A remote-tainted run cannot write protected paths with the structured write tools. The same write through a shell, with the host sandbox off (the default), is limited only by the approval gate. Until this package it took **zero** approvals: the run could plant a git directory in its workspace with approval-free `write_file` calls, set `core.fsmonitor` in that directory's config, and run `git status`, which was classified known-safe. Git then ran the planted command, which raised `remote.maxApprovalMode` to `full-auto`. This package closes that path in the gate: known-safe `git` now only trusts repository discovery that lands on a protected `.git` (R5). Escalation now costs one approval, and the card may still read like a harmless command (`git status` in a planted directory, `python3 fix.py`, `npm install`). After that approval, remote runs execute shell commands with no approval at all. Recommendation: a per-run Seatbelt write-deny profile for remote-tainted shell processes on macOS, shipped as its own package right after K2. Accept the gap on Linux and Windows for now, and say so plainly. Do not deny `run_bash` for remote runs.

**Outcome (P1 G5, 2026-09-28).** Option A shipped for macOS. With the host sandbox off, every shell command a remote-tainted run starts (`run_bash`, `run_background`; a run tainted mid-run by a steer is checked per command) runs under `sandbox-exec` with an `(allow default)` profile that denies writes to the §6.3 set, built from the same tables as `protectedRemoteWrite`. R3 and the execution step of R5 are flipped on darwin (config.json unchanged, cap unchanged); a local run is byte-for-byte unchanged. `sandbox-exec` missing or a profile that cannot be rendered refuses the command. Cost is about 9 ms per command. Two deliberate differences from the structured write rules: `.git` stays writable (commit, init, clone), and inside existing home dot folders writes are allowed (only top-level dot entries, `~/.config`, `~/.local/bin` and `~/Library/LaunchAgents` are denied). The first of these left a gap found in review: a remote command can plant a git clean filter in the workspace repo, and the engine's own git state collection at the start of the next run executes it. For remote-tainted runs that collection now gets the same wrapper (`agentLoop` passes `remote` and `runId` to `collectGitState`), so the filter runs but cannot write the protected set; with `sandbox-exec` missing the git state is skipped rather than collected unwrapped. Local runs and the project details panel still ran the planted filter as the user; that half was pinned by a test and left as a decision item. Linux and Windows: option C (settings copy and CHANGELOG).

**Outcome (P1 G5 option B, 2026-09-28).** The local half is closed. On macOS with the host sandbox off, every git process the engine starts itself (run-start git state, project details panel) runs under the same write-deny profile regardless of taint, and so does a `git` read that the gate lets through as known-safe (no card was shown); a command the user approved on a card still runs unwrapped. `sandbox-exec` missing means the engine's git is skipped and known-safe `git` needs a card. On every platform, known-safe `git` is revoked when the repository's own config (including checked-out submodules and unregistered nested repos, found through the index's gitlinks) configures a program git may run: filters, fsmonitor, a `post-index-change` hook or `core.hooksPath`, external diff / textconv, pager, gpg, ssh, credential helpers, `!` aliases, includes, git-lfs's own program keys (`lfs.extension.*.clean|smudge`, `lfs.customtransfer.*`, `lfs.standaloneTransferAgent`, which git-lfs reads from the repository config even though the `filter.lfs` that starts it lives in the global config) and a few more. Config is read with `git config --no-includes --file`, never by running git in the repository. Linux and Windows have no Seatbelt, so the engine's git is skipped when the repository configures a program its fixed `-c` prefix cannot neutralize (filters, includes, git-lfs program keys). What is closed is the write to the protected set; the planted filter still runs as the user on macOS (reads, network and non-protected writes are untouched), exactly as for any approved remote command.

## 现状(证据)

结构化写工具走 `protectedRemoteWrite`,对远程污点 run 硬拒,不进审批。这道检查只看 `writeTargetsOf`,也就是 `write_file` / `edit_file` / `multi_edit` / `apply_patch` 四个工具。`run_bash` 在远程 run 里只被当成「跑命令」,审批理由是 `mode`。K3 只给 `reason.kind === 'protected'` 的审批卡打本机专属(`localOnly`),所以这张卡在手机上就能批。宿主沙箱关时,`spawnHostShell` 等于 `spawn(command, { shell: true })`,只剥掉凭据环境变量,对写入没有任何限制。远程会话最高审批档存在共享域 `config.json` 的 `remote.maxApprovalMode` 里(K4 写入,见 `desktop/electron/remoteSessions.ts:7`),引擎每次工具调用都现读(`remoteOrigin.ts` 的 `remoteApprovalCap`)。

`isKnownSafeBash` 的字符过滤不放行 `>`、引号和替换,命令本身写不了文件。但 known-safe 里的 `git status` / `log` / `diff` / `show` / `rev-parse` / `describe` 会读**仓库发现落到的那个 git 目录**的 config,而 config 可以让 git 执行任意命令(`core.fsmonitor`)。git 的发现在每一级先看 `D/.git`,再看 `D` 自己像不像 git 目录(HEAD + `objects/` + `refs/`)。后一种布局不含 `.git` 段,远程 run 在 auto-edit 下用 `write_file` 就能在工作区里摆出来,每一步都免审批。本包之前,这条链**一张审批卡都不用**(R5)。评审在本工作树上用真 `gateToolCall` 与 `spawnHostShell` 复现过,Apple Git 2.50.1。本机 auto-edit run 若被网页或文件内容注入,也会走同一条链,只是改的不是远程上限档,而是以用户身份执行任意命令。

本包把 known-safe `git` 收紧为:对每个 git 子命令(含 `branch` / `remote` 的列表形态;探针里只有 `status` 触发了 fsmonitor,但 `log.showSignature` 加 `gpg.program` 这类只看 config 的执行点不止一个,不逐个论证),按 git 的发现顺序走一遍 cwd 的字面路径链与真实路径链,只有落在一个 `.git` 目录(内含 HEAD)上,或落在指向带 `.git` 段路径的 `gitdir:` 文件(worktree、submodule)上,才免审批。结构化写对 `.git` 段一律硬拒(`fsPolicy.isProtected`),所以这两种 git 目录里的 config 模型改不了。途中遇到含 `HEAD` 的目录、`--separate-git-dir` 指向普通目录、环境里设了 `GIT_DIR`、字面链与真实路径链结论不一,一律要审批。两条链一路到根都没有 `.git` 也没有 `HEAD` 时(不在任何仓库里),git 不读任何仓库的 config,只会报「不是 git 仓库」,所以无参数的读照旧免审批,Tangu 默认文件夹里开局的 `git status` 不会平白多一张卡。这是分类器的收紧,不是边界:它把「经 shell 提权至少要一张卡」这个前提补回来,但卡上的文字依然可能看不出后果。

钉住现状的测试是 `test/remoteBashProtectedResidual.test.ts`,形态照桌面托管搭建:`TANGU_HOME=<tmp>/tangu`,共享域为 `<tmp>`。本机那一半在 `test/knownSafeGitDiscovery.test.ts`。R5 与后者是回归钉,必须一直绿;等缓解落地,要有意识翻过来的只有 R2 与 R3。

| # | 做了什么 | 结果 |
|---|---|---|
| R1 | 远程 run 用 `write_file` 写 `config.json` | 硬拒,不出审批卡 |
| R2 | 同一次写换成 `run_bash`(`printf … > config.json`) | 出审批卡:`reason={kind:'mode'}`,**没有** `localOnly`;手机以隧道身份批准后闸门放行 |
| R3 | 批下来后在宿主沙箱关的执行路径上跑 | 退出码 0,`config.json` 被改写,`remoteApprovalCap()` 变成 `full-auto`。改写前,远端起 run 要 `full-auto` 会被钳到 `auto-edit`,`run_bash` 仍要批;改写后不再被钳,`run_bash` 直接放行、不出审批卡。**G5 之后(macOS)**:带远程污点执行 → `Operation not permitted`,文件与上限档都不变(本机 run 照写,作对照组);非 darwin 跳过 |
| R4 | 同一条命令放进宿主沙箱 `workspace-write`(Seatbelt)跑 | 写不进 `config.json`,上限档不变;工作区照常可写。原因是 `protectedHostPaths()` 已含 `configFile()` |
| R5 | 远程 run 用 `write_file` 在工作区摆出 HEAD / config / `objects/` / `refs/`,config 里 `core.fsmonitor` = 把 payload 拷到 `config.json`,再跑 `git status`。两种布局:工作区根本身(工作区没有 `.git`,如 Tangu 默认文件夹),以及真仓库里的子目录被设成会话 cwd(`remoteCwdForbidden` 放行) | 摆放的五次写入都免审批。**修复前** `git status` 也免审批,零张卡就把上限档抬到 `full-auto`(负对照实跑为红)。**修复后** `git status` 出审批卡(`reason=mode`,手机可批);批了以后 git 仍会执行 fsmonitor、上限档仍被抬高,卡上却只写着 `git status`。同一真仓库的根目录照旧免审批。**G5 之后(macOS)**:带远程污点执行时 fsmonitor 子进程继承同一个写拒绝 profile,拷不进 `config.json`;不带远程污点的执行照旧跑 payload(链本身是真的) |

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

## 落地(P1 · G5,2026-09-28)

分支 `feat/p1-g5-remote-shell-seatbelt`。按建议 3、4 做了 A(只 macOS)与 C(Linux / Windows),审批闸与工具定义都没改。

**接缝。** `sandbox/hostSandbox.ts` 的 `remoteShellSeatbeltApplies(ctx)` = darwin ∧ 宿主沙箱 `off` ∧ `effectiveRemote(ctx)`,每条命令现算,所以 run 中途被远端 steer 染上的,下一条命令就套上。`prepareHostCommand` 在这种情况下返回 `sandbox-exec -p <profile> -- …`,环境仍是 `toolSubprocessEnv()`(与本机 run 相同,这一层只管写);`spawnHostShell` 把远程那条也导到 `/bin/sh -c`,与 Node 在 darwin 上 `shell: true` 的展开一致。覆盖面逐一核过:

| 起进程的地方 | 是不是模型给的命令 | 处理 |
|---|---|---|
| `run_bash`(`hostExec.ts`) | 是 | 套上;写保护起不来时回 `Error: …`,命令没跑 |
| `run_background`(`processRegistry.ts`) | 是 | 套上;进程记 `remoteSeatbelt` |
| `write_process_input` | 是(往已有进程 stdin 写命令) | 没套这层的进程(本机 run 起的 shell / REPL)拒收远程 run 的输入;Ctrl-C 照旧 |
| `verifyCommand`(`runVerifyCommand`) | 用户配置 | 远程 run 本来就不跑(`agentLoop` 现查 `effectiveRemote`) |
| `runGit`(每个 host run 开头的 git 现场注入) | 固定 argv,但会执行仓库配置的 filter | 远程污点 run 套上(`agentLoop` 把 `remote` / `runId` 带进 `collectGitState` 的 ctx);写保护起不来时不注入 git 现场,不裸跑。~~本机 run 不变~~ **方案 B 起本机 run 也套**(见文末) |
| `runGit`(项目详情面板) | 同上 | ~~不变,不带 run 上下文~~ **方案 B 起也套**(见文末) |
| hooks、MCP stdio | 用户配置 | 不变 |
| 桌面终端 PTY | 用户在本机操作 | 渲染层 IPC,校验 sender,模型够不到 |
| 外部引擎委派 | 是 | 远程 run 本来就拒(`subAgent.ts`),runs 路由也剥 `engineId` |

**名单与 profile。** 名单由 `hostSandboxProtection.remoteShellWriteDenySpec()` 给出,与 `protectedRemoteWrite` 在同一个文件、用同一组表(`forsionDomains` / `tanguHomes` / 桌面 userData、`credentialPaths`、`forsionConfigPaths`、`protectedHostPaths`、C8 的启动区与 shell rc 名),渲染在 `sandbox/remoteShellSeatbelt.ts`。Seatbelt 后写的规则赢,所以顺序是:

1. `(allow default)`;
2. Library 例外能盖过的拒绝:任意位置的 `.tangu` / `.forsion` 段,Forsion 共享域、正式与 dev 家目录、引擎 home、桌面 userData 整片;
3. `allow`:`<引擎 home>/(agents|teams|engines)/<名>/Library`;
4. Library 里也必须赢的拒绝:Library 内的 `.tangu` / `.forsion`(按引擎 home 锚定,否则 `~/.forsion/tangu/…` 本身带 `.forsion` 段,整个 Library 会被重新拒掉)、凭据 / 本机配置 / 宿主沙箱那张表 / `~/.config` / `~/Library/LaunchAgents` / `~/.local/bin`、家目录顶层点条目本身、任意位置的 `.agents` / `.codex` 段、任意位置的 shell rc 文件名;
5. 以上各根的祖先目录拒 `file-write-unlink`:否则可以把整个祖先挪走、改完再挪回来。

路径一律渲染成大小写不敏感的正则字符串(`[aA]` 逐字母,正则元字符反斜杠转义,再按 Scheme 字符串转义 `\` 与 `"`)。原因有三,都现场探过:已存在的路径 Seatbelt 按真实大小写比,新建的路径按调用方的写法比,`.TANGU/` 在默认 APFS 上就是 `.tangu/`;`#"…"` 正则字面量装不下双引号,`(regex "…")` 字符串形式可以;带控制字符的路径直接拒绝渲染(抛错,命令不跑)。硬链接到保护文件会被拒(`ln` 报 `Operation not permitted`),用例钉住了。

**与结构化写工具的两处差异(刻意)。**
- 不拒 `.git`:远程 run 要能 `git commit`、`git init`、`git clone`,这些都会写 `.git/config` 与 `.git/hooks`。宿主沙箱开时的 profile 拒 `.git`,那一档本来就不能提交。
- 家目录点目录不整棵拒:只拒顶层点条目**本身**(`~/.gitconfig`、`~/.npmrc` 不能新建或改写,也不能新建 `~/.foo` 目录),外加 `~/.config`、`~/.local/bin`、`~/Library/LaunchAgents` 整棵。`~/.npm`、`~/.cache`、`~/.cargo` 里面照常可写,否则 `npm install` 之类全坏。代价:`~/.npm` 这类缓存目录若还不存在,第一次创建会被拒;`~/.zsh` 之类非标准位置的启动脚本不在名单里。

**失败即关。** `/usr/bin/sandbox-exec` 缺失、名单渲染失败,都抛 `RemoteShellProtectionError`:`run_bash` / `run_background` 回 `Error: This command comes from a remote session … was not run.`,绝不退回不包的命令。`sandbox_apply` 在子进程里失败(引擎自己跑在别的沙箱里)时,`sandbox-exec` 以 71 退出、不执行目标命令,同样不会裸跑。

**嵌套沙箱(已知限制,接受)。** 远程 run 里自己开沙箱的工具会失败:SwiftPM(`swift build` / `swift package` 编译 manifest)、部分 Homebrew 源码构建、Bazel 的 darwin-sandbox、在 `run_bash` 里跑 Codex CLI。被包住的命令 stderr 里出现 `sandbox_apply` / `sandbox-exec:` 时,工具结果附一句说明(加 `--disable-sandbox`,或在这台电脑上运行);出现 `Operation not permitted` 时附一句「这些位置按设计写不进,别换写法重试」。

**开销。** 本机(macOS 26.3)`spawnHostShell` 跑 `true` 50 次取平均:不包 2.2 ms,包 11.3 ms,每条命令多约 9 ms,其中名单现算 + 渲染约 2.6 ms(63 条规则,12 KB)。名单里有随配置变的项(微信状态目录、急停锁文件),每条命令现算,不缓存。

**测试。** `test/remoteShellSeatbelt.test.ts`(真 `sandbox-exec`,非 darwin 跳过):R3 执行面、本机对照、工作区与 `git init` + commit 可写、§6.3 名单逐项(共享域凭据与配置、技能、本 Agent 与别的 Agent 的 `config.toml`、插件、hooks、Library 里的 `.tangu` 与 `.zshrc`、项目 `.tangu` / `.TANGU`、`.agents`、任意位置的 `.zshrc`、家目录 `.zshrc` / `.gitconfig` / 新点目录 / `~/.config` / LaunchAgents / `~/.local/bin` / `~/.ssh`、userData 的 `remote-sessions.json` 与 dev 兄弟目录、急停锁文件)与 Library / `~/.npm` 里照常可写、硬链接与挪祖先、steer 染色、后台进程与 stdin、宿主沙箱开沿用原 profile、名单渲染失败即关、嵌套沙箱提示、fsmonitor 子进程继承。夹具目录名里带双引号、反斜杠、空格与正则元字符。`test/remoteShellSeatbeltMissing.test.ts`:`sandbox-exec` 缺失 → 工具错误、命令没跑,远程 run 的 git 现场不注入,本机 run 照常。`test/remoteGitStateSeatbelt.test.ts`:见下「git filter」。`remoteBashProtectedResidual` 的 R3 与 R5 执行那一步按计划翻转。负对照(去掉 `prepareHostCommand` 里的远程分支与 `spawnHostShell` 的条件)实跑:三个文件 12 条红,恢复后全绿。live 台架新增 `remotebash` 腿(`--only remotebash`),远程 run 用 `run_bash` 往隔离 home 的 `config.json` 追加空格、台架代批 mode 卡:工具结果 `Operation not permitted`、字节不变;同一负对照下为红。`tool`、`remoteclamp`、`remotecwd`、`remotesession` 照旧通过。

**宿主沙箱开(未改)。** 沿用原 `workspace-write` / `read-only` profile。它是 `deny default` 加可写根,可写根**之内**的保护比本名单少:项目里的 `.tangu` / `.forsion`、可写根里的 shell rc 文件、当前 Agent 目录里身份文件以外的东西(如 `agents/<slug>/plugins/*.json` 插件设置)对远程 run 可写。按任务约定只记录、不在这里改。

**git filter:远程一半已堵,本机一半待拍板(评审 P1,同日修;本机一半已按方案 B 收口,见文末)。** 因为不拒 `.git`,被批准的远程命令(或它起的任何程序)能在工作区仓库里写 `filter.<x>.clean` 与 `.gitattributes`(连 `git init` 都不需要事先有仓库)。引擎在每个 host 工作区 run 开头收集 git 现场(`runtimeContext.collectGitState` → `runGit`),`runGit` 的固定前缀关了 fsmonitor、hooks、外部 diff 与 gpg,没关 filter,于是 `git status --porcelain` 会执行它。评审指出:原先这一跑不带远程污点、不套本层,远程只要再发一条消息,filter 就以用户身份在下一次 run 的任何工具与审批之前改写 `config.json`,一次批准换来整条提权。

- **已修(远程驱动的一半)。** `agentLoop` 把 `remote` / `runId` 带进 `collectGitState` 的 ctx(`RuntimeExecContext` 加了这两个字段),`runGit` → `prepareHostCommand` 对远程污点 run 套同一个 profile,filter 这个孙进程继承它,`cp /dev/null config.json` 得到 `Operation not permitted`。`sandbox-exec` 缺失时 `prepareHostCommand` 抛错,`collectGitState` 返回 null,这一轮不注入 git 现场,绝不裸跑。本机 run 仍是原命令,逐字不变。开销:同一仓库 `collectGitState` 连跑 30 次取平均(机器负载 ~30,别的会话在跑),本机 ~11 ms、远程 ~53 ms,每个远程 run 开头多 ~40 ms(三条 git,两条并行;每条都套 profile 并现算名单),离 `runGit` 的 800 ms 预算尚远,超时也只是这一轮不注入 git 现场。用例:`test/remoteGitStateSeatbelt.test.ts`(真 `agentLoop` × 真 git × 真 `sandbox-exec`:远程 run 的 git 现场照常注入、`config.json` 不变;负对照去掉 `remote, runId` 实跑为红)、`remoteShellSeatbelt` 里的 filter 用例(`remote` 与 steer 染色的 `runId` 两种都不变)、`remoteShellSeatbeltMissing`(缺 `sandbox-exec` → null)。
- **仍开着(本机一半,待拍板)→ 已按方案 B 收口,见下节。** 本机 run 开头的 git 现场收集、项目详情面板(`projectContext.ts` 调 `runGit` 不带 ctx)和本机 run 里免审批的 `git status` 都不套这层,仍会以用户身份执行远程命令摆下的 filter;用例钉着(`config.json` 被清空)。不带远程污点的本机后台 run(Muse 周期、本机建的自动化)在工作区收集 git 现场时同样不套,不能当作「只有用户亲手操作才会触发」。要堵住得二选一:远程 shell 拒写 `.git/config` 与 `.git/info/attributes`(代价是远程 run 里 `git init` / `clone` / `git config` 失败),或让 `runGit` 无条件套写拒绝 profile,并让 known-safe 分类器把配置了 filter 的仓库当作非只读。

**仍挡不住的(补充)。** 除上文所列,还有经 LaunchServices 与 AppleEvents 落到沙箱外的执行:`open -a Terminal x.command`、`open x.app`、`osascript` 让 Terminal 或 System Events 执行命令。它们由系统服务在沙箱外启动进程,与 `launchctl` 同类。以及 `.git/hooks`:远程命令写进去的钩子会在用户下一次在自己的终端里提交时执行。

**Linux / Windows(方案 C)。** 设置 › 远程会话的上限档下写明:在这台电脑上,手机批准的命令能改本机 Forsion 设置,包括远程上限档,而命令未必看得出来。Linux 指向「本地命令与文件沙箱 = 仅工作区可写」(需要 bubblewrap);Windows 没有宿主沙箱,如实写「暂时没有能挡住的本地沙箱,只批准看得懂的命令」。CHANGELOG 同。

## 方案 B(P1 · G5b,2026-09-28)

分支 `feat/p1-g5b-engine-git-seatbelt`。上一节「git filter」的本机一半拍板选了 B:不拒远程 shell 写 `.git`(`git init` / `clone` / `git config` 照常),改为让**所有不经人看过的 git** 都套写拒绝 profile,并让 known-safe 分类器认得仓库里配的程序。

**macOS 执行层(宿主沙箱关)。** `ToolContext.writeProtectShell` 加进 `hostSandbox.shellWriteProtectApplies(ctx)` = darwin ∧ 宿主沙箱 `off` ∧(远程污点 ∨ `writeProtectShell`),`prepareHostCommand` / `spawnHostShell` 按它包。`remoteShellSeatbeltApplies` 仍只认远程(后台进程 stdin 闸与「来自远程会话」的失败提示是远程专属)。两处设 `writeProtectShell`:

| 起进程的地方 | 方案 B 之后 |
|---|---|
| `runGit`:每个 host run 开头的 git 现场、项目详情面板 | 每一条都套,不看污点(本机 run、Muse 周期、本机自动化同样)。`sandbox-exec` 缺失 / 名单渲不出 → `prepareHostCommand` 抛错 → git 现场 null、面板 `available:false`,绝不裸跑 |
| 模型的 `run_bash` 里被闸门按 known-safe 放行的 `git` 读命令(没人看过卡) | `gateToolCall` 回 `{ action:'approve', writeProtect:true }`,主循环(`runApprovedCall`)与子代理(`subAgent.ts`)执行时在 ctx 副本上设 `writeProtectShell`。别的 known-safe 程序(`ls`、`cat`、`rg` …)不读仓库配置,不包 |
| 用户在卡上亲手批的命令(含卡上改过参数后重闸放行的)、custom `allow` 规则、「总允许」、完全通行档里非 known-safe 的命令 | 不变,不包(本机亲手批准的执行逐字照旧) |
| `run_background` | 从来不是 known-safe,不涉及 |

本机那两类的失败提示单独一份(不说「来自远程会话」):`RemoteShellProtectionError(detail, local=true)`。macOS 上 `sandbox-exec` 缺失时,known-safe `git` 直接判为非 known-safe(回到审批卡),而不是放行后在执行时报错。

**分类器(各平台)。** `services/gitRepoPrograms.ts`(仓库发现也从 `approvals.ts` 挪到这里,`runtimeContext` 要用)。发现落在受保护 `.git` 上之后,再看这个工作树**仓库级**配置里有没有 git 会替人跑的程序,有就不免审批:

- 读哪些文件:`<commondir>/config`、`<gitdir>/config.worktree`、`<commondir>/config.worktree`;逐个 `git --no-pager config --no-includes --file <f> --list --null`,cwd 固定为文件所在盘的根(POSIX 即 `/`;实测在仓库里跑,发现阶段会读仓库配置并跟 `include.path`,`--file` 也挡不住),环境剥掉 `GIT_DIR` 一类与 `GIT_CONFIG_PARAMETERS`。按文件的 dev / ino / size / mtime / ctime 缓存,闸门上缓存命中约 0.2 ms,冷的一次约 6–20 ms。
- 哪些键:`filter.*.clean|smudge|process`、`core.fsmonitor`(`false` / `0` / `no` / `off` 不算)、`core.hooksPath`、`diff.external`、`diff.*.command|textconv`、`core.pager`、`pager.*`、`gpg.program`、`gpg.*.program`、`core.sshCommand`、`credential.helper`、`uploadpack.*` / `receivepack.*`、`remote.*.uploadpack|receivepack`、`!` 开头的 `alias.*`、`core.editor`、`sequence.editor`、`core.askPass`、`core.gitProxy`、`merge.*.driver`、`interactive.diffFilter`、`include.path`、`includeIf.*.path`(被包含的文件里可以有上面任何一条)、`hook.*`(较新 git 的配置式钩子)、git-lfs 自己的程序键 `lfs.extension.*.clean|smudge`、`lfs.customtransfer.*.path|args`、`lfs.standaloneTransferAgent`(子节按小写比,git-lfs 解析时整键转小写),以及指到别处的 `core.worktree`(子模块的 git 目录天生带、指回检出目录的那种不算)。
- 钩子:读命令里唯一会触发的是 `post-index-change` —— `git status` 刷新并写回 index 时跑它(实测)。`<commondir>/hooks/post-index-change` 存在就收回;`pre-commit` 之类不影响。
- 子模块与嵌套仓:`git status` 会递归进每个**已检出**的 gitlink,`.gitmodules` 里没登记的嵌套仓(`git add sub`)也一样(实测)。所以按 `<gitdir>/index` 里 mode 160000 的条目找,逐个进 `<top>/<path>/.git`(目录或 `gitdir:` 文件)再扫一遍,最多 4 层、32 个仓。index 自己解析(v2 / v3 / v4,sha1 / sha256),不在仓库里跑 `git ls-files`。
- 读不懂一律收回(当作「配置了」):`git config` 报错或超时、FIFO、`.git` 是软链、分拆 index(`link` 扩展)、层数或个数超界。环境里有 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_COMMON_DIR` / `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT` 也收回(模型的 git 继承引擎环境,用的不是推出来的那份)。
- 不看全局与系统配置:git-lfs 的 `filter.lfs.*` 就在 `~/.gitconfig` 里,算进来等于人人 `git status` 都要批。那两处远程 shell 写不进(家目录顶层点文件与 `~/.config` 在拒写名单里),本机 run 写它们也要审批。
- 但全局那个 `filter.lfs.process` 调起的 git-lfs 会从**仓库** `.git/config` 读它自己的程序键再执行 —— clean 时跑每个 `lfs.extension.<名>.clean`,传输时跑 `lfs.customtransfer.<名>.path`(评审补:原先没有 lfs 这一类,仓库只摆 `[lfs "extension.x"] clean = …` 加 `.gitattributes` 时扫出来是空的,模型的 `git status` 免审批,Linux / Windows 上引擎的 git 现场与面板裸跑它)。这几条读的是 git-lfs 不是 git,`-c` 前缀也写不出未知的扩展名,所以算前缀中和不了的一类。`.lfsconfig` 不是路子:git-lfs 只从它读 `lfs.url`、`lfs.fetchinclude` 一类白名单键(git-lfs-config 手册)。
- worktree 与子模块:干净时照旧免审批(K10b 的口径不变)。代价:仓库级配置里本就有这些键的用户(本地装的 LFS、按仓库配的 `core.sshCommand` / `credential.helper`、husky 一类 `core.hooksPath`),模型的 `git status` 会出卡。

**Linux / Windows 的引擎 git。** 没有 Seatbelt,`-c filter.<名>.clean=` 也写不成通配。`runGit` 开头 `engineGitBlocked(cwd)`:发现落在不受保护的 git 目录(工作区里摆出的 HEAD 布局、`--separate-git-dir`)、仓库配了固定前缀中和不了的程序(`filter.*`、`include*`、`hook.*`、git-lfs 的程序键、挪走的 `core.worktree`,含子模块)、或读不懂 → 抛 `EngineGitSkipped`,这一轮不注入 git 现场、面板显示不可用。前缀中和得了的(fsmonitor、hooksPath 与钩子、外部 diff、gpg、pager,以及引擎命令根本不碰的 ssh / credential)不影响。这里的发现不看环境里的 `GIT_DIR`(`runGit` 本就从子进程环境里剥掉它)。

**顺带(同一处)。** `runGit` 加 `--no-optional-locks`:`git status` 不再顺手写回 index。800 ms 超时会 SIGKILL 正在写 index 的 git,留下 `index.lock`,用户自己的下一条 git 就报「另一个 git 进程在跑」—— 测延迟时在高负载下实际撞上过一次。filter 照旧会被调用(负对照重跑仍红)。

**开销(macOS 26.3,机器负载 ~25,别的会话在跑)。** 每次都是冷的(间隔 1.1 s,12 次取中位数):git 现场收集小仓 48 → 66 ms、Genesis 仓 75 → 95 ms,每个 run 开头多约 20 ms;项目详情面板(7 条 git)小仓 45 → 53 ms、Genesis 仓 110 → 131 ms。名单现算在真家目录上、高负载下一次要十几到三十 ms,比 `sandbox-exec` 本身(约 10 ms)还贵,所以本机那两类的 profile 缓存 1 s(`remoteShellProfile(local)`);远程污点命令照旧每条现算。名单构建里唯一随调用方变的输入是 ALS 里的 Agent slug(各 Agent 的身份文件),它们今天都落在整片拒写的引擎 home 里、被精简掉,渲染结果与 slug 无关(实测逐字相同);缓存仍按 slug 分键,免得将来名单改了串到别的 Agent 头上。离 `runGit` 的 800 ms 预算尚远。

**测试。** `test/engineGitSeatbelt.test.ts`:分类器矩阵(上面每一类键逐条收回、`unset` 后恢复;`core.fsmonitor=false` 与非 `!` 别名不算;`post-index-change` 收回、`pre-commit` 不算;worktree 读主仓配置;`git submodule add` 的子模块与 `.gitmodules` 没登记的嵌套仓里的 filter;index v4、sha256、分拆 index;`GIT_CONFIG_PARAMETERS`);闸门对 git 给 `writeProtect`、对 `ls` 不给、配了 filter 的仓库 `git status` 弹卡;真 `sandbox-exec` 下项目详情面板照常出仓库信息、摆下的 filter 改不动 `config.json`(裸跑对照被清空);`run_bash` 带 `writeProtectShell` 改不动、不带(用户亲手批)照旧改得动。`test/engineGitNoSeatbelt.test.ts`:把 `process.platform` 打桩成 `linux` 跑真 git —— filter 与嵌套仓 filter 让 git 现场 null、面板不可用、`config.json` 不变;fsmonitor / 钩子 / sshCommand / credential 照跑且 fsmonitor 与钩子确实没被执行;摆出的 HEAD 布局不跑;环境里的 `GIT_DIR` 不影响引擎;git-lfs 形状(`filter.lfs.clean` 在全局配置、仓库配置只有 `lfs.extension.evil.clean`)同样不跑、`config.json` 不变,裸跑被清空 —— 本机没装 git-lfs,用一个照 git-lfs 行为写的替身(从仓库配置读 `lfs.extension.*.clean` 并执行),真 git-lfs 这条链没在本机跑过。分类器矩阵另加 lfs 各键(含大小写混写的子节)与 `lfs.url` / `priority` 不算。残余钉翻转:`remoteGitStateSeatbelt` ②(本机 run 的 git 现场照常注入、`config.json` 不变)与新增 ③(真 loop:本机 auto-edit run 里模型免审批的 `git status --porcelain`,filter 定义在全局配置、仓库只有 `.gitattributes`,不弹卡、出结果、`config.json` 不变);`remoteShellSeatbelt` 的 filter 用例最后一步(本机收集改不动,另加裸跑对照);`remoteShellSeatbeltMissing` 的「本机照常收集」翻成 null,另加面板不可用、known-safe git 回到审批卡、放行后硬套也只回本机文案的错误。

负对照逐条实跑为红,恢复后全绿:`runGit` 去掉 `writeProtectShell` → 4 个文件 5 条红(面板、② ③、filter 用例、缺 `sandbox-exec`);`runApprovedCall` 不传 `writeProtect` → ③ 红;`isKnownSafeBash` 去掉 `repoGitPrograms` 判定 → 7 条红;`runGit` 去掉 `engineGitBlocked` → 非 darwin 两条红;`classify` 去掉 lfs 分支 → 2 条红(矩阵、非 darwin 的 git-lfs 形状),另用探针确认此时引擎的 git 现场确实照常出结果并清空了 `config.json`。

**仍挡不住的(方案 B 之后)。**
- macOS 上 filter 仍以用户身份**执行**,只是写不进保护名单:读凭据、联网外发、写名单以外的路径都照旧,与任何一条被批准的远程命令同级(见「A 仍挡不住的」)。
- 全局配置里 `includeIf "gitdir:…"` 指向工作区里的文件:分类器不看全局配置,那个文件若由模型写出,里面的 filter 不会让 known-safe 收回(macOS 上执行照样被包;Linux / Windows 上引擎的 git 也不查)。
- 别的「全局配置里的 filter 程序再从仓库配置读自己的程序键」:只认 git-lfs 这一家的键。git-annex、git-crypt 这类把 `filter.*` 写进仓库配置的,按 filter 已收回;若有别的工具把驱动放在全局、把要执行的命令放在仓库配置里自定义的节下,分类器不认得(macOS 上执行照样被包)。
- Linux / Windows 上 `--separate-git-dir` 的仓库没有 git 现场与面板 git 信息(发现不受保护 → 按失败即关处理)。
- Windows 这条路径没在真机上跑过(CI 的 Windows 作业只跑持久化写入那份名单);非 darwin 分支只在 macOS 上把 `process.platform` 打桩成 `linux` 验过,Linux CI 跑全量。若 Windows 上 `git config --file` 起不来,结果是所有仓库都判为「读不懂」:模型的 `git status` 全要批、引擎不读 git 状态 —— 方向是收紧,不会放开。
- 用户在卡上亲手批准的 git 命令不包:卡上写着 `git status`,人批了,filter 就以用户身份照写(本机亲手批准的执行按约定逐字不变)。
- `.git/hooks` 里的提交类钩子:用户自己在终端里提交时执行,不在引擎能管的范围内。
