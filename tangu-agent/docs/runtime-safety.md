# Runtime cancellation and local sandbox / 运行取消与本地沙箱

## 本地沙箱

桌面入口：**设置 → 常规设置 → 连接 → 自动托管 → 本地命令与文件沙箱**。保存并重启后端后生效。旧安装默认 `off`，不会在升级时改变现有插件、MCP 和命令的权限。

独立引擎在统一 `config.json` 中读取同一配置（桌面通常为 `~/.forsion/config.json`；CLI 按 `TANGU_HOME` 与共享目录规则解析）。只合并以下段，保留其余配置：

```json
{
  "hostSandbox": {
    "mode": "workspace-write",
    "network": "deny"
  }
}
```

| 配置 | 行为 |
| --- | --- |
| `off` | 保留原有直接执行与审批策略 |
| `workspace-write` | OS 限制写入到当前工作区与额外工作根；macOS 还允许已存在的当前智能体私有目录写入。安全配置、引擎代码及下述平台覆盖的元数据受保护 |
| `read-only` | 工作区与其他常规路径只读；仅允许每次执行专属的私有临时目录写入 |
| `network: deny` | 沙箱子进程禁止联网，包括回环网络 |
| `network: allow` | 允许联网，包括本机服务；不会限制可访问的域名与端口 |

macOS 使用 `/usr/bin/sandbox-exec`（Seatbelt）；Linux 使用 `/usr/bin/bwrap` 或 `/bin/bwrap`。Linux 仍须系统允许相应命名空间；不具备能力、配置无效或工作根无法安全隔离时拒绝执行，绝不回落直接执行。Windows 暂不提供受限执行后端。

此沙箱限制**命令和文件工具的写入与网络**，仍允许读取宿主文件，包括凭据文件；它不是防凭据泄露的完整隔离环境。引擎本身、LLM 通信和用户在桌面中的手工操作属于可信宿主，不被子进程网络开关限制。Linux 的工作区挂载比 macOS 更保守：不会自动授予整个智能体私有目录可写；覆盖缺失安全文件或过宽目录时可能拒绝启动。

受限模式已覆盖 `run_bash`、文件读取/写入/编辑、目录、图像与文档读取，以及后台进程启动/输入/停止。后台进程记录创建时的权限范围，不能向旧的无沙箱进程发送输入来绕过新策略。验证命令与 Git 现场采集也经同一执行边界。

尚未纳入执行服务的工具采用默认拒绝：Hooks、自定义工具、MCP、原生引擎插件、外部引擎及委派等不可用；同名插件不能替换受保护的核心工具。文件搜索、补丁可在允许命令执行时通过 `run_bash` 完成。自动写入检查点及其宿主回滚在受限模式停用，避免回滚绕过文件隔离。限制在工具定义、执行入口与扩展进程启动处同时检查，模型参数不能修改可信配置。

Linux 只读挂载仅保护各可写根直属且已存在的 `.git/.agents/.codex`，不递归保护嵌套目录，也不覆盖未来新建的同名路径；它不等价于 macOS 的路径规则保护。两个受限模式均使用每次执行创建的真实磁盘临时目录，退出时尽力清理；不是任意 `/tmp` 可写，也不保证异常退出后完全无残留。

原有 Python/JavaScript **Docker 沙箱是另一条执行路径**，不会被本地 OS 沙箱设置替代。

## 停止、重试与压缩

- 搜索只在 `rg` 不存在时回落；取消、超时及真实执行错误不会引发另一轮全盘扫描。回落正则在可终止 Worker 中执行，限制文件数、读取大小和内存，等待 Worker 退出再返回。
- Hook 捕获 stdout/stderr 时按字节总量限制，并正确拼接 UTF-8。POSIX 使用独立进程组，Windows 使用 `taskkill /T /F`；清理回执超时会明确报告，不假装所有后代已退出。Windows 未获得真机验证，脱离进程树的子进程仍需 Job Object 等更强生命周期支持。
- LLM 同时计量传输存活与语义进展。直连默认 120 秒、托管默认 360 秒没有正文、思考或实际工具增量时失败退出，持续 ping/alive/waiting、空事件及重复元数据不能续命；仍有有效增量的长回复可继续。托管端给服务端默认 300 秒上游裁决留出 60 秒传输余量，长期静默思考也受此限制；可按服务端特性设置 `TANGU_STREAM_IDLE_TIMEOUT_MS` / `TANGU_BRAIN_STREAM_IDLE_MS`。
- LLM 的失败重试链累计计算请求与退避时间，达到现有 60 秒预算后不再发起重试。该预算控制**是否开始下一次尝试**，不是强制打断正常生成的 60 秒总时限。退避可立即取消。
- 满窗口压缩总结同一份冻结的工作消息前缀，包括本轮尚未落库的工具结果；只替换该前缀，保留完整尾部工具批次。取消或快照变化不修改上下文，不提前推进持久摘要的时间戳。
- Docker 全局、安装与会话执行队列可取消，通常最多排队 60 秒；执行和清理持有资源所有权。不能以 `Promise.race` 提前释放仍有写入副作用的工作区锁。
- Docker CLI 退出不等于容器退出。停止、超时和启动失败须等待具名容器删除确认；无法确认时隔离工作目录、保留占用并报告错误，阻止继续执行或删除仍可能变化的目录。清理不复用已取消的信号。
- 重启时只读检查已有 Tangu 容器的可写挂载，隔离相交目录；不会按名字前缀杀掉其他实例。该检查只覆盖 Docker 当时可见的容器，不能替代对 daemon 中未获回执创建请求的人工核实。
- 云存储中尚无取消参数的只读接口会排空已发出的请求；停止后不再继续遍历。会话 hydration 含磁盘写入，保留实际完成边界，不能用竞速提前释放其所有权。

## Local sandbox (English)

Open **Settings → General → Connection → Managed → Local command and file sandbox**, then save and restart the backend. Existing installations remain in `off` mode. CLI instances read the same `hostSandbox` section from their unified configuration file.

`workspace-write` allows writes within the selected workspace and extra roots; macOS also allows the current agent's existing private directory, except protected identity/runtime/configuration paths. `read-only` allows writes only to a per-execution private scratch directory on disk. Scratch cleanup is best-effort and abnormal exits may leave files behind. `network: deny` blocks child-process networking, including loopback; `allow` includes access to local services. Local files and credentials remain readable. The trusted engine, model requests and manual desktop actions remain outside this child-process boundary.

macOS uses Seatbelt; Linux requires bubblewrap and working namespace support. Windows is unsupported. Invalid configuration, unavailable isolation and unsupported writable roots produce errors without unrestricted fallback. Linux uses more conservative writable roots and may reject broad roots containing missing protected paths. Its metadata protection covers only existing `.git/.agents/.codex` directly inside each writable root, not nested or future paths.

Shell, file/document/image tools, background processes, verification commands and Git context collection use the broker. Uncovered tools, Hooks, custom tools, MCP, native engine plugins, external engines and delegation are disabled. Search and patch through `run_bash` when available. Host-side checkpoint rollback is disabled in restricted mode. Python/JavaScript Docker execution remains a separate sandbox.

A separate semantic watchdog rejects streams that keep sending only heartbeats or empty events (120 seconds direct, 300 seconds hosted by default). Actual reasoning and tool deltas keep long responses alive. Silent reasoning without emitted progress is subject to the same limit.

Cancellation now reaches queued work, search workers, Hook process groups, retry backoff and Docker startup. Docker cleanup requires container-removal acknowledgement; uncertain workspaces are quarantined rather than reused. Runtime compaction summarizes exactly the working prefix it replaces, preserving current tool progress and complete tail batches. The cumulative retry budget controls new attempts rather than imposing a 60-second maximum on a healthy response.

## Reproducible checks / 回归入口

From `tangu-agent/`:

```sh
npm run typecheck
npm test
```

Key instruments include `test/fileSearchRuntime.test.ts`, `test/hookRuntime.test.ts`, `test/fileWorkspaceCancellation.test.ts`, `test/agentLoopRuntimeSafety.test.ts`, `src/services/compactionRuntime.test.ts`, `src/tools/registryCancellation.test.ts`, `src/tools/registrySandbox.test.ts`, `src/sandbox/hostSandbox.test.ts`, `test/streamProgressRuntime.test.ts`, and `test/dockerLifecycleSafety.test.ts`. OS tests use temporary fixtures; Docker failure tests use a controlled CLI double without a daemon.

From `desktop/`, after building the engine:

```sh
npm run build
npx vitest run shared/hostSandboxConfig.test.ts frontend/src/i18nCoverage.test.ts
node scripts/host-sandbox.check.cjs
npm run check:parity
```

The Electron instrument uses isolated home/userData, exercises real controls and configuration persistence, and saves Chinese/light and English/dark screenshots under `/tmp/forsion-host-sandbox-*.png`.

### 2026-09-08 acceptance / 本轮验收

- 引擎全量 154 文件、1,460 项测试通过；引擎构建及类型检查通过。
- macOS 原生隔离测试 12 项通过，含越界写入、子进程继承、符号链接、配置/元数据保护、网络、旧后台进程输入与真实 npm 离线脚本；运行时验证/Git 采集测试 7 项通过。
- 桌面构建、类型检查、配置/i18n 测试及跨端契约检查通过。真实 Electron 回归验证保存、后端重启、未保存草稿保留、重载持久化和中英明暗界面。
- 未连接真实模型评估提速比例；本机没有可用 Docker daemon，Docker 生命周期通过受控 CLI 故障测试验证。Linux/Windows 未做真机验证。Docker 启动检查不提供多个活跃实例间的分布式目录锁；无法确认的容器创建/清理须核实所有权后人工恢复。
