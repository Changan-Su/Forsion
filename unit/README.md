# Forsion Basic Unit

独立 Node 进程，复用 `desktop/electron/unitWeb.ts` 的网页投射与 Genesis 渲染层。
部署内容由 `unit.json` 中安装的插件与默认 Space 决定；宿主没有 Server Admin 专属视图。

```sh
node unit/build.mjs
cd desktop && npm run build:unitweb
```

部署包包含 `main.mjs`、`web/`、`plugins/` 和 `unit.json`，运行 `node main.mjs unit.json`。
`unit.json` 必填：`instanceId`、`name`、`version`、`port`、`basePath`、`webDist`、
`plugins`（包目录数组）、`defaultSpace`（某个已安装插件提供的 Space）。相对目录以配置文件为基准。
默认监听 `127.0.0.1`，`UNIT_PORT` 可覆盖端口。修改安装清单后重启生效。

当前运行形态是公开网页投射：只公开插件 UI 代码与 Space 配方；业务鉴权由插件连接的 API 执行。
浏览器插件数据和 UI 配置保存在以 Unit identity 分隔的 sessionStorage，刷新保留，关闭标签页结束。
引擎、主机文件、vault、配对、主机配置写入均不向访问者开放。桌面 Unit 原有配对模式不变。

Server 接入见其 `scripts/prepare-admin-unit.mjs`：将 Basic Unit、Server Admin 插件、网页资产组成部署包，
`/admin/` 由 Server 转发到独立 Unit，现有后端 API 继续提供数据。
后端核心与 microserver 的执行运行时插件化仍是下一阶段；本运行时当前只装载 UI 插件。
