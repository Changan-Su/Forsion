# Windows 原生验收补充（2026-10-06）

对应 [#6](https://github.com/Changan-Su/Forsion/issues/6)、[#7](https://github.com/Changan-Su/Forsion/issues/7)。基于 main `a3ff47a3`（2.13.0），包含已经合并的 [#8](https://github.com/Changan-Su/Forsion/pull/8)、[#9](https://github.com/Changan-Su/Forsion/pull/9)。本轮继续执行之前报告中未做的真实 Windows 系统设置、原生输入和多屏启动项目，并修复新复现的两处问题。

环境为 Windows 11 Pro 10.0.26200、Electron 40、NVIDIA RTX 5060。使用临时用户数据、桩后端；未接触用户 Forsion 数据。通过 Windows 设置界面切换主屏 100% / 125% / 150% 和系统动画开关，结束时恢复主屏 150%、3840×2160、动画开启。

| 实际显示器 | Electron DIP 边界 | 原始系统缩放 |
| --- | --- | --- |
| 主屏 `2065300372` | `(0,0), 2560×1440` | 150% |
| 左副屏 `4240291700` | `(-2048,285), 2048×1153` | 125% |
| 右侧竖屏 `3612653111` | `(2560,287), 864×1537` | 125% |

## 新复现并修复的缺陷

**系统动画关闭仍播放开屏。** Electron 主进程的 `systemPreferences.getAnimationSettings().prefersReducedMotion` 为 `true`，渲染器的媒体查询却仍为 `false`。preload 现在向初始开屏和设置预览传递原生偏好，与媒体查询合并；完整静止画面不播放内部动画，应用准备好时立即移除开屏。本机关闭系统动画后的亮暗冷启动记录均为 `mediaReduce:false, nativeReduce:true, reduce:true, animations:0`，静止画面、诗句和退场通过 14 项检查。这项系统偏好单独读取，不写入用户素材配置。

**快速拖拽在 Ribbon 边缘误开窗。** Windows 原生输入先发出坐标全为零的 `dragleave`，随后在边缘取消区发出 `dragend`；旧代码把留下的 `gone` 状态当成窗外释放。现在最终落点处于 Ribbon 或浮层周围的取消区时不执行补开窗。原生 125% 输入复测只留下主窗，拖到主区仍开窗。新增全零 `dragleave` 回归；原始事件和窗口结果见 [记录](assets/windows-native-2026-10-06/drag-native-125.json)。

## #6 开屏逐项结果

| 原 issue 项目 | 结果与证据 |
| --- | --- |
| 亮暗冷启动、树影首帧、暗色白闪 | 通过。创建时隐藏，首次绘制后才显示；首个可见帧取样符合亮暗主题，初始场景无经典图标。实际系统三档缩放分别 12 项通过。首帧事件和像素存入各目录 `results.json`。 |
| 宋体竖排、书名号、长短句 | 通过。实际 Windows 字体截图文字清楚，书名号竖向，诗句和字标均在画内、未压入窗光；五句和不连续重复由开屏检查覆盖。 |
| Segoe UI 字标及真实版本号 | 通过。真实构建为 `2.13.0`；字标上下两行与树标等高。字形对齐的 TextMetrics 检查继续通过，附原生字标区域截图。 |
| 系统 100% / 125% / 150% | 通过。三次均切换 Windows 显示设置，探针未传 `force-device-scale-factor`，并断言真实 `devicePixelRatio`。 |
| 最大化启动 | 通过，12 项。窗口在首次绘制后最大化，图层与文字无明显变形，见 [暗色](assets/windows-native-2026-10-06/maximized/dark-1.5.png)。 |
| 主屏 150%、副屏 125% 启动 | 通过，12 项。在左副屏创建隐藏窗口后启动，实际渲染比为 1.25，见 [亮色](assets/windows-native-2026-10-06/secondary/light-1.25.png)。 |
| 系统动画关闭 | 复现后修复，原生设置验收 14 项通过，见 [静止画面](assets/windows-native-2026-10-06/os-reduced/light-1.5.png)。 |
| 设置默认、预览、经典、Arioso、上传、恢复默认、重启 | Windows 真实 Electron 设置流程覆盖，结果见下方脚本表及 [先前报告](windows-startup-validation-2026-10-05.md)。本轮包含新的原生减少动画偏好。 |
| 低配 / 集显机器流畅度 | **未完成：本机为 RTX 5060，没有额外低配硬件。** 已补软件合成路径冷启动，不能替代该硬件验收。 |

### 系统缩放截图

这些图片来自真实 Windows Electron 合成器。为了拍到完整树影，探针暂缓应用入口模块，等待开屏绘制后截图，再释放模块验证正常退场；图片用于字体和场景验收，不代表自然启动耗时。首帧截图另外在原生 `show` 时捕获，不等待完整场景。

| 系统缩放 | 亮色 | 暗色 | 字标区域 |
| --- | --- | --- | --- |
| 100% | [场景](assets/windows-native-2026-10-06/os100/light-1.png) | [场景](assets/windows-native-2026-10-06/os100/dark-1.png) | [字标](assets/windows-native-2026-10-06/os100/light-1-brand.png) |
| 125% | [场景](assets/windows-native-2026-10-06/os125/light-1.25.png) | [场景](assets/windows-native-2026-10-06/os125/dark-1.25.png) | [字标](assets/windows-native-2026-10-06/os125/light-1.25-brand.png) |
| 150% | [场景](assets/windows-native-2026-10-06/os150/light-1.5.png) | [场景](assets/windows-native-2026-10-06/os150/dark-1.5.png) | [字标](assets/windows-native-2026-10-06/os150/light-1.5-brand.png) |

125% 字标区域放大展示（原生截图的显示放大）：

<img src="assets/windows-native-2026-10-06/os125/light-1.25-brand.png" width="534" alt="Windows Segoe UI 字标及 2.13.0 版本号" />

## #7 窗口与拖拽逐项结果

| 原 issue 项目 | 结果与证据 |
| --- | --- |
| Ctrl 点击、右键打开与复用、主位槽菜单 | Windows Electron 输入 / 多窗口检查通过；本轮也用原生输入操作右键菜单。主窗保持当前 Space，每个 Space 一扇窗。 |
| 系统标题栏、无 Ribbon、侧栏与底栏 | 原生 125% 操作验证 Agents 标题、独立窗口、左右侧栏及底栏开合。附 [渲染器截图](assets/windows-native-2026-10-06/space-native-125.png)，该图片不包含原生标题栏。 |
| 关窗重开保留布局 | 原生操作改变侧栏 / 底栏后，通过标题栏关闭并重开，面板集合和侧栏状态保持。JSON 属性次序变化不视为布局变化；前后记录在拖拽 JSON。 |
| 应用退出重启恢复 Space、大小位置及布局 | Electron 输入台架在 100% / 125% / 150% 渲染比下全部通过；立即退出和用户主动关闭也覆盖。详见 [先前报告](windows-space-validation-2026-10-05.md)。 |
| 原生快速拖到主区 | 本机系统 125% 通过。释放后 Space 原生窗口初始位置 `(1492,845)` 与 `screen.getCursorScreenPoint()` 一致。该手势只产生 dragstart / dragleave / dragend，走补开窗路径。 |
| 原生快速释放于 20px 边缘取消区 | 复现后修复，系统 125% 通过；新增合成回归通过。 |
| 条内重排、主区接受 move、Esc 取消 | 浏览器输入 / 合成契约检查通过。**本轮原生手势工具未产生 dragover/drop，也无法按住鼠标期间再按 Esc，未完成原生验收。** |
| 桌面、另一屏释放与实际系统指针 | **未完成。** 原生工具拒绝窗外落点；跨屏窗口截图只返回主屏可见部分，无法据此操作副屏 Ribbon。未将合成窗外事件当作系统拖放证据。 |
| 内置浏览器 webview / 插件 iframe 原生落点 | **未完成。** 现有自动化覆盖补开窗契约，未用原生手势验证目标视图。 |
| 实际 125% / 150% / 混合 DPI 拖拽位置 | 原生 125% 主区落点通过；三档浏览器输入落点通过；**跨屏原生拖放仍需补验**。开屏跨屏启动结果不用于替代拖放结果。 |
| 最近隐藏 Space 新到旧、淡色、缩矮不重叠、设置 1 / 5 / 不显示 | Windows 真实多窗口、Ribbon 检查通过，先前报告附高低窗口与设置截图。 |

## 自动化结果与复现

当前分支的本轮结果（实际系统参数与渲染器模拟分开记录）：

| 检查 | 结果 |
| --- | --- |
| `npm run check:splash` | 90/90；新增三端原生偏好桥接与经典 / 自定义动画停止检查 |
| `npx vitest run electron/startupAppearance.test.ts` | 4/4 |
| `npm run e2e:spacewindow` | 38/38 |
| `npm run e2e:spacewindow-input` | 36/36，浏览器调试协议输入，三档渲染比 |
| `npm run e2e:ribbon` | 70/70 |
| `node scripts/startup-appearance.e2e.cjs` | 48/48 |
| 默认 `npm run probe:startup-windows` | 28/28 |
| 系统三档冷启动、最大化、副屏 | 每组 12 项 |
| 真实系统动画关闭 | 14 项 |
| 软件合成冷启动 | 12 项；`gpu_compositing:disabled_software` |
| `npm run typecheck`、`npm run build` | 通过 |
| 公开边界、workflow YAML、台架启动入口单测 | 通过；边界脚本使用 Git Bash，避免 WSL 对 Windows worktree 路径的误解 |

本轮 [开屏日志](assets/windows-native-2026-10-06/logs/splash.log)、[设置日志](assets/windows-native-2026-10-06/logs/settings.log)、[多窗口日志](assets/windows-native-2026-10-06/logs/space.log)、[浏览器输入日志](assets/windows-native-2026-10-06/logs/input.log)、[Ribbon 日志](assets/windows-native-2026-10-06/logs/ribbon.log)、[默认冷启动日志](assets/windows-native-2026-10-06/logs/startup.log) 随报告保存。

软件合成时记录 renderer RAF 间隔，供比较；它不等于合成器帧率，包含入口释放及应用初始化阶段，不能推导低配真机体验。没有以这项记录关闭低配验收。

新增探针选项只读系统信息并控制隔离的测试窗口，不更改系统设置。先 `npm run build`；普通 `npm run probe:startup-windows` 仍检查 28 项。若要验证真实系统缩放，先在 Windows 设置里调整，再运行：

```powershell
$env:STARTUP_SYSTEM_SCALE='1.25'
npm run probe:startup-windows
# 可选：STARTUP_DISPLAY_ID=<实际显示器 id>、STARTUP_MAXIMIZED=1
# 系统动画已关闭时：STARTUP_SYSTEM_REDUCED=1
# 软件合成路径：STARTUP_SOFTWARE_GPU=1
```

关闭或清除上述环境变量后再运行默认探针。不要并行启动多个会取得焦点的 Electron 输入台架。所有提交的图片仅含隔离 Forsion 窗口；系统设置中的个人资料不上传。

#3 的 Windows console / 输出 / 进程树修复已经在 main，issue 已关闭；先前复测 14 项通过、1 项可选 GUI 默认跳过，显式 GUI 检查另行通过。

## 尚需外部条件

当前代码缺陷均已修复并有回归。#6 保留低配 / 集显实机项目；#7 保留窗外 / 跨屏 / webview / iframe 原生拖放、系统指针及连续拖动取消体验。这里列出的限制是实际缺少设备和输入能力，未以「自动化通过」代替未执行的真机项目。
