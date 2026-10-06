# Forsion Unit

Unit 是独立运行的 Forsion 基础框架，复用 Genesis Desktop 的界面、笔记处理器与 Tangu 引擎。它提供插件宿主和 Web UI；已安装的插件决定业务功能。本分支与独立发行包不包含商业 Forsion Server、Admin 管理界面或商业部署组合，相关产品在独立仓库装配。

Unit is the independently runnable Forsion framework, sharing the Genesis Desktop renderer, note handlers and Tangu engine. It provides the plugin host and Web UI; installed plugins supply business capabilities. This branch and its standalone releases exclude the commercial Forsion Server, its Admin UI and commercial deployment compositions. Those products are assembled in separate repositories.

## Desktop 同步 / Desktop synchronization

Desktop 基线不再手工维护：构建时由 git 推导，取检出历史里最新的 `v*` 稳定版标签作基线，距它的提交数作 Unit 修订号。同步方向为 Desktop → Unit；共享功能复用源码，Unit 维护宿主适配。本分支不向 Desktop 主线自动回合，也不从商业 Server 仓库同步代码。

The Desktop baseline is no longer hand-maintained: the build derives it from git, taking the newest `v*` stable tag contained in the checkout as the baseline and the number of commits since it as the Unit revision. Synchronization flows from Desktop into Unit. Shared features reuse source code; Unit maintains its host adapters. This branch does not automatically merge back into Desktop or import the commercial Server repository.

```sh
# Refresh upstream refs, then inspect drift without changing source.
git fetch origin main --tags
node unit/check-sync.mjs
```

发现新稳定版后，合并对应标签并处理冲突，运行类型、插件、账号和本地安装验收，再构建发行。尤其检查已抽取的共享处理器是否接到了上游修复。构建前的检查只拦一种情况：仓里已有比当前检出更新的稳定版标签而它不在 HEAD 历史里（在旧检出上打包）。不是恰好在稳定版标签提交上的构建（有后续提交，或 package.json 版本已越过标签）都记为预发布，写进 `release.json` 而不报错；package.json 版本低于基线标签则拒绝。检查基于已获取的标签；它不会自行联网或自动合并。

When a new stable release is available, merge its tag, resolve conflicts, and run type, plugin, account and local installation checks before building. Verify that fixes in extracted shared handlers are carried forward. The pre-build check refuses exactly one situation: a newer stable tag exists in the repository but not in HEAD's history (packaging from a stale checkout). Any build that is not exactly the tagged commit (later commits, or a package version already bumped past the tag) is recorded in `release.json` as a pre-release rather than refused; a package version behind the baseline tag is refused. It checks fetched tags and does not fetch or merge automatically.

`.github/workflows/check-unit.yml` 提供分支检查和手动构建；发行包中的 `release.json` 记录 Desktop 基线标签与提交、Unit 修订号、是否预发布及源码提交。检查本身不发布版本。

`.github/workflows/check-unit.yml` provides branch validation and manual builds. Each distribution contains `release.json` with its Desktop baseline tag and commit, Unit revision, pre-release flag and source commit. Validation does not publish a release.

## 构建与安装 / Build and install

```sh
# Framework + Web UI only.
node unit/build.mjs --package
# Framework + Web UI + optional local business plugin packages.
node unit/build.mjs --package --local-plugins
```

构建使用全新的暂存目录，通过检查后替换 `unit/dist`，不会继承旧发行目录中的额外插件。构建失败保留上一份完整发行。依赖安装后可直接构建，无需商业后端源码、数据库或凭据。Node 20+ 可运行框架；插件的原生依赖须匹配目标系统、CPU 和 Node ABI。

Builds use a fresh staging directory and replace `unit/dist` after validation, preventing leftover plugins from entering the next release. Failed builds preserve the previous distribution. Once dependencies are installed, building requires no commercial backend source, database or credentials. The framework runs on Node 20+; native plugin dependencies must match the target OS, CPU and Node ABI.

复制整个 `unit/dist` 到设备后，在发行目录中执行：

Copy the entire `unit/dist` directory to the device, then run from that directory:

```sh
node main.mjs init /absolute/path/my-unit --mode local --port 3002 --base /web/
node main.mjs install /absolute/path/my-unit/unit.json ./plugins/amadeus
node main.mjs install /absolute/path/my-unit/unit.json ./plugins/tangu
node main.mjs install /absolute/path/my-unit/unit.json ./plugins/calendar
node main.mjs run /absolute/path/my-unit/unit.json
# From another terminal, get this device owner's browser access link.
node main.mjs access /absolute/path/my-unit/unit.json
```

`--local-plugins` 提供 Amadeus、Tangu、Calendar、Automation、Public 的安装包，安装哪些由设备所有者决定。Amadeus 和 Tangu 包含本地运行实现；`unit/plugins` 中的源 manifest 仅为前端声明，不等于完整本地运行包。

`--local-plugins` supplies Amadeus, Tangu, Calendar, Automation and Public packages for the owner to choose from. Amadeus and Tangu include local runtimes. Source manifests in `unit/plugins` are frontend declarations, not complete local runtime packages.

默认仅监听回环地址。设备所有者密钥保存在私有数据目录；访问链接用 fragment 传递密钥，网页消费后移除，仅保留在当前标签会话。实例数据目录应在发行目录外，更新代码不会覆盖数据。`init` 拒绝覆盖已有配置。

The default listener is loopback-only. The owner key stays in private instance data; the browser consumes it from the URL fragment, removes it and retains it only for that tab session. Keep instance data outside the release directory so code updates preserve data. `init` refuses to overwrite existing configuration.

## npm 发布 / npm package

每个桌面正式版（`v*` 标签）推上来后，`check-unit.yml` 的 `publish-npm` 把同一提交构建出的 Unit 发到 npm：`@forsion/unit`，版本号等于桌面版本号。包内是框架本体与网页壳（`main.mjs`、`backendWorker.mjs`、`web/`、`release.json`），不含按平台构建的本地插件。只发标签那一个提交的构建：`main` 上的构建与它跟着的正式版同号，`unit/check-publishable.mjs` 会拒绝。

After each stable Desktop release (`v*` tag), the `publish-npm` job in `check-unit.yml` publishes the Unit built from that commit as `@forsion/unit`, versioned like Desktop. The package holds the framework and its Web UI (`main.mjs`, `backendWorker.mjs`, `web/`, `release.json`) without the platform-specific local plugins. Only the tagged commit is published: a build from `main` shares the version of the release it follows, so `unit/check-publishable.mjs` refuses it.

```sh
# Take the prebuilt Unit without a Genesis checkout; it has no dependencies to install.
npm pack @forsion/unit@latest && tar -xzf forsion-unit-*.tgz   # → ./package/main.mjs
```

发布走 npm trusted publishing（OIDC），仓库里没有 npm 令牌。npm 规定包存在后才能登记，所以首个版本要人工发一次：从该标签的 `check-unit` 运行里下载产物 `forsion-unit-npm`，然后

Publishing uses npm trusted publishing (OIDC); the repository holds no npm token. npm only lets an existing package register a publisher, so the first version is published once by hand: download the `forsion-unit-npm` artifact from that tag's `check-unit` run, then

```sh
npm login
npm publish ./forsion-unit-<version>.tgz --access public
# --allow-publish is required; `npm trust` needs npm ≥ 11.15.
npx -y npm@11 trust github @forsion/unit --repo Changan-Su/Forsion --file check-unit.yml --allow-publish
```

## 插件与生命周期 / Plugins and lifecycle

```sh
node main.mjs status /absolute/path/my-unit/unit.json
node main.mjs disable /absolute/path/my-unit/unit.json calendar
node main.mjs enable /absolute/path/my-unit/unit.json calendar
node main.mjs restart /absolute/path/my-unit/unit.json tangu
node main.mjs update /absolute/path/my-unit/unit.json calendar /absolute/path/calendar-package
node main.mjs install /absolute/path/my-unit/unit.json /absolute/path/new-plugin-package
```

相同 ID 的新包是更新；已运行的插件可在线替换，激活失败恢复旧版本。依赖按顺序启停，不能先停用仍被其他活跃插件依赖的包。安装全新插件前停止 Unit。迁移命令 `migrate <config> <plugin-id>` 仅用于提供迁移能力且未激活的插件。控制通道仅对本机所有者开放，独立于网页访问者。

Installing a new package with the same ID updates it. Running plugins can be replaced live, with rollback on activation failure. Dependencies determine lifecycle order; a dependency cannot be disabled while its dependents are active. Stop Unit before adding a new plugin. `migrate <config> <plugin-id>` applies only to inactive plugins that provide migrations. The local owner control channel is separate from browser visitor access.

显式在线更新使用 `update <unit.json> <plugin-id> <package-path>`。ID 必须已安装且与新包 manifest 一致；Unit 未运行时命令直接失败，不修改配置或执行迁移。包路径相对当前工作目录解析，必须指向已解包的插件目录。更新复用安装器的包、依赖与路径检查，将包复制到实例下独立的版本目录，再通过本机控制通道切换并持久化；之后移动或删除源包不会影响已安装版本。Unit 的进程和端口保持不变，更新包及其活跃依赖方按依赖顺序重启；无关插件继续运行。新包激活失败时恢复旧版服务，配置保留旧路径。离线替换仍可使用 `install`，下次启动时加载。

Use `update <unit.json> <plugin-id> <package-path>` for an explicit live update. The ID must already be installed and match the new manifest. If Unit is offline, the command fails without changing configuration or running migrations. The package path resolves from the current working directory and must name an unpacked plugin directory. Updates reuse the installer's package, dependency and path checks, copy the package into a separate instance version directory, then activate and persist it through the local control channel. Moving or deleting the source package afterward does not affect the installed version. Unit keeps its process and port; the updated plugin and its active dependents restart in dependency order while unrelated plugins keep running. Failed activation restores the previous service and keeps its configured path. Use `install` for an offline replacement that loads at the next startup.

插件继续使用 Forsion 的 `main`、Space 配方和插件 API。可选 `frontend.features` 激活共享界面中的 Amadeus、Tangu、Calendar、Automation、Public 功能；新增界面实现仍需更新 Unit。可信插件可声明 `runtime` 提供设备能力，或声明 `backend` 提供 HTTP 服务。接口分别见 `runtimeTypes.ts` 和 `backendTypes.ts`；支持这些通用接口不代表预装任何商业实现。

Plugins use Forsion's existing `main`, Space recipes and plugin API. Optional `frontend.features` activates Amadeus, Tangu, Calendar, Automation or Public in the shared renderer; new UI implementations still require a Unit update. Trusted plugins can declare `runtime` for device capabilities or `backend` for HTTP services, as defined in `runtimeTypes.ts` and `backendTypes.ts`. Supporting these generic contracts does not bundle a commercial implementation.

Unit 拥有投射端口，后端插件通过 worker 和进程内流接入；Tangu 的本地引擎由插件单独托管。未安装对应插件时不创建业务笔记库或启动引擎。账号身份可由外部插件提供，浏览器访问者的配置与插件数据按已验证身份隔离。公开投射与本地所有者模式必须显式选择，服务不可用不会回落到设备数据。

Unit owns the projection port and dispatches backend plugin requests through workers and in-process streams. The Tangu plugin manages its own local engine. Without the relevant plugin, Unit creates no business vault or engine. External plugins may provide account identities; visitor preferences and plugin data are scoped to verified identities. Public projection and local owner mode are explicit choices; service failure never falls back to device data.

本地运行时和后端插件采用可信代码模型，具有宿主用户权限；worker 提供生命周期隔离，不提供恶意代码沙箱。本地 Tangu 可使用直接配置的模型供应商，无需商业 Server；生成内容仍需要可用模型。

Local runtimes and backend plugins are trusted code with the host user's permissions. Workers isolate lifecycle, not malicious code. Local Tangu can use directly configured model providers without the commercial Server; generation still requires an available model.

## 验证 / Verification

```sh
node unit/check-sync.mjs
node --test unit/*.test.mjs
cd desktop
npm run typecheck
npm run check:parity
npx vitest run electron/unit*.test.ts electron/backendRunner.test.ts electron/basicUnit.test.ts
# Focused real-process CLI update, rollback and persistence checks.
npx vitest run electron/unitCli.test.ts
```

`node unit/verify-local.mjs --qbird /absolute/path/bluebird` 使用已构建的发行包，在临时目录验证安装、真实本地笔记、插件和引擎生命周期、重启持久化；不需要商业后端或数据库。`--serve` 可保留独立预览。必须使用与发行包原生模块匹配的 Node；构建时可用 `UNIT_SQLITE_PACKAGE` 指向同版本、目标 ABI 的 SQLite 包。

`node unit/verify-local.mjs --qbird /absolute/path/bluebird` verifies the built release in a temporary directory, including installation, real local notes, plugin and engine lifecycle, and restart persistence. It needs no commercial backend or database. `--serve` retains an isolated preview. Use a Node runtime matching the package's native modules; `UNIT_SQLITE_PACKAGE` can select the same locked SQLite version built for the target ABI.


## 管理 MCP 与 Unit 运维任务

Admin Panel MCP 新增 `unit_status`、`unit_releases`、`unit_operations`、`unit_operation_get`、`unit_plugin_action`、`unit_update`。
需同时更新 Unit 与 Server，并在实例私有 `unit.json` 顶层开启：

```json
{"management": {"enabled": true}}
```

默认关闭。重启 Unit 后生效；该配置不下发浏览器。Unit 自己接管 `/api/admin/unit/*`，使用活动账户提供者重新验证原 Bearer、当前 ADMIN 账户与令牌权限，拒绝普通用户/伪造身份，并在提交与实际执行前再次验证。服务端校验不依赖模型传入的角色。

准备一次后，操作顺序为：

1. 用 owner MCP 令牌上传并提交 unit-release ZIP，或在部署机用 CLI 登记可信、已包含依赖的发行包：`node main.mjs stage /path/to/unit.json /path/to/bundled-package`。
2. 调用 `unit_releases` 选择 releaseId，`unit_status` 检查目标版本、状态与依赖。
3. 生成 UUID v4 requestId，调用 `unit_update`，提供 pluginId、releaseId、requestId、confirm:true。
4. 用同一 requestId 调用 `unit_operation_get`；连接中断时仍用该编号查询或重试，不另建编号。

stage 将包复制到 Unit 私有发行目录并保存 SHA256；安装前与安装副本都会检查摘要。源目录移动不影响已登记包。MCP 不接受包路径、下载 URL 或 shell 命令；npm-ci 包先在目标平台安装依赖并封装，远程任务不执行 npm 安装。发行目录最多保留 200 项，满后由本机运维归档不用的条目。

任务由 Unit 主进程持有，状态为 queued/running/succeeded/failed/interrupted，更新还显示 verifying-release/applying 阶段；保存操作人、目标、发行编号与时间；不持久化 Bearer、私有配置或完整包路径。最近 100 条任务持久化，幂等检查限于这些保留记录；同一编号换参数或换操作人会被拒绝。Unit 重启将未完成任务标为 interrupted，须先检查实际状态再决定是否重试。当前串行执行，一个任务运行时其他新任务返回 409。

`unit_plugin_action` 支持 enable/disable/restart/migrate。迁移须先停用目标模块；更新不自动迁移，失败尝试恢复旧代码，不回滚数据库。为保持远程恢复入口，停用或迁移账户提供者本身只能用本地 CLI；允许重启和更新账户提供者。Server 自身更新时其 MCP 连接可能断开，账户服务恢复前查询可能短暂失败，恢复后可继续查 Unit 保存的任务。

所有运维写操作都要求 confirm:true；它只是显式意图参数，真人审批仍由调用客户端负责。MCP auditor 可读取，operator 可启停/重启/更新已暂存包，owner 另可上传暂存包和迁移。账户提供者投射 ADMIN_SCOPED 与 adminPermissions；缺失权限时拒绝，账户解析须携带 administration 用途，旧 Unit 无法接收 scoped 身份，避免回滚后的越权。常规登录会话和旧未收窄令牌保留既有权限。

验收：`cd desktop && npx vitest run electron/unitManagement.test.ts electron/unitCli.test.ts electron/unitInstall.test.ts electron/unitRuntime.test.ts`。
真实 Server/MCP/Bluebird/私有 PG 验收见相邻 server 的 `scripts/verify-unit-installation.mjs --management --bluebird ...`。

上传、角色和本地直传 helper 详见 [Admin MCP](../../server/microserver/admin-mcp/README.md)。上传只登记发行包，激活仍须独立调用 unit_update。
