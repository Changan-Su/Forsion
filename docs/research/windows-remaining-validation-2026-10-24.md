# Windows 剩余项目续验（2026-10-24）

环境：Windows 11 10.0.26200，Electron 40.10.2。真实三屏为主屏 150%、左屏 125%、右侧竖屏 125%。每个台架使用临时 profile、库和测试后端。未改用户安装版、未发布桌面版本、未部署生产服务。

## Mini：连续缩放的跳缩与方角

用户原生拖动报告“边缘跳缩，缩小到接近极限有闪烁和圆角消失”。这轮按真实失败处理，#23 保持开放到修复验收完成。

- 原生窗口一次改尺寸约耗时 20–30ms，鼠标消息可每 6–12ms 到达。旧实现逐条执行，积压旧坐标，放手后仍追赶旧尺寸。现在每帧只保留最新位置；松手先提交最后的坐标并同步 flush，关闭或重载取消未执行的位置。
- 合并更新后仍有方角。实际桌面合成录像发现，Windows 用缩小的 HWND 裁剪上一次较大的 Chromium 帧，不能从 DOM 截图检出。现在在尺寸切换前保留两种尺寸共同的圆角区域，切换后写入新尺寸的圆角区域。圆角读自当前主题和实际界面缩放；空闲时切换主题/缩放会清掉旧遮罩，贴边折叠仍由原有掩膜接管。
- 合并更新但没有原生遮罩：479 个 30fps 分析帧中 58 帧出现方角。仅切换前设遮罩仍有 2/840 帧；尺寸切换前后均处理后，同样的五轮连续缩放为 0/840。画面只录自己的深色背景与测试卡片，未录个人桌面内容。此循环通过真实产品 IPC 驱动，**不冒充系统鼠标输入**；用户的原始失败和 Sky 原生拖动另记。
- 正式构建原生鼠标复验：主屏 150% 和左屏 125% 均能将卡片缩到 260×160，实际 `devicePixelRatio` 分别为 1.5、1.25，圆角保留。此前四边共八次原生拖动记录在本地 `outputs/windows-issues/mini-four-edges.json`。
- `mini-card.check.cjs` 43/43；`miniResizeQueue`、`miniResizeShape`、`windowGeometry`、`miniDockMotion` 合计 27/27；生产构建与 `tsc --noEmit` 通过。

仪器：`node scripts/windows-open-issues.stage.cjs` 准备真实卡片；`node scripts/mini-resize-video.check.cjs <自己的合成录像.mp4> --expect-rounded` 检出静态截图漏掉的方角帧。后者要求 ffmpeg 在 PATH，输入必须只包含深色夹具背景和浅色卡片。原始视频不入库。

## 谛听：Windows 最小化让音频时钟变慢

初次三段长录音发现真实失败：最小化 330 秒，转写时间轴只推进约 215 秒；PCM 总样本与 `AudioContext.currentTime` 同时变慢。阻塞渲染线程的负对照未复现丢样，AudioWorklet 试验也未修复，因此没有交付该试验。

独立原生探针排除了插件、调试器焦点模拟、页面后台节流开关与防休眠开关。保护浏览器主进程的计时策略在启动期无效；音频图所在的渲染进程必须单独设置。当前修复仅在 Windows 11 为自己的主窗口渲染 PID 保留已有计时精度请求，保留其他电源策略位，不申请更高精度、不改整机电源设置。失败只记诊断，不阻止应用启动。

依据：[Microsoft SetProcessInformation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation) 的计时精度策略，以及 [Chromium 上游 Windows 音频计时修复](https://chromium.googlesource.com/chromium/src/+/3360a371841ced66376ad938e9343617371898bb)。本机实际失败/通过数据是判断依据。

- 独立探针：原生最小化时 20 秒通常仅收到约 13 秒 PCM；保护渲染 PID 后 20.003 秒收到 19.968 秒非静音 PCM，原生 minimized=true、visible=false、页面 hidden。
- 真实谛听短流程 40/40：含实际最小化、托盘、Mini 记笔记/暂停/继续、110%/125% 实际 UI 缩放及菜单/控件未裁切、真实强退并用同一 profile 重启后已识别文字保留。另跑严格 hidden 的 330 秒最小化及其余功能，39/39；墙钟 330 秒、时间轴推进 330.0 秒，页面 hidden→hidden、原生 minimized=true。
- 首次完整长流程里切 Space 的 330 秒推进 331.0 秒；托盘长录、三种媒体导入通过。最小化时虽然 340 秒推进 340.2 秒，但页面仍自报 visible，严格 hidden 断言失败，不能当作该条件通过。台架现先明确关闭 CDP 焦点模拟再断开；上述 39/39 是修正后的独立重跑。首次长流程末尾的 125% 也受旧版 Ribbon 定位脚本影响中断，未冒充整套成功。
- 英文 WAV 必须配 `DITING_TARGET=zh`。此前英文到英文触发正确的同语种跳过，产生的翻译断言失败不能当产品故障。125% Ribbon 仍会虚拟化尾部，台架现实际滚动找目标，不能把不在 DOM 里的按钮当插件未加载。
- 真实 125 秒 MP3/M4A/MP4 已分别完成解码、转写、原文件落盘，每份约 23 句；不等价于真实麦克风。
- 用户明确表示暂不能配合真实麦克风说话、拔插和权限流程，这些保持待验，#1 继续开放。

仪器：`DITING_WAV=<本地PCM文件> AUDIO_PROTECT_AFTER_CAPTURE=1 AUDIO_PROTECT_RENDERER=1 AUDIO_MODES=minimized npm run probe:windows-audio-clock`；插件 `verify/smoke.cjs` 的 `WINDOWS_EXTENDED=1`、`SPACE_MS`、`HIDE_MS` 和 `MEDIA_DIR` 扩展实际窗口/落盘验收。

## 应用和窗口引用

`npm run check:windows-apprefs-desktop` 最终 14/14。临时复制 Electron 运行时并改名为独立的 `WindowsAcceptance.exe`，两扇真实原生窗口分别在主/副屏。实际渲染聊天里的引用芯片，目标自身的原生焦点、最小化状态和几何证明切换生效，没有只信 PowerShell 回执。

覆盖：点击约 763/946ms 获焦、最小化后还原、多屏原位置/尺寸保持、标题改变仍找到、Forsion 退出再开后旧标题回退到现有应用窗口且不多开、16 枚闲置芯片 65 秒内实际 PowerShell 启动数为零。最初计数器仅替换 CJS 导出，观测不到生产 ESM 命名导入；评审要求修复后，用真实 list 请求先观察到两次启动，随后才计闲置的零次。

此前实际应用枚举为 28 窗口/290 应用、冷约 4374ms/热约 982ms，计算器启动/图标/运行状态已通过。全局左右 Ctrl、管理员窗口、虚拟桌面及十分钟 IME 干扰仍不能据此勾选；#25 保持开放。用户安装版当前持有自己的 helper，本轮没有擅自退出它或改其快捷键。

## 更新下载

`FORSION_UPDATE_INSTALLER=<官方真实NSIS文件> npm run check:windows-updater` 5/5。以官网实际 2.13.7 的 461841453 字节 PE 安装包测试真实 NsisUpdater：官网 provider、302 跳转、正确 SHA512、错误哈希拒收、Generic latest.yml 下载。逐流读取与散列，不把大文件塞进 base64 IPC。安装入口在测试中明确禁用。

SHA512：`L6xNl/Mx7ZDlRElNMjM45n4XavlxJQNtZqeXAdcINguLVixsr6LOhBL2Sf68hqIDbEAvldhqCds4zd4BoT78HQ==`。

官网线上记录仍无 sha512，因此官网双源完整验收缺生产前提。真实旧安装版 quitAndInstall、NoExtend 与双源切换仍待验；没有用标准安装包的临时 `/D` 路径冒充安全隔离安装，因为它仍会改用户真实协议/安装登记。#57 保持开放。

## 其他边界

#13：当前正式精确依赖已有 ComputerUse 0.7.1，旧“等 0.7.0 发布”的阻塞说明已失效。新仪器 `computer-history-windows.stage.cjs` 先排除当前窗口的所有应用，再用自己的独立可执行文件和库验证；查询进程名显式用 UTF-8，避免中文 exe 被 Windows PowerShell 的本地编码破坏。

本机 Sky 输入实测：`Forsion, 中文验收.exe` 里的 `CommaChineseNative42` 被采集，按完整 exe 名排除后真实输入的 `ExcludedNative99` 未采集；未排除时假密码 `FakePasswordNative77` 未采集。真正记事本打开自己的临时文本文件，`NotepadNativeCapture42` 被采集，排除 notepad.exe 后实际显示的 `NotepadExcluded99` 未采集。检查保留普通文字的正对照，不能仅用空结果证明排除有效。

Chrome/Edge 的普通页面与网址去参、真实锁屏、真正 agent 来源仍待验。浏览器连接器创建的测试标签未出现在本机可见窗口里，已关闭；随后本机 Computer Use 无法可靠确认 Windows 浏览器 URL，工具强制终止本轮桌面操作。Shell 启动 Chrome 的尝试也被自动审批拒绝，仅返回 blocked by policy；没有绕过限制。已停止自己的采集实例，未操作用户安装版 helper。

#17：临时路径真实 .lnk/ICO 检查不能替代安装版桌面/开始菜单/任务栏外观、重启、覆盖安装和所有用户安装。未完成项不能关闭。

## 评审与剩余交付门槛

GPT-6.1-sol 聚焦评审发现三项 P2：跨 DPI 后旧原生遮罩、ESM 调用计数假绿、独立音频探针默认保护错 PID。三项均已修正；后两项重跑通过。Mini 现在在普通拖动开始、空闲尺寸变化和主题/缩放同步时清旧遮罩；本轮工具终止后无法继续原生复验该跨屏清理路径，因此不能把它记成通过。用户对新版 Mini 的再验问题尚无答复。#23 继续开放，代码以待验收状态提交。
