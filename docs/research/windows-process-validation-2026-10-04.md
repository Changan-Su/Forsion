# Windows 进程执行修复与验证（2026-10-04）

对应 [Issue #3](https://github.com/Changan-Su/Forsion/issues/3)。接入 `fix/win-console-popup` 分支的修复和控制台探针，并补齐 Windows 进程清理、桌面启动及开发环境问题。

## 修复范围

- `spawnHostShell` 在 Windows 使用 `detached: false` 与 `windowsHide: true`，保证控制台子程序的输出回到管道。POSIX 仍使用独立进程组。
- ACP 外部引擎同样禁止在 Windows 分离进程，避免调用方传入 `detached: true` 再次丢失输出。
- 前台命令超时/取消、后台停止/Ctrl-C、ACP 结束使用系统 `taskkill.exe /PID <pid> /T /F` 清理 Windows 进程树；参数不经过 shell。停止辅助进程自身也隐藏控制台。
- Windows 命令清理给 taskkill 5 秒，再留 0.5 秒等待管道关闭。实测 1 秒预算在并发启动 PowerShell/Electron 时可能过短，提前杀掉 taskkill 和 cmd 会遗留服务。POSIX 收尾时限不变。
- 桌面托管引擎、CLI 安装 PowerShell、Docker、Git 配置读取、浏览器辅助程序和 ffmpeg/ffprobe 补齐隐藏控制台选项。
- 修复 LCL 依赖链接：移除 Git 跟踪的生成链接，由 postinstall 创建。旧检出的失效链接或 `core.symlinks=false` 文本占位文件可自动修复为 Windows junction；保留真实依赖目录，不删除链接目标。
- 生成源码一致性检查忽略 CRLF/LF 差异，避免 Windows 检出后命令目录和数据库共享源码被误报为漂移。

## 本机验证结果

环境：Windows 11 Pro 10.0.26200，Node 22.22.3，Python 3.14.2，Git 2.47.1.windows.2。

控制台探针经 cmd.exe 启动真实 PowerShell 孙进程，结果如下；旧选项是负对照，运行探针时预期会短暂打开两个控制台窗口。

| 参数 | 可见控制台 | 孙进程输出 |
| --- | --- | --- |
| 旧：detached | True | 空 |
| detached + windowsHide | True | 空 |
| 修复：非 detached + windowsHide | False，hwnd=0 | stdout-reached |

真实进程测试验证了 Python/Node 输出 `42`、Git 版本输出、stderr/非零退出码、中文及空格路径、超时/取消后子进程退出、HTTP 端口释放、后台输出读取、stdin 中文回传和 Ctrl-C。Python `-u -m http.server` 的请求日志及停止后的端口释放也通过。额外启用 GUI 探针后，显式创建的 Windows Forms 窗口仍然可见。

| 验证组 | 通过 | 跳过 |
| --- | ---: | ---: |
| Windows 控制台、真实工具进程、ACP 启动 | 17 | 0 |
| 沙箱、浏览器、视频、ACP、Docker 生命周期和有界进程回归 | 89 | 28 |
| 引擎 Windows 持久化发布门禁 | 200 | 0 |
| 桌面 Windows 发布门禁、后端、CLI 和依赖链接 | 102 | 5 |
| 合计 | 408 | 33 |

跳过项来自现有测试的平台/环境条件。这是相关回归集合，并非全仓所有测试。

- 引擎 `npm run typecheck`、`npm run build`：通过。
- 桌面 `npx tsc --noEmit`、`npm run build`：通过。
- 构建后的 Electron 桌面使用隔离的中文/空格数据目录启动，真实托管引擎达到 `ready`，`/health` 返回 200，主界面成功加载。
- Electron 的 Node 子进程运行编译后的工具，Python、Node、Git 均返回正确输出及退出码 0。此检查不调用模型供应商。
- 工作流 YAML 解析、`git diff --check`、公开仓边界检查：通过。

## 复现

在仓库根目录的 PowerShell 中：

```powershell
cd tangu-agent
npm ci
npx vitest run src/sandbox/hostSandbox.winconsole.test.ts test/windowsProcess.test.ts test/acpEngineSpawn.test.ts
npm run typecheck
npm run build

cd ../desktop
npm ci
npx vitest run electron/backendManager.test.ts electron/backendRunner.test.ts electron/cliInstall.test.ts electron/lclLink.test.ts
npx tsc --noEmit
npm run build
```

如需验证显式 GUI 窗口，在 `tangu-agent` 目录运行：

```powershell
$env:FORSION_TEST_GUI = '1'
npx vitest run test/windowsProcess.test.ts
Remove-Item Env:FORSION_TEST_GUI
```

控制台与进程生命周期测试已加入 `build-desktop.yml` 的 Windows 发布门禁，以及独立的 `probe-win-console.yml`。

## 验证边界

- 本机未找到 Docker CLI；Docker 生命周期回归使用测试替身，未执行 Docker Desktop 真容器。
- 未切换系统默认终端到 Windows Terminal。GetConsoleWindow 探针仅能确认本机经典控制台行为，不能排除其他默认终端下的瞬时闪窗。
- 未重新安装已发布的 2.12.2；旧行为由原始 spawn 参数的真实子进程负对照复现。验证的是当前源码构建，未制作或发布新安装包。
- 未验证安装器 UAC 提权交互；环境安装入口保留其原有显示策略。
