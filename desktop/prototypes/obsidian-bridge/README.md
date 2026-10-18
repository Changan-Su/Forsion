# Obsidian Bridge moved / Obsidian Bridge 已拆仓

Plugin source, bundles, checks and compatibility documentation now live in the independent repository:

插件源码、构建产物、检查脚本与兼容文档已迁往独立仓库：

https://github.com/Changan-Su/forsion-plugin-obsidian-bridge

Local checkout / 本地检出：`Forsion-Instrumentality-Project/forsion-plugin-obsidian-bridge/`.

Desktop retains public host APIs and Electron integration harnesses. The `build:obsidianbridge`, `check:obsidianbridge`, `check:obsidianexpanded`, `e2e:obsidiannative` and preview commands resolve the external repository. Set `OBSIDIAN_BRIDGE_ROOT` if it is checked out elsewhere. A missing checkout fails explicitly; no bundled fallback is maintained here.

Desktop 只维护公共宿主 API 与 Electron 集成测试。上述命令会查找独立插件目录；其他位置通过 `OBSIDIAN_BRIDGE_ROOT` 指定。缺少检出会明确报错，不在宿主仓维护第二份插件实现。
