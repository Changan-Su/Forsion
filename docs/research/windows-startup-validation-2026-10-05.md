# Windows 树影开屏验证（2026-10-05）

对应 [Issue #6](https://github.com/Changan-Su/Forsion/issues/6)。基线为 main `60a7c984`，Windows 11 Pro 10.0.26200，Node 22.22.3，Electron 40。本报告使用隔离的用户数据目录，未更改系统显示比例、系统动画开关或用户的 Forsion 配置。

## 发现与修复

- 主窗口原先在 HTML 首次绘制前立即显示，原生底色是浅色。改为 `show: false`，在 `ready-to-show` 后显示；台架仍使用 `showInactive`。真实冷启动记录确认顺序是「创建时隐藏 → 首次绘制 → 显示」，暗色首个可见帧的采样像素为暗色。
- Windows 的 Segoe UI 行盒中心不等于大写字墨迹中心；未盖版本号的三个字标检查失败（基线 75/78）。按实际字体 TextMetrics 居中，修复后原有检查全部通过。
- 开屏检查只搜索 macOS 缓存，Windows 必须手配浏览器。新增跨平台浏览器查找，优先使用 Playwright，回退 Chrome/Edge，保留 `CHROMIUM_EXE` 覆盖。
- 增加 100% / 125% / 150% 的亮暗 DPI 检查、冷启动首帧探针以及 Windows CI；CI 上传开屏和设置流程截图。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm run check:splash` | 84/84：原 78 项及新增 6 项 DPI 检查 |
| `node scripts/startup-appearance.e2e.cjs` | 48/48：真实 Electron 设置、预览、素材、导入、插件清理、冷重启 |
| `npm run probe:startup-windows` | 28/28：六次亮暗冷启动、三档渲染缩放、首帧窗口事件和颜色、退场；亮暗减少动态效果媒体模拟 |
| 外观、窗口材质、主题偏好、Electron 台架入口单测 | 34/34 |
| `npm run typecheck` / `npm run build` | 通过 |

各档缩放的诗句与字标均在画内、在墙上，版本字标与树标对齐；截图检查了实际 Windows 字体。竖排书名号显示为竖向形式，长短句未压入窗光。既有脚本另覆盖 390×844 至 2560×1440 的画面尺寸，以及连开 14 次不连续重复的诗句选择。

设置流程覆盖默认树影、经典图标、Arioso、上传图标不改变默认树影、经典模式跟随图标、恢复默认及重启持久化。减少动态效果时画面完整静止并立即随首帧退场。

## 截图

以下为 Windows 上真实 Chromium 的默认树影；阻断应用模块以保留完整开屏，使用 1280×800 CSS 像素及不同 deviceScaleFactor。画面中的 9.8.7 是原有检查用的假版本号；真实 Electron 构建及设置预览验证的是 2.12.2。

| 渲染缩放 | 亮色 | 暗色 |
| --- | --- | --- |
| 100% | [截图](assets/windows-startup-2026-10-05/tree-shadow-light-100.png) | [截图](assets/windows-startup-2026-10-05/tree-shadow-dark-100.png) |
| 125% | [截图](assets/windows-startup-2026-10-05/tree-shadow-light-125.png) | [截图](assets/windows-startup-2026-10-05/tree-shadow-dark-125.png) |
| 150% | [截图](assets/windows-startup-2026-10-05/tree-shadow-light-150.png) | [截图](assets/windows-startup-2026-10-05/tree-shadow-dark-150.png) |

## 复现与未覆盖项

在 PowerShell 的 `desktop` 目录中：

```powershell
npm ci
npm run build
npm run check:splash
npm run probe:startup-windows
node scripts/startup-appearance.e2e.cjs
```

原始日志、首帧截图和事件/像素记录在 `desktop/outputs/windows-startup/`，设置截图在 `desktop/outputs/startup-appearance/`。GitHub Actions 的 `probe-windows-ui` 上传同样的产物。

- 系统动画开关未切换；验证的是浏览器/Electron 媒体偏好模拟。此 Electron 构建忽略了 Chromium 的减少动画命令行参数，因此探针使用 `emulateMedia`，并检查媒体偏好确实生效。
- 缩放由 Chromium/Electron 的渲染参数模拟，未切换 Windows 显示设置；未实测两块不同缩放的屏幕、跨屏启动及最大化启动期间的画布拉伸。
- 未在额外低配/集显设备上测流畅度，也未制作或发布安装包。

这些硬件及系统交互项仍需真机补验；本报告不将其计为通过。
