# Forsion Unit

Unit 是独立运行的 Forsion 基础框架，复用 Genesis Desktop 的界面、笔记处理器与 Tangu 引擎。它提供插件宿主和 Web UI；已安装的插件决定业务功能。本分支与独立发行包不包含商业 Forsion Server、Admin 管理界面或商业部署组合，相关产品在独立仓库装配。

Unit is the independently runnable Forsion framework, sharing the Genesis Desktop renderer, note handlers and Tangu engine. It provides the plugin host and Web UI; installed plugins supply business capabilities. This branch and its standalone releases exclude the commercial Forsion Server, its Admin UI and commercial deployment compositions. Those products are assembled in separate repositories.

## Desktop 同步 / Desktop synchronization

`upstream.json` 记录已合入的 Desktop 稳定版标签、提交和 Unit 修订号。同步方向为 Desktop → Unit；共享功能复用源码，Unit 维护宿主适配。本分支不向 Desktop 主线自动回合，也不从商业 Server 仓库同步代码。

`upstream.json` records the merged Desktop stable tag, commit and Unit revision. Synchronization flows from Desktop into Unit. Shared features reuse source code; Unit maintains its host adapters. This branch does not automatically merge back into Desktop or import the commercial Server repository.

```sh
# Refresh upstream refs, then inspect drift without changing source.
git fetch origin main --tags
node unit/check-sync.mjs
```

发现新稳定版后，在 Unit 分支合并对应标签并处理冲突；更新 `upstream.json`，运行类型、插件、账号和本地安装验收，再构建发行。尤其检查已抽取的共享处理器是否接到了上游修复。版本检查会拒绝“只改版本号、没有合入上游提交”的假同步。检查基于已获取的标签；它不会自行联网或自动合并。

When a new stable release is available, merge its tag into the Unit branch, resolve conflicts, update `upstream.json`, and run type, plugin, account and local installation checks before building. Verify that fixes in extracted shared handlers are carried forward. The version check rejects a version bump without the upstream commit in ancestry. It checks fetched tags and does not fetch or merge automatically.

`.github/workflows/check-unit.yml` 提供分支检查和手动构建；发行包中的 `release.json` 记录 Desktop 基线、Unit 修订号及源码提交。检查本身不发布版本。

`.github/workflows/check-unit.yml` provides branch validation and manual builds. Each distribution contains `release.json` with its Desktop baseline, Unit revision and source commit. Validation does not publish a release.

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

## 插件与生命周期 / Plugins and lifecycle

```sh
node main.mjs status /absolute/path/my-unit/unit.json
node main.mjs disable /absolute/path/my-unit/unit.json calendar
node main.mjs enable /absolute/path/my-unit/unit.json calendar
node main.mjs restart /absolute/path/my-unit/unit.json tangu
node main.mjs install /absolute/path/my-unit/unit.json /absolute/path/new-plugin-package
```

相同 ID 的新包是更新；已运行的插件可在线替换，激活失败恢复旧版本。依赖按顺序启停，不能先停用仍被其他活跃插件依赖的包。安装全新插件前停止 Unit。迁移命令 `migrate <config> <plugin-id>` 仅用于提供迁移能力且未激活的插件。控制通道仅对本机所有者开放，独立于网页访问者。

Installing a new package with the same ID updates it. Running plugins can be replaced live, with rollback on activation failure. Dependencies determine lifecycle order; a dependency cannot be disabled while its dependents are active. Stop Unit before adding a new plugin. `migrate <config> <plugin-id>` applies only to inactive plugins that provide migrations. The local owner control channel is separate from browser visitor access.

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
```

`node unit/verify-local.mjs --qbird /absolute/path/bluebird` 使用已构建的发行包，在临时目录验证安装、真实本地笔记、插件和引擎生命周期、重启持久化；不需要商业后端或数据库。`--serve` 可保留独立预览。必须使用与发行包原生模块匹配的 Node；构建时可用 `UNIT_SQLITE_PACKAGE` 指向同版本、目标 ABI 的 SQLite 包。

`node unit/verify-local.mjs --qbird /absolute/path/bluebird` verifies the built release in a temporary directory, including installation, real local notes, plugin and engine lifecycle, and restart persistence. It needs no commercial backend or database. `--serve` retains an isolated preview. Use a Node runtime matching the package's native modules; `UNIT_SQLITE_PACKAGE` can select the same locked SQLite version built for the target ABI.
