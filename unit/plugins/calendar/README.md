# Calendar

日历与日程。本包声明并启用 Unit 内共享的官方前端实现，本地数据由对应运行时提供，云端数据可连接 Server 插件。
安装后刷新网页即可生效；通过 Unit CLI 管理启停和更新。

Native frontend contribution for Forsion Unit; requires the shared renderer in Unit 2.9.9 or later.


## Local Unit / 本地 Unit

本包不依赖 Server 才能激活。公开站点按已有账号和云适配器连接服务；本地工作区
通过完整发行包的运行时提供能力。构建 `node unit/build.mjs --package --local-plugins`
后安装 `unit/dist/plugins` 中的完整包。源码 manifest 只提供前端注册。

This package activates without Server. Public sites use the existing account and cloud
adapters. Local workspaces use the runtime in the complete distribution package; install
from `unit/dist/plugins` after building with `--package --local-plugins`. The source manifest
provides frontend registration only. See the Unit README for configuration and verification.
