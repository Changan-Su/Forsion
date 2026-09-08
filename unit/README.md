# Forsion Unit

通用 Node 宿主复用 Genesis 渲染层和网页投射。Unit 持有唯一 HTTP 监听端口，
安装包决定它提供什么业务。完整 Server 插件将 API、微后端模块、管理视图和 Space
放在同一个包里；在服务器安装 Unit 和这个包即可运行 Admin，不需要另起 Forsion Server。
数据库等外部服务仍由部署环境提供。

## 发行与安装

```sh
node unit/build.mjs --package
# 将 unit/dist 搬到部署机；以下命令在发行目录中执行
node main.mjs init /absolute/path/unit-state --port 3001 --host 127.0.0.1 --base /admin/
node main.mjs install /absolute/path/unit-state/unit.json /absolute/path/server-plugin
node main.mjs migrate /absolute/path/unit-state/unit.json server-admin
node main.mjs run /absolute/path/unit-state/unit.json
```

发行目录包含 `main.mjs`、`backendWorker.mjs`、`package.json` 与 `web/`，只需 Node 20+
即可运行 Unit，不依赖 Electron、源码目录或开发环境的 node_modules。插件的原生依赖
必须匹配运行环境；完整 Server 包的构建命令见 Server 仓 `runtime/README.md`。
`init` 的版本取实际 Unit 产品版本，并生成持久身份，不覆盖已有配置。
旧形式 `node main.mjs unit.json` 仍可启动。

`unit.json` 的插件项可用目录字符串，或 `{ "path": "...", "enabled": true,
"config": {}, "env": {} }`。目录以配置文件为基准。业务参数通过环境变量、插件
`env` 或 `config.env` 配置；这些字段不会发送到浏览器。`dataDir` 存放独立于代码的
插件数据，更新保留。缺省回环监听，`UNIT_PORT` 可覆盖启动端口。

```sh
node main.mjs status /absolute/path/unit-state/unit.json
node main.mjs disable /absolute/path/unit-state/unit.json server-admin
node main.mjs enable /absolute/path/unit-state/unit.json server-admin
node main.mjs restart /absolute/path/unit-state/unit.json server-admin
# 相同插件ID的新包即更新；运行中的Unit会切换版本，启动失败会恢复旧版本
node main.mjs install /absolute/path/unit-state/unit.json /absolute/path/new-server-plugin
```

启停与更新使用本机控制通道，Unix socket 位于临时目录中按数据目录哈希命名的
用户专属目录（目录0700/socket0600），不发布为 HTTP 接口。添加新的插件需先停止 Unit；
已安装插件可在原端口启停或更新。迁移仅在插件未激活时执行。安装使用不可变版本目录，
旧版本保留；在线更新回复丢失时保留候选目录，避免清理仍在使用的代码。
`data/run.lock` 防止同一个实例被重复启动；崩溃后的旧 PID 锁会在下次启动时回收。
安装进程异常退出留下 `.install.lock` 时，确认没有安装进程后可删除此锁再重试。

## 插件契约

后端能力是现有插件 manifest 的可选字段，UI 和后端共享一个插件身份：

```json
{
  "id": "server-admin",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.js",
  "backend": {
    "apiVersion": 1,
    "main": "backend/src/unitPlugin.js",
    "dependencies": { "mode": "npm-ci" }
  }
}
```

`main` 是可选 UI 入口，`spaces/*/space.json` 提供空间配方。`requires` 可声明其他插件ID，
宿主按依赖顺序激活，逆序停止，拒绝重复身份、Space、冲突路由和循环依赖。
`minAppVersion`、插件API以及bundled依赖的平台/架构/Node ABI/Linux libc在安装时检查。
`npm-ci` 模式在插件 `backend/` 执行锁定生产依赖安装，Node路径跟随运行Unit的解释器。

后端默认导出工厂 `(context) => plugin`，详见 `backendTypes.ts`。工厂应无监听/定时任务副作用；
`start()` 完成初始化，`stop()` 释放资源，`migrate()` 执行迁移。`handle` 是 Node HTTP handler，
`mounts` 声明URL前缀，`upgrade` 可处理协议升级。宿主选择最长路径段前缀。
上下文提供包目录、数据目录、私有配置、取消信号、日志和请求重启钩子。

每次激活创建新的 worker thread，使用独立模块缓存与环境变量；Node HTTP请求通过进程内
MessageChannel/Duplex流转发，无第二个TCP监听端口。停止时先中断在途连接，再释放插件资源；
超时会终止线程。流式上传、SSE、连接升级及真实连接地址都会保留。
插件崩溃影响该插件，Unit控制与网页投射继续工作。Worker用于生命周期隔离，
可信后端插件仍具有运行Unit的OS用户权限，不构成恶意代码安全沙箱。

## 网页投射

`/admin/` 展示同一 Unit 的 Genesis 页面，页面来自安装插件的 Space；Server API
由同一个 Unit 监听端口分发。`/admin/unit`、`/admin/vault`、`/admin/engine` 保留给宿主，
插件不能覆盖。浏览器只获取UI字段和Space配方，不获取backend入口、依赖、env或私密配置。
业务鉴权由插件自己的API执行。引擎、主机文件、vault、配对和宿主配置写入不向公开访问者开放；
桌面Unit原有配对模式保持兼容。

## 账号与访问者数据

Unit 是框架宿主。账号接口属于宿主能力，具体身份验证由已安装的后端插件提供；
目前 Server 插件复用现有 Forsion 用户、密码校验、JWT 和撤销记录，不创建第二套账号表。
后端可贡献 `account: { metadata: { apiBase, loginPath }, resolve(token, { signal }) }`；
同一 Unit 仅允许一个账号提供方激活。`resolve` 返回经过验证的 userId、username、role
及 tenantId/workspaceId，私密字段不会进入网页。管理员权限取已签发令牌与当前数据库角色
的交集；降权、停用与退出不等待缓存失效。

网页复用 Web 的 BrowserAccount 和桌面 AccountCard；登录仍走现有 `/auth` 页面。
Unit 使用每实例、每标签页的 sessionStorage，登录回跳需匹配该标签发起的 state。
普通 Web 保留其既有账号存储方式。插件通过可选 `ctx.account` 使用 status/login/logout/
request/subscribe，不再自行保存投射访问者的登录令牌。Admin 插件原有远程连接模式继续可用。

`/admin/unit/account` 返回当前访问者身份，`/admin/unit/config` 的 GET/PUT 读取或更新
此访问者的偏好白名单，`/admin/unit/plugin-data/:id` 的 GET/PUT 读写插件文本数据
（PUT `{data:string}`，最大 1 MB）。每次请求验证身份，存储按账号提供方、用户、tenant、
workspace 与插件隔离，目录标识由宿主计算，客户端传入的用户/租户字段不能选择所有者。
数据位于 Unit dataDir 的 accounts 子目录；不读写宿主自己的偏好、vault 或凭据。
退出成功后吊销当前会话并刷新页面；换号重新挂载应用，旧请求、响应体和延迟回调均不能
进入新账号。退出网络失败会保留会话并报告错误。内容布局按访问者完整 scope 隔离。

当前交付的是个人 workspace（`personal:<userId>`）以及 Admin API 的角色边界，
不等同于组织、成员、共享资源 ACL 或所有业务插件已完成多租户迁移。后端插件仍须校验
其业务数据权限；已签发的独立 MCP 凭据不因网页登录退出而自动撤销。

## 验证

```sh
cd desktop
npx tsc --noEmit
npx vitest run electron/unitWeb.test.ts electron/basicUnit.test.ts electron/backendRunner.test.ts electron/unitRuntime.test.ts electron/unitInstall.test.ts
```

完整 Server 的独立 PostgreSQL 验收脚本位于 Server 仓 `scripts/verify-unit-installation.mjs`。
