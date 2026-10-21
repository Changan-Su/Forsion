# Windows Issue 验证与修复（2026-10-20）

本轮以 `origin/main` 的 `ed5d7707` 为基线。Windows 11 10.0.26200、Node 22.22.3、Electron 40.10.2；随包 Computer Use 为正式 npm 0.7.1 / recorder protocol 13。测试配置、库、快捷方式与更新下载缓存全部隔离。

## 实际修复

- **#70：混合旧/新路径导致重复记录。** 同时存有 `夹\笔记.md` 与 `夹/笔记.md` 时，旧实现只换分隔符，收藏、置顶、最近记录会变成两个相同条目。先以失败测试复现，再在读偏好时按规范路径去重、保留顺序；POSIX 库里反斜杠文件名仍与目录路径区分。
- **#77：Windows 审批回归测试的宿主假设。** 测试仍认为 `ls -la` 在 Windows 免审批，因此一直等待审批超时。实际审批策略保持原样：Windows 测 `dir` / `type`，POSIX 名单显式按 Linux 判；增加管道、逗号、环境变量、`git status`、`findstr` 的真实审批闸拒绝断言。没有扩大免审批名单。
- **#23：Mini 探针度量。** 使用真实内容矩形，避免把分数 DPI 下向外取整的窗口外框再当作内容尺寸；以所在屏幕的工作区测试。复开与关闭前实际尺寸对比，精确位移由其他断言独立检查。

## 本机证据

| Issue | 已验证 | 仍未据此宣称完成 |
| --- | --- | --- |
| #13 电脑历史 / App Dock | 正式 0.7.1 helper、真实 IPC / 采集器连接、私有进程、清空后继续录制、两个订阅都关闭后自然退出、Windows Dock 入口屏蔽；左屏真实 125% 下 14 项通过 | 真实锁屏、用户键入的 Edge 全流程、特殊 exe 排除、真实 agent 前台输入 |
| #17 持久图标 | 实际 Electron shell 操作临时 Desktop / Start Menu / TaskBar `.lnk`：有效 ICO、参数与描述保留、无关快捷方式不动、新图新路径、重建后补写、用户自选图标保留、完整退出/重启；8 项通过 | 用户任务栏 / Explorer 缓存肉眼刷新、OS 重启、NSIS 覆盖安装、all-users 权限、Windows 10 |
| #22 Computer Use | 核对上游 PR 4 已合并；npm 最新仍是 0.7.1，未包含严格后台输入修复 | 不发布未授权版本、不把源代码已合并当作依赖已交付；坐标前台输入仍需专用桌面时段 |
| #23 Mini | 真实 Electron / Chromium 指针与内容矩形验证，包含缩放、工作区边界、复开尺寸；原有 41 项回归 | OS 原生鼠标手势、连续缩放的屏幕录制、混合 DPI 实体跨屏拖动、首次非前台点击 |
| #25 应用 / 窗口引用 | 真实 PowerShell 三路安装来源独立校验、窗口快照、排序、窗口状态、真实图标提取、空闲不启动轮询；6 项通过。本机枚举 289 个应用、60 个商店应用 | 全局真实按键、提窗/虚拟桌面/管理员窗口、十分钟 IME/游戏、安全软件、完整开始菜单逐项对账 |
| #35 系统打开文件 | 真实 Electron 冷启动 argv、二次启动、Markdown 就地保存且不导入、PDF 页面、库内笔记、不重复开、重载后再开；7 项通过 | NSIS 注册表关联、Windows 默认应用保留、真正资源管理器双击与卸载 |
| #57 更新源 | 真实 NSIS updater + 官网 Provider，回环 HTTP 302 下载、实际 SHA-512 验证、损坏校验拒收、generic `latest.yml` 下载；5 项通过。载荷为不可执行文本，关闭退出安装 | 实际官网/GitHub 网络环境、下载中手动/自动换源的安装版验收、NoExtend 安装、重启安装 |
| #70 旧 Windows 状态 | 真实 profile 中回放旧反斜杠标签、混合收藏/置顶/最近、锁与草稿；完整退出、重启、解锁、丢弃草稿、再次重启，9 项通过；真实截图已检查 | 这是假旧格式持久化现场，不是运行旧安装包；`.db` / PDF / 仪表盘旧标签、实际旧库挪动与日历界面尚未覆盖 |
| #77 Muse / 审批 | 引擎 54 项检查通过：包括真实审批闸、Windows 与 POSIX 命令判定、Muse 周期与唤醒契约 | 真模型 `muse,musedm` 已尝试，因开发版 `provider-auth.json` 缺失在启动前退出，无模型产物；不能据此宣称 Muse 行为已验收 |
| #89 Clip 手动安装 | 真实 IPC 复制正式随包扩展、manifest/icon 文件、已有副本保留、显式刷新与中间目录清理；4 项通过。另以隔离 clipboard mock 验证 Windows 扩展页兜底契约 | 没改用户全局剪贴板、没开 Explorer、没在浏览器安装扩展；原生跨应用拖放和「加载已解压」仍未验 |

桌面相关单测 40 项通过、4 项 macOS 专用检查跳过；引擎相关单测 54 项通过。桌面 TypeScript 检查、桌面构建与引擎构建通过。上述条数是各脚本断言，不代表对应 Issue 的每个手工项目都已完成。

## 在使用中的电脑上运行

用户指定测试窗口放最左屏并压在其窗口之后。`FORSION_TEST_DESKTOP=left` 让统一 Electron 启动器加载专用预载脚本：

- 普通窗口不能取焦点/置顶；用真实 Win32 `HWND_BOTTOM` 下沉。Windows 的 `HWND_TOPMOST=-1` 恰好是置顶，不能拿它当 macOS 的负一层。
- 默认屏幕查询定向到实际最左屏；位置调用限制在其工作区。此模式刻意改变测试实例的屏幕/焦点行为，**不能证明原生提窗、全局按键或真实鼠标输入正确**。
- Windows 原生方法属于每个窗口实例；在原型上改方法不起作用。跨进程 `SetWindowPos` 使用异步标志，避免主线程同步等待时互锁。
- 内容初始尺寸在构造完成后恢复；首次停车坐标按所选屏幕的物理像素网格对齐，避免混合 DPI 初始化影响尺寸。

`check:windows-background` 独立验证真实左屏范围、拒绝取焦点/置顶、原生前台窗口不变且测试窗在其下，以及三次透明窗创建的尺寸保持。

```powershell
$env:FORSION_TEST_DESKTOP = 'left'
$env:TANGU_HARNESS_QUIET = '1'
npm run check:windows-background
npm run check:windows-icons
npm run check:windows-updater
npm run check:windows-apprefs
npm run e2e:windows-clip
npm run e2e:windows-legacy
```

真实应用探针先构建。GUI 锁仍按仓根 `gui-verify` 指引执行。新增 Windows CI `probe-windows-issues` 在专用 runner 上重复相关单测与真实流程，上传日志；该 runner 不使用会修改屏幕/焦点契约的本机后台模式。

## 评审与交付边界

聚焦 GPT-6.1 Sol 评审发现一条 P2：安装枚举失败时仍可能从运行窗口拼出应用列表，探针会假绿。已独立解析安装查询原始帧，要求 AppsFolder、快捷方式、App Paths 三路都有返回且没有错误；本机重跑通过。

未涉及 AI 行为生产代码改动，未修改审批策略；没有推 tag、发布 npm、部署、合入 main 或关闭尚缺证据的 Issue。

## 续验：用户登录后与实际旧版升级

- **#70**：真实 v2.13.4 创建 Windows profile，再用当前代码升级与重启，24/24。包括原清单的五类标签、恢复草稿、收藏置顶、只读 / 解锁、实际日历事件与颜色、移动后续写与标签复用。移动漏字的两条实际根因和新仪器见 [交接修复记录](note-move-handoff-2026-10-20.md)，PR #122。
- **#77**：用户完成登录后，真实 GPT-6 Luna 的 Muse 私聊与心跳分别通过。Muse 心跳跑到两个周期，Journal 有内容，审批队列为 0；私聊场景的唯一审批是明确要求修改 STATUS.md，正常进入私聊，读自身文件没有审批卡。普通 Tangu auto-edit 会话通过真实 run_bash 与审批 SSE 验证 6/6：dir / type 实际读出文件而不审批；管道、逗号、环境变量与 git status 每条都出现一张审批并被台架拒绝，没有执行。Inbox 副标题相关 10 项 Windows 单测通过。原始产物保存在仓根 harness-runs/2026-10-20 的 233054-muse+musedm、233207-muse 和 233659-windowscmd；第一次 muse 被 AppData 工作目录保护拒绝，未计为模型通过。
- **#89**：IPC 复制出的正式 Clip 2.1.1 在隔离、无界面的 Chromium 中真正加载，真实 MV3 worker 启动、扩展页登记为 enabled / UNPACKED 且目录相同、设置页面渲染；连同原复制检查共 7/7。死代理强制覆盖回环地址，测试扩展不会连接用户正在运行的 Forsion。原生跨应用目录拖放、系统剪贴板及资源管理器入口仍未据此勾选。
- **#22**：上游当前 main 1d2950e 的源码版本为 0.7.2-jev.6；本机 Windows npm ci / build / check 全部通过，包含 actions 与 strict-background 离线检查。npm 正式最新仍为 0.7.1；Windows 原生前台输入仍需专用 runner 验证。

本轮没有改 AI 生产行为或扩大免审批名单。新增 `windowscmd` 是 opt-in 真模型验收，负对照审批一律拒绝；未获命令原样工具调用或审批事件都判失败，不拿模型自述通过。
