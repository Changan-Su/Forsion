# Windows 拖拽与开屏性能补修（2026-10-06）

继续处理 [#6](https://github.com/Changan-Su/Forsion/issues/6)、[#7](https://github.com/Changan-Su/Forsion/issues/7)。本报告补充此前的[系统设置与原生验收](windows-native-validation-2026-10-06.md)，记录继续排查后修掉的两个实际缺陷，而不是把自动化通过当成未执行的人工验收。

环境：Windows 11 Pro 10.0.26200，Electron 40，RTX 5060；主屏 150%，左副屏及右竖屏 125%。所有应用测试使用临时用户资料和本地桩后端。

## 拖拽：从 Windows 原生 HTML 拖放改为指针捕获

旧代码明确存在取消歧义：在桌面、iframe 或 webview 上按 Esc 后收到的 `dragend` 和松手无法区分，可能误开窗；嵌入页面还会截走 `drop`。Windows Space 现在使用一个独立的指针手势：6px 阈值后显示拖影，捕获后续移动和释放；拖动期间遮住 guest 内容，命中 Ribbon 时临时穿透遮罩计算落点；Esc、丢失捕获和失焦取消。鼠标指针为 `grabbing`，不进入系统 HTML 拖放循环。

Ribbon 内排序仍使用原有槽位数学和持久化规则，浮层成员可以移入、移出或拖出开窗。跨区取消；普通点击和 Ctrl 点击保持原来的行为。释放时同步读取 Electron 主进程的系统鼠标 DIP 坐标，再沿现有多窗 IPC 开 Space，避免根据来源屏幕的缩放重复换算。

| 检查 | 结果和输入方式 |
| --- | --- |
| 主区释放、取消区、排序预览与提交 | Windows Electron DevTools 鼠标输入，三档 100% / 125% / 150% 全部通过；事件为 trusted PointerEvent，无 DragEvent。 |
| iframe、真正的 webview 上释放和 Esc | 同上，遮罩确保事件留在源渲染器。每次只打开一扇 Space，取消后移除遮罩、拖影和指针样式。 |
| 左右窗口边界之外释放、窗外 Esc | 同上，捕获的负坐标和视口外坐标正常提交或取消。此项不是 Sky 在桌面上的系统鼠标手势。 |
| 80% / 125% 应用界面缩放、收纳夹路径 | 同上；移入、从夹内拖出开窗、移回 Ribbon 均通过。 |
| 原生系统鼠标：Ribbon 内改序 | Sky 输入；Agents 从第二格移到末格，只有主窗，不开 Space。 |
| 原生系统鼠标：150% 主屏松手 | 系统鼠标 `(1236,700)`，Space 初始位置 `(1236,700)`。 |
| 原生系统鼠标：125% 副屏松手 | 窗口从主屏移到左副屏；渲染器 DPR 为 1.25。系统鼠标 `(-1344,789)`，已显示的 Agents 窗口位置同值，尺寸 1100×760。 |
| 原生系统鼠标：125% 副屏 webview 上松手 | 系统鼠标 `(-1494,689)`，已显示的 Space 窗口位置同值。 |

[原生事件及实际窗口记录](assets/windows-pointer-2026-10-06/native-events.json)、[主屏截图](assets/windows-pointer-2026-10-06/native-primary.png)、[副屏截图](assets/windows-pointer-2026-10-06/native-secondary.png)。截图来自 Electron 渲染器，原生标题和外框位置单独在记录中读取。

之前只尝试了跨屏摆放窗口的截图，本次完整放在副屏后成功捕获并操作，纠正了“副屏整体无法截图”的判断。Sky 的 `drag` 仍限定窗口坐标，且没有保持鼠标按下再按 Esc 的接口；没有将 DevTools 输入描述成人手同时操作。

DevTools 输入不会移动 OS 鼠标，自动化台架显式把主进程的鼠标快照固定为 `(800,650)`，验证 DIP 路由；原生 Sky 记录没有替换该 API。全部 [84 项输入检查及记录](assets/windows-pointer-2026-10-06/pointer-input.json) 和 [日志](assets/windows-pointer-2026-10-06/pointer-input.log) 区分这两种输入。

## 开屏：性能不足时降级为完整静帧

> 修订（2026-10-07）：本节的两条降级随 2.13.1 发出后，Windows 用户反馈开屏「闪一下就进去了 / 卡住 / 放不完」。原因有三：静帧一律「准备好就立刻移除」、不守最短展示也不淡出；软件合成是在显卡进程上报之前问的，那时 Chromium 对每项功能都答「禁用」，有显卡的机器也可能被判成软件合成；「连续慢帧」量的是主线程，而图层动画跑在合成线程上。下面「RTX 5060 没有误降级」那次验收把应用入口模块扣住了，量帧时主线程是空的，不代表自然冷启动。现行做法见仓根 `DESIGN.md`「开屏与品牌图标」的退场一条，仪器 `npm run probe:startup-trace`。

在软件合成、6 倍 CPU 限速下，原开屏虽正常退出，渲染器 RAF 记录在应用模块加载阶段出现秒级间隔。它不是合成器 FPS，但足以说明退场时仍可能出现卡顿。[修改前记录](assets/windows-pointer-2026-10-06/software-cpu6-before.json)。

现在 Windows 主进程向 preload 提供软件合成状态。默认树影在软件合成时直接显示完整静帧，位图长边从 1600px 上限降低到 960px；诗句和字标直接可见，云层不遮住画面，应用准备好后直接退出。启用硬件加速但连续 6 个可见帧里有至少 4 个间隔大于 50ms 时，也切到完整静帧。后台页面和单次慢帧不会单独触发降级。降级只针对树影，不覆盖用户选择的经典图标动画或素材。

真实 Windows 软件合成 + 6 倍 CPU 限速，亮暗各冷启动，14 项通过；静帧为 `performanceStill:software, animations:0`，位图 960×634，完整画面和退出均通过。[修改后记录](assets/windows-pointer-2026-10-06/software-cpu6-after.json)、[日志](assets/windows-pointer-2026-10-06/software-stress.log)、[亮色](assets/windows-pointer-2026-10-06/software-light.png)、[暗色](assets/windows-pointer-2026-10-06/software-dark.png)。为截完整场景，探针暂缓应用入口模块；图片不代表自然冷启动时长。

软件合成与 CPU 限速是资源受限的回归环境。本机仍不是低配 / 集显实体机，没有把它描述成那项人工验收。

## 验证

- 开屏三端 Chromium 契约：102/102，包含软件静帧、即时退出、连续慢帧及经典图标不受降级影响。
- Windows Electron 输入、多窗口、冷重启：84 项；原多窗契约 39/39；Ribbon 回归 70/70。
- 小窗口回归（`SPACE_INPUT_SCALE=1.5 SPACE_INPUT_HEIGHT=480`）：28/28。CI 的小屏幕放大后可能将全部 Space 收进「更多」；台架现在先通过正常 UI 展开，等待可点击图标，并确认命中 Agents 后才按下鼠标。收纳夹同样先从溢出区露出。
- Ribbon、Space、开屏相关单测：39/39。
- Desktop / Web / Mobile 类型检查、Desktop 生产构建、公共边界检查通过。Mobile 使用锁文件版本的 Capacitor 类型包，安装到独立临时目录后通过临时 tsconfig 的路径映射检查，没有改动项目依赖或锁文件。

原生 OS 按住鼠标期间 Esc、从静止窗口跨到桌面或另一屏再释放、低配 / 集显实体机流畅度，仍需要对应的人工输入或设备；当前这些路径的代码行为已经由 Windows Electron 输入回归覆盖。原始 issue 人工清单中未执行的项目仍应如实保留，不把缺少验收等同于代码没有继续修。
