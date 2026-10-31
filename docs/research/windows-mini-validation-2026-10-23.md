# Windows Mini 拖边复验（2026-10-23）

对应 [Windows issue #23](https://github.com/Changan-Su/Forsion/issues/23)。本轮在 Windows 11（10.0.26200）运行隔离开发实例，未操作用户安装版或个人库，未发布桌面版本。

## 实际发现并修复

1. 贴左边折叠的卡片展开后拖右边，缩放起手会清掉吸附状态。松手、移开鼠标后卡片一直展开。现在仅在手势期间暂停吸附；原显示器、工作区与贴边仍相同时，松手恢复吸附。移开鼠标重新露出 14 DIP 把手，再进入还能展开。
2. 右侧 4px 缩放热区覆盖内容滚动条。可手动缩放的 Mini 现给内容右侧留出同宽空间，固定自动 Mini 不受影响。

## 验证与界限

- `npm run build`、`npm run typecheck` 通过。
- `node scripts/mini-card.check.cjs`：43/43，包括内容右边界不超过缩放热区左边界。
- `node scripts/mini-dock.e2e.cjs --scale=1.25`：46/46，包括展开后改宽、重新折叠到 14 DIP、再次展开；此台架的显示器拓扑／光标为测试夹具，不能代替物理混合 DPI。
- 原生鼠标另测实际三屏环境：主屏 150%，左屏 125%，右屏 125%。同一张卡片在主屏及左屏分别右边上拖 80 DIP，宽度均 360→280，高度保持 400；事件 `isTrusted=true`。主屏原生角拖可达到 260×160 最小尺寸。
- 在左屏 125% 上原生点击折叠把手、拖右边改为 280×400、移开鼠标，卡片重新折回仅露 14 DIP，再进入可展开。旧代码同手势不会折回，已保留失败记录。
- 在主屏 150% 的 360×400 长待办卡片上，用原生鼠标拖内容滚动条：`scrollTop` 约 125→945，窗口尺寸仍为 360×400；可信 down/up 目标为滚动容器，没有命中 resize grip。Windows 的覆盖式滚动条会淡出；最初两次在淡出后拖动命中了待办条目，未计为通过。保持滚动条显示后复验通过。
- 已查看真实窗口与自动台架截图。短时原生拖动可用，**不据此声称已完成连续缩放闪黑／残影视频验收，或最小／最大限界处持续拖动抖动验收**。这两项在 issue 保留待验。
- GPT-6.1-sol 对当前检出及相关辅助函数做聚焦评审，最终结果 `No findings.`。

## 留下的仪器

`node scripts/windows-open-issues.stage.cjs` 会创建临时库和 60 条夹具待办，启动真实 Mini 并输出 `STAGE_HOME`。它仅连接本机测试 stub；`runtime.json` 记录真实显示器、Windows 版本和初始几何；渲染器 `window.__nativeEvents` 记录可信输入。

向 `<STAGE_HOME>/command.json` 写入 `{"bounds":{"x":300,"y":224,"width":360,"height":400}}` 可准备跨屏测试位置；这一步是布置夹具，不能算原生拖动验收。操作完成创建 `<STAGE_HOME>/stop`，脚本关闭自己的实例和 stub。并行操作前按仓根 `gui-verify` 的 devlock 流程取得测试锁；默认 CDP 端口为 9451。

本轮原始证据临时目录：`forsion-win-open-jKwylT`（旧代码复现与原生 DPI）、`forsion-win-open-fAEsjq`（修复后折叠）、`forsion-win-open-KGNNzS`（最终滚动条）。这些本机临时目录不作为公开可下载 artifact。
