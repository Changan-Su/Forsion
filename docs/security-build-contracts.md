# 依赖、发行与性能验证契约

关联 #271–#279。以下区分已接入的自动门禁与仍须真实发行/设备验收的部分；源码测试通过不等于历史安装包已更新。

## 依赖输入

| 依赖 | 固定版本/来源 | 范围 |
| --- | --- | --- |
| SheetJS CE | `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`，0.20.3 | desktop/web/mobile |
| ProseMirror View | override 1.42.3 | 三端全部传递实例 |
| Capacitor android/core/cli | 7.6.9 | mobile 原生工程 |
| MCP SDK | 1.32.0 | desktop/tangu-agent |

SheetJS 来源遵循[厂商安装文档](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)，npm 旧发布流不含补丁。lockfile 保存官方 tarball URL 与 SHA512 SRI；审核字节 SHA256 为 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`。这是审核字节的固定值，不是独立签名认证。保留包内 Apache-2.0 LICENSE/NOTICE。

ProseMirror override 是为消除 Milkdown 传递树中的受影响版本；退出条件是三端新锁树自然满足 >=1.42.3，并通过相同剪贴板回归。不要在尚未核对全部实例时删除 override。

`desktop/scripts/dependency-security.test.cjs` 从三个实际依赖根加载 EditorView，通过真实 `pasteHTML` 路径覆盖恶意 slice context、handlePaste true/false 和合法富文本/表格/链接/任务框/图片。测试使用受控 schema 与 happy-dom，**不是三端完整 UI 或 Android WebView 验收**。

工作簿解析在独立 worker 内执行，输入上限 20 MiB、时间 5 秒、32 个 sheet、每 sheet 500 行/100 列、总 HTML 2 MiB；超预算拒绝预览，关闭预览终止 worker，不分离调用方原始 bytes。输出自行转义单元格，只允许 http/https/mailto 链接。合法中文表名、多 sheet、日期、公式缓存值、超链接和畸形输入有回归；厂商公告没有提供可直接下载的攻击回归样本，本仓合成样本不冒称厂商 PoC。

## 原生 Android 验收

使用 `cd mobile && npm ci && npm run build && npm run sync:android`。同步前验证安装树/lock 中三个 Capacitor 包均为 7.6.9，将来源、integrity、WebViewLocalServer 源码摘要写入 `dist/forsion-native-materials.json`；cap sync 后进入 APK 的 `assets/public/`。

完整原生验收需要 JDK 21、Android SDK 35、模拟器或真机：

1. `cd mobile/android && ./gradlew assembleDebug -PnativePreview --no-daemon`（Windows 用 `gradlew.bat`）生成包名 `com.forsion.tangu.nativepreview` 的并装 debug 包；记录 APK SHA256，解包检查 `assets/public/forsion-native-materials.json`。完整 JVM 单测另运行 `./gradlew testDebugUnitTest --no-daemon`。材料清单只能证明构建输入，不能替代下一步行为验证。
2. 安装到隔离测试设备，以自有测试服务器提供只写测试标志的页面。测试顶层与 iframe 导航到 `https://localhost/_capacitor_http_interceptor_?u=<encoded-test-url>`，以及关闭/启用 CapacitorHttp 的情况。远程脚本不得在 app origin 执行或获得 native bridge。修复版 `WebViewLocalServer` 会排除 document 请求。
3. 再验外部浏览器打开、`tangu://auth-callback` 登录回跳、已注册深链接、本地文件预览。不要为测试改变正式 appId 或签名身份。

本次已在用户授权的独立 `work/android-toolchain` 安装并校验 Microsoft JDK 21.0.13.0.2、Android SDK 35/Build Tools 34.0.0、Gradle 8.11.1，接受 SDK 许可；环境变量、Gradle 缓存和 debug 密钥均限于本次工作区。整合主分支后的干净源码 `8dc00f5a9f665aee42e9e0a64f1f543b4e0fd25e` 重新完成 mobile build/sync，再运行 `gradlew.bat assembleDebug -PnativePreview --no-daemon --max-workers=2 --console=plain`，234 个任务执行成功（3 分 34 秒）。构建起止源码摘要一致：`d5c768aebc9425f0d87f9b23657ce74011b77ed4f833069499aa8d31f0e8f8ec`。

已交付 `forsion-nativepreview-debug-8dc00f5a.apk`（54,536,275 字节），SHA256 `7b42edfe991cbf628d5abd97f83b246acd74860491d895855ed957af0e6e096b`；`apksigner` 验证本地 Android Debug 证书/v2 签名通过，minSdk 26、target/compileSdk 35。内嵌 native 材料与同步资产逐字一致，三个 Capacitor 包为 7.6.9。`apkanalyzer dex code` 检查最终 APK：`Bridge.launchIntent` 在插件覆盖前拒绝代理前缀；`WebViewLocalServer.shouldInterceptRequest` 在 HTTP 代理前检查启用标志并排除文档；文档判定包含顶层请求和大小写无关的 `Upgrade-Insecure-Requests` 分支。另直接调用本次编译后的原生文档判定方法，5 个确定性输入均通过；该探针绕过 Android 服务构造，**不等于设备 WebView 行为测试**。APK 旁 `forsion-android-debug-validation.json` 保存工具链摘要、签名、DEX 反汇编、源码身份和边界。

尚无模拟器/真机验收，未运行完整 `testDebugUnitTest` 集合；顶层/iframe 实际导航、远程脚本/native bridge、登录回跳、深链接和本地文件预览仍需按上述步骤验证。产物仅为 debug 并装预览，未签生产包或发布；旧 APK 必须重新构建分发后才得到原生修复。

## 完整发行包与固定运行时

`desktop/build/runtime-manifest.json` 是受版本控制的 Node/Python/Git 平台输入清单，含固定 URL、版本、SHA256、来源证明与许可。Node 的摘要来自官方 SHASUMS256，Python/Git 来自官方 GitHub release asset digest；本次未验 Node checksum 的 detached signature。镜像只能返回同一固定字节。

三份下载器在写盘/解压前验证摘要。默认完整打包：网络失败、显式 skip、包内 `.skipped` 都拒绝；仅 `FORSION_ALLOW_INCOMPLETE_DEV_BUILD=1` 可允许本地开发降级，`FORSION_RELEASE_BUILD=1` 或 `TANGU_REQUIRE_*=1` 总是优先拒绝降级。摘要错误即使开发模式也拒绝。Linux Git 是明确的系统依赖；没有 agentBackend 的产品不会下载这些运行时。

afterPack 检查 Node 可执行文件及 npx 本体，运行 Python 原有库导入/渲染 probe 与 Git init/commit/HTTPS helper probe。已有 Python constraints、插件签名、引擎签名和 OIDC 发布链保留。

正式 workflow 使用 npm ci、固定 Node 24.22.1、锁文件内构建器版本；安装输入变更拒绝。高权限 action 钉 commit SHA；desktop workflow 仅 release job 有 contents:write/attestations/id-token。每个平台/发行版 build job 在本机生成唯一命名的材料清单并随产物上传，汇总 collector 另列自身环境，避免将汇总机器误写成构建机器。发布材料包括四份 lock、runtime manifest、Python requirements/constraints、源码 commit、构建器与产物摘要；`release-sbom.json` 明确是含开发依赖的 CycloneDX **源锁清单**，不是从安装包扫描的完整二进制 SBOM。GitHub release 额外用 OIDC 生成 artifact provenance。

不宣称 bit-for-bit reproducible：操作系统工具、pip 平台 wheel、签名/压缩时间戳及 runner 镜像仍可能变化。构建材料与实际安装包 probe 共同审查。

## PR 必需检查与独立引擎发布

新工作流 `.github/workflows/critical-contracts.yml` 的稳定 job 名是 **`critical-contracts`**。PR 无 paths 过滤，文档 PR 也会产生结论。`desktop/scripts/critical-contracts.cjs` 显式列举数据身份、CAS、watcher、切库 flush、HTTP、MCP、诊断、取消及依赖/发行回归；缺少任何文件即失败，避免拼错路径被 vitest 忽略。

管理员须在 main 分支 ruleset / branch protection 中：要求 PR、将 `critical-contracts` 设为 required status check（按实际首次运行的 app/context 选择）、要求检查基于最新 main，按团队政策配置审查数与管理员绕过；紧急绕过保留审计原因。先在候选 PR 故意破坏缓存身份/HTTP redirect 断言，确认 job 失败且 GitHub 禁止合并，再恢复。

2026-10-28 connector 读到 rulesets `[]`，经典 protection 查询 403。当前连接不能验证/修改该后台设置，未通过其他路径绕过权限；YAML 本身不会启用分支保护。上述后台步骤与真实 PR 负对照仍需管理员权限，不能标成已完成。

publish-engine 在准确 `$GITHUB_SHA` checkout 上执行 npm ci、完整 `npm run typecheck`（含同步契约）、完整 `npm test`、锁文件不变检查，再 build、sign、overlay E2E 和 publish。回归静态检查会捕获门禁被挪到签名之后；实际失败候选 tag 的 GitHub run 尚未触发（本轮未发布）。

## 性能基线

`CHROMIUM_EXE=<固定浏览器路径> HARNESS_URL=http://localhost:5297/harness.html npm run bench:baseline -- --out=<绝对路径>`，Windows 使用 PowerShell `$env:` 设置。通过现有 harness 启动器运行；测试时冻结 frontend 改动，避免 HMR 假结果。

报告记录 HEAD、dirty 状态、包含未跟踪代码的源码摘要、仪器摘要、CPU/系统/Node/浏览器、固定数据集 hash、热身和原始分布。场景是 1k/10k 内存笔记 corpus、两个浏览器 page、30 个输入样本、100 次切页、每 10 次强制 GC 的 renderer heap、long tasks 与后 50 次 heap 斜率。它不是 Electron 完整冷启动、真实磁盘大库、两个 OS 窗口或整机 RSS；模型/网络时间完全排除。

默认报告写入已忽略的 `desktop/outputs/performance/`；自定义报告必须位于仓库外或 Git 忽略目录，避免报告自身污染下一轮源码摘要。运行结束再次校验源码摘要，中途改码则报告无效。同源码同环境再跑，传 `--baseline=<第一份报告>`。比较拒绝源码/环境/数据集不一致；15% 是待校准的初始相对阈值，报告保留重复测量变化及样本方差，不把它当外部标准。负对照 `--inject-block-ms=80` 应返回失败并保留报告。异常内存增长会保存 `.heapsnapshot`；初始启发式阈值不代表泄漏已被排除。

搜索单独运行 `node tangu-agent/scripts/session-search-bench.mjs --synthetic 10000 10 --json <报告路径>`（cwd 为 tangu-agent 时省掉目录前缀），记录 3 次热身、15 次样本、LIKE/FTS 分开分布、固定 seed/hash 和源码身份；不用真实用户库。真实模型延迟与完整 Electron 启动/RSS 另建基线，不能混入以上局部结果。

自动验证命令：`cd desktop && npm run test:security-deps`；工作簿 vitest 为 `frontend/src/services/workbookParser.test.ts` 和 `workbookPreview.test.ts`；关键契约总入口为 `npm run check:critical`。全量测试只在合并/发布门禁执行。

## 本轮验收状态（2026-10-28）

| Issue | 已实现/自动验证 | 尚不在本轮证据内 |
| --- | --- | --- |
| #271 | 三端固定 SheetJS；worker 大小/时间/输出预算；7 个解析/生命周期/预算回归 | 厂商攻击样本、三端完整 GUI |
| #272 | 三根安装树与真实 EditorView pasteHTML 默认/自定义路径；合法富文本样本 | 三端真实用户 UI 粘贴 |
| #273 | 7.6.9 三包同步；mobile build/sync；隔离 debug APK 构建及签名/内嵌材料/真实 DEX 检查；5 个编译后文档判定输入通过 | 真机/模拟器导航、原生桥攻击和完整 JVM 单测集合 |
| #274 | 两份 SDK 锁与安装树 1.32.0；HTTP/MCP 契约由对应实现包提供 | 没有将 stdio 写为受公告影响 |
| #275 | 默认完整、显式dev降级、发行拒skip；三下载器故障/skip/篡改注入 | 三平台完整新安装包在干净设备的能力探针 |
| #276 | 固定16资产/来源/摘要；npm ci；最小权限；每构建机材料、源锁SBOM与provenance配置 | 真正发布执行及完整二进制SBOM；不声称逐字节可重现 |
| #277 | `critical-contracts` 稳定无路径过滤；最终131 runtime +78 desktop +17 Node，共226测试绿 | 管理员必需检查/审查规则启用与真实PR阻止合并 |
| #278 | 准确候选 SHA 的完整typecheck/test在签名前；保留签名与overlay门禁 | 未推失败候选tag或触发真实发布 |
| #279 | 同源码重复实测、分布与100切页heap斜率；80ms负对照正确失败；SQLite两规模JSON | 完整Electron启动/RSS、磁盘库、流式模型、多OS窗口长期基线 |

最终类型/构建：desktop typecheck（含契约同步）、desktop build、mobile build、native-materials 和 cap sync 全部通过。四根独立锁副本通过 `npm ci --dry-run --ignore-scripts`；故意让 manifest 要求 SDK1.29、lock 为1.32 时准确以 EUSAGE 拒绝。i18n 新键的键集/英文/使用检查通过，额外全扫描有4项疑似既有 Windows 路径归一化差异，未扩大本任务修改。

性能采样绑定候选工作树：base `5631b9a3569f6afee7e41f3657791a7129d46d17`，dirty=true，source SHA256 `83f3c07545695854eedb9ae991b204de17e2cf003ac5acd17126e924fba46fbb`；两份正常报告和负对照均通过结束源码复验。原始报告保存在本次工作目录（`performance-accepted1.json`、`performance-accepted2.json`、`performance-blocked80.json`、`search-accepted1000.json`、`search-accepted10000.json`），发布时须与此源码身份一并归档。

- 第一轮输入到两次rAF的 p95：1k场景11.4ms、10k场景11.6ms；样本变异系数约6.18%/4.85%。第二轮 p95 为11.5ms/11.4ms，变化+0.88%/-1.72%，没有超过暂定15%阈值。
- 注入80ms阻塞后两场景 p95 均81.6ms，比较器以exit1拒绝，报告保留失败原因。
- 100次切页后 renderer V8 heap净增加约1.63/1.64MB，后50次斜率约8.9/9.2KB每次。保留原始样本用于后续长期比较，不能据此宣布无泄漏或整个Electron内存已收敛。
- 搜索为1k/10k会话、每会话10消息；每条LIKE/FTS各15样本，模型网络完全排除。不要拿局部SQL或浏览器数据推断全应用速度。

单轮评审发现两项并已修复：输出HTML预算漏算标签/UTF-8字节；默认性能报告污染下一轮源码摘要。对应负对照/回归均保留。无本轮提交、推tag或发布行为。
