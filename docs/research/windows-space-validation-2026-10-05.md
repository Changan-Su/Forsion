# Windows Space 窗口与 Ribbon 验证（2026-10-05）

对应 [Issue #7](https://github.com/Changan-Su/Forsion/issues/7)。基线为 `feat/space-window-recent` 的 `021d2cb8`；该功能尚未合入 main，所以本修复以功能分支为目标。环境为 Windows 11 Pro 10.0.26200、Node 22.22.3、Electron 40，使用隔离的应用配置及桩后端。

## 发现与修复

- Space 窗口创建时就显示，首帧前会露出原生浅色背景。改为创建时隐藏，`ready-to-show` 后显示；重复打开仍复用同一扇窗口，尚未绘制的窗口不会被提前显示。
- 将窗口调整为 `(120,90), 820×620` 后重启，基线实际回到 `(1370,685), 1100×760`。原先的 `moved/resized` 监听没有覆盖 Windows 程序化修改；改用 `move/resize`，并在退出前直接读取存活窗口的大小位置、同步原子写入小型状态文件，覆盖 400ms 防抖尚未落盘的快速退出。
- 125% 渲染缩放下，已保存的 `820×622` 原生外框在重新创建时变成 `823×627`。在 Windows 原生边框建立后、显示窗口前重新应用目标外框，按测得的尺寸余量做有限次修正，避免反复恢复时尺寸累计增长。
- 应用整体退出时保留 Space 恢复记录；用户主动关闭则在 `close` 时记录意图，避免随后退出和 `closed` 回调的时序影响恢复结果。启动尚未读取状态文件就退出时，不会用空数组覆盖旧记录。
- Ribbon 浏览器检查原先只查 macOS 路径，并通过 `npx` 启动 Vite。补充跨平台浏览器查找，在 Windows 直接用 Node 启动 Vite；保留 `CHROMIUM_EXE` 覆盖。
- 增加 Electron 输入、窗口生命周期、冷重启检查和 Windows CI。输入检查独立顺序运行，并确认主窗口取得焦点，避免后台原生窗口丢失拖拽输入。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm run e2e:spacewindow` | 36/36：Ctrl、右键、复用、独立布局、最近使用、设置、异步用户 Space 等；其中拖拽使用合成事件 |
| `npm run e2e:spacewindow-input` | 36/36：100% / 125% / 150% 渲染缩放下的输入与重启检查 |
| `npm run e2e:ribbon` | 70/70：Ribbon 排序、收纳、浮层、滚动；拖拽部分使用合成事件 |
| `npm run check:homeslot` | 7/7 |
| `npm run check:spacerestart` | 3/3 |
| `npm run check:spacefallback` | 62/62：插件晚加载、故障、回落、用户主动导航和布局归属 |
| Space、Ribbon 注册表、台架入口单测 | 60/60 |
| 桌面类型检查、构建、公开边界、workflow YAML | 通过 |

新增输入检查使用 Playwright 的鼠标和键盘 API，由 Chromium 产生 `isTrusted=true` 的 `dragstart/drop/dragend`，没有自行 `dispatchEvent(new DragEvent(...))`。它覆盖拖到主区、24px 边缘取消、Esc 取消、落点坐标、接受 move 的反馈、标题、无 Ribbon、主窗口活动 Space 不变，以及独立布局关窗重开。还检查创建时隐藏、首帧后显示、立即退出后的单窗恢复、大小位置和已修改布局、主动关窗后的恢复记录删除。

原有多窗口检查在 Windows 使用 Ctrl：右键菜单和主位槽入口通过，同一个 Space 复用已有窗口；最近使用图标按新到旧排列，窗口缩矮时从三个减少到零，设置的 1、5、不显示均即时生效。还覆盖插件 Space 异步就绪、主页窗口打开磁贴，以及不可用 Space 的等待说明。

这属于真实 Windows Electron 上的浏览器输入自动化。Playwright 会拦截 Chromium 拖拽并通过调试协议传递落点，因此可信事件不等于人工使用系统鼠标完成了跨窗口、跨屏拖放。

## 截图

以下是 Windows Electron 渲染器截图，未包含原生标题栏；标题另由 BrowserWindow API 验证。

- [Space 窗口](assets/windows-space-2026-10-05/agents-100.png)：独立的 Agents 布局，没有 Ribbon。
- [较高主窗](assets/windows-space-2026-10-05/ribbon-recent-tall.png)：中间有三个淡色最近使用图标。
- [较矮主窗](assets/windows-space-2026-10-05/ribbon-recent-short.png)：最近使用区让出空间，不挤压上下区。
- [设置](assets/windows-space-2026-10-05/settings-ribbon-recent.png)：数量设置即时生效。

## 复现及仍需手验的项目

检出本分支，在 PowerShell 的 `desktop` 目录中按顺序运行：

```powershell
npm ci
npm run build
npm run e2e:spacewindow
npm run e2e:spacewindow-input
npm run e2e:ribbon
```

不要在构建结束前启动检查；输入台架运行期间不要并行运行其他会显示 Electron 窗口的台架。截图及输入/窗口事件记录在 `desktop/outputs/spacewindow-input/`，Windows workflow 会上传此目录。

以下尚未验证，不能将 Issue #7 的对应人工清单勾为完成：

- 人工鼠标在桌面或另一块屏幕上松手，以及操作系统实际显示的拖拽指针。
- 拖到内置浏览器 webview 或插件 iframe 上的系统拖放行为。
- Windows 显示设置的 125% / 150% 与混合 DPI 多屏；本次仅使用 Electron 的渲染缩放参数。
- 人工拖动标题栏和窗口边缘、操作所有 Space 的侧栏及底部面板的完整体验。

原有脚本的窗外拖拽通过，只说明合成事件契约通过，不作为窗外系统拖放的证据。
