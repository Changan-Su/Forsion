# 引擎的 npm 热更新通道

桌面端装好之后,Tangu 引擎的修复可以不重装安装包就送到用户手里:引擎发到 npm(`@forsion/tangu-agent`),桌面后台下载、核对,
下次拉起引擎时换上。终端里的 `tangu` 跟着用同一份。

这条通道是**快修通道**,不是主发版通道。它送得到的只有引擎的 `dist`(加上随包的技能);对话界面、依赖、数据库结构都还是随安装包走。

## 它怎么工作

```
npm  @forsion/tangu-agent@2.13.5          ~/.forsion/engine/2.13.5/        安装包 resources/tangu-server/
        │                                        ▲                              │
        │  桌面后台每 6 小时查一次               │ 核对通过才落位               │ dist/boot/launch.js(启动器,不热更新)
        └──────── 下载 ─────────────────────────┘                              │
                                                                               ▼
                                              拉起引擎 / 终端 tangu:有合格的新版跑新版,否则跑自带的
```

- **启动器** `src/boot/launch.ts` 住在安装包里。桌面拉起后端(`standalone`)和终端 `tangu`(`tui`)都先经过它。
- **新版没有 `node_modules`。** 启动器挂一个解析钩子,把新版文件里的裸包名一律改到安装包那份包根去解析。
  需要 `module.registerHooks`(Node ≥ 22.15;安装包自带的是 Electron 的 Node 24)。
- **新版起不来会自动退回。** 装不起来(缺文件、语法错)由启动器记成坏版本;连续 3 次起不来、或就绪后一再崩溃,由桌面记成坏版本。
  坏版本记在 `~/.forsion/engine/bad.json`,启动器跳过它,更新器不再下它。
- **装好 / 升级后第一次启动先查一次。** 这一次在拉起引擎、播种内置插件之前先跑一遍检查(和 Extend / 电脑操作 / 日历同一次),
  最多等 10 秒:下完的这一次启动就用上,刚装好的人不会一打开就看到「重启并启用更新」;超时就跑自带的,没下完的接着在后台下、
  下次生效。每个桌面版本只做一次(记号 `<userData>/core-prefetch-version`),实现在 `desktop/electron/corePluginUpdates.ts` 的 `prefetchOnFirstBoot`。
- **关掉:** 环境变量 `TANGU_ENGINE_OVERLAY=off` 只跑自带的;`=verbose` 让终端里的 `tangu` 也把挑选过程打出来。

### 按安装包线分发(2026-10-28 起)

每一版桌面是一条「线」,只收给自己做的热更新:npm dist-tag `desktop-<桌面版本>`(`+build.N` 修订与原版同线)指向这条线上最新的引擎。

- **更新器只查本线标签,不看 `latest`。** `latest` 上可能是别的线的引擎:号更高,建表文件碰巧相同时 `checkOverlay` 也会放行,新壳就跑上了旧线的代码。本线标签不存在 = 还没给这一版发过热更新,显示「已是最新」。
- **一次发布只打一个标签**(trusted publishing 只管 `npm publish`,不能另跑 `npm dist-tag add`)。门禁 `scripts/engine-release-gate.mjs` 按基线桌面 tag 里有没有 `desktop/shared/engineLine.mjs` 来选:
  | 基线安装包 | 打哪个标签 |
  |---|---|
  | 带 `engineLine.mjs`(更新器查本线) | `desktop-<基线版本>`,`latest` 不动 |
  | 更早的正式版(更新器只读 `latest`,≤ 2.13.7) | `latest`,同一时间只能喂一条这样的线 |
  | 更早的预发布(≤ 2.13.8-beta.2) | 门禁拒发:打 `latest` 会抢走正式版那条线,只能等下个桌面版 |
- 因此 `latest` 从此只服务更早的安装包。要退掉它得用带令牌的 `npm dist-tag`,CI 里没有。
- `minDesktop` 取基线的整条线(`v8.1.0+build.2` 拉的 hotfix 写 `8.1.0`),原版与各修订都能收;建表 / 依赖照旧由 `checkOverlay` 把关。基线安装包自带的引擎得是正式版号,否则启动器不收任何热更新,门禁拒发。
- 本机 `engine/` 目录是各安装包共用的。桌面启动时(`cleanEngineOverlays`)会删掉 `minDesktop` 不在本线上的旧引擎:那只能是换装前的安装包下的,号可能更高,建表碰巧相同时启动器会挑中它。换装后若先在终端跑 `tangu`、还没打开桌面,会挑到它一次,这个窗口不管。

## 什么样的新版会被收下

判定只有一份实现:`src/boot/overlay.ts` 的 `checkOverlay`。更新器落盘前、启动器每次拉起前跑的是同一个函数。五条全过才收:

| 条件 | 为什么 |
|---|---|
| 包名对、正式版号、比安装包自带的新 | 永不降级;预发布不进这条通道 |
| `forsion.minDesktop` 不高于壳的版本 | 新引擎可能依赖更新的壳。壳版本读安装包 `tangu-server/desktop-host.json`，由 afterPack 写入实际桌面版本；只有缺少该文件的旧同号安装包才回退到自带引擎版本。损坏的文件不回退 |
| `dependencies` 与自带的完全相同 | 新版用的是安装包里那份 `node_modules` |
| 建表 / 迁移文件与自带的逐字节相同 | 带迁移的版本只能随安装包发,这样退回自带引擎永远安全 |
| `SIGNATURE` 对得上钉死的公钥,目录里的文件恰好是签过的那些 | npm 的 sha512 只证明「下的是 registry 上那份」,证不了「那份是我们发的」 |

依赖 / 源码迁移兼容性与引擎版本在发版前由 `scripts/engine-release-gate.mjs` 拦一遍:不满足就不发,免得发出一个没有桌面会收的版本(npm 版本号用掉就收不回)。

## 发一次引擎热更新

一次热更新 = 从它所针对的那个桌面版本(正式版或预发布)拉出来的修复分支。**不要从 main 的最新提交发**:main 上有没随安装包发出去的功能、依赖和迁移。

1. 从目标桌面 tag 开分支:`git switch -c hotfix/tangu-2.13.5 v2.13.4`,把修复放进去(只动引擎,不动依赖、不动迁移)。
2. 把 `tangu-agent/package.json` 与 lock 的版本号抬到新的引擎版本（`desktop/package.json` 不动）。**桌面和引擎独立编号**：引擎须高于目标桌面自带的引擎，以及 npm 已发布的引擎版本；无需高于桌面版本号。桌面 `v2.13.6` 与引擎 `tangu-v2.13.6` 可同时存在。
3. 本机验证:`npm run build && npm run e2e:overlay`,再跑这次修复相关的测试。发 npm 前的验证不能比发安装包松:npm 版本撤不回,坏版本只能向前修。
4. 推分支,推 tag `tangu-v2.13.5`。`publish-engine.yml` 构建、过门禁、签名、端到端核对,然后按门禁选的 dist-tag 发 npm(见上文「按安装包线分发」;Actions 日志里那行 `dist-tag …` 就是它)。
5. 把修复照常合进 main。

`forsion.minDesktop` 缺省就是它所基于的那个桌面版本(CI 用最近的 `v*` tag 填),兼容该版本及更高版本的壳，仍须通过依赖、迁移和签名检查。
确认更老的壳也能用时,才在 `package.json` 里写一个更低的值;老壳是否真的收下仍由依赖清单和建表文件两条把关。

## 桌面独立发布

桌面以 `desktop/package.json` / lock 和 `v*` tag 为准；引擎以 `tangu-agent/package.json` / lock 和 `tangu-v*` tag 为准。`/health` 继续报告真正运行的引擎版本，不能改成桌面版本。

`engine-release-gate.mjs --desktop-release v<桌面版本>` 不再禁止桌面与热更新同号：它核对桌面 tag、前版随包引擎和 npm 引擎历史。源码不变的引擎可随多个桌面版本复用；已经发行的引擎来源若变化，必须单独提升引擎版本，不能借桌面升级重用旧引擎身份。源码基线包含引擎 src / skills / agent-skills / tsconfig / lock 与清单；registry 无法核验时不放行。CI checkout 必须取完整 tags。

打包钩子在应用签名前写 `desktop-host.json`，不改引擎 package.json。桌面更新器与终端启动器共用 `checkOverlay` 读取它；热更新 npm 包不携带、也不覆盖此宿主身份。真实安装包检查分别验证桌面版本、随包引擎版本和宿主身份，不再比较两包是否同号。

## 首次发布(只做一次)

2026-10-21 已完成：`2.13.5` 首发、GitHub 签名 secret 和 npm trusted publisher；
[`tangu-v2.13.6` 的 OIDC 自动发布](https://github.com/Changan-Su/Forsion/actions/runs/39602923526)成功，官方源与 npmmirror 的 `latest` 均为 `2.13.6`。
macOS 安装版的公共 npm 下载、固定公钥验签、重启切换和「已是最新」11 项检查通过。后续直接按上面的热更新流程发版。

npm 规定包先存在才能登记自动发布,所以第一次要手动:

1. 把签名私钥配进仓库:Settings → Secrets → Actions → `TANGU_ENGINE_SIGNING_KEY`,内容是
   `~/.forsion-dev/secrets/tangu-engine-signing/key.pem` 的全文。
2. Actions 页手动运行 `publish-engine`(只打包不发布),下载产物 `forsion-tangu-agent-<版本>.tgz`。
   手动运行打出来的包使用目标桌面自带的引擎版本，`minDesktop` 单独使用目标桌面版本；只提供预览产物、不自动发布。首次占位流程已经完成，不再重发已存在的版本。
3. `npm login` → `npm publish forsion-tangu-agent-<版本>.tgz --access public`。
4. 登记自动发布:`npx -y npm@11 trust github @forsion/tangu-agent --repo Changan-Su/Forsion --file publish-engine.yml --allow-publish`。

之后推 `tangu-v*` tag 就自动发。

发布流程上传隐藏的 `.engine-pack` 目录时必须设置 `include-hidden-files: true`；只上传签好的 `.tgz`。
打包后的 `package.json` 必须保留与 GitHub 仓库匹配的 `repository.url`，否则 npm OIDC 无法确认发布来源。
首发后核对匿名 registry 的 `latest` 和 tarball：`0.0.0-stage` 是 npm 暂存占位，尚不是可安装的正式引擎。

### 用安装版验证真实更新链

macOS：在 `desktop/` 运行 `npm run check:engine-update-live -- --app /Applications/Forsion.app/Contents/MacOS/Forsion --expect <已发布的新版>`。
脚本克隆已安装应用，只加测试用的存储目录重定向和网络观测；不改安装版，不使用模拟 registry 或更新响应。
它通过设置页真实 IPC 从公共 npm 下载，使用安装包原有公钥验签，确认正在跑的引擎没变，再重启隔离实例核对
`/health` 的版本以及设置页「已是最新」。报告和截图在 `desktop/outputs/engine-update-live/`。
默认要求目标比安装包新，避免把「没下载、没验签」当完整通过；只验证同版本查更时显式加 `--current-only`。

## 签名私钥

ed25519。公钥编在 `src/boot/signingKey.ts`,随每一份安装包发出去。**这把钥匙永不轮换**:换了,所有已装机器都会拒绝之后的每一个引擎更新。
私钥只在两处:仓库 secret `TANGU_ENGINE_SIGNING_KEY`,和维护者本机 `~/.forsion-dev/secrets/tangu-engine-signing/key.pem`。

## 仪器

| 命令 | 核什么 |
|---|---|
| `npm run e2e:overlay`(tangu-agent) | 真启动器 + 真引擎(签名用当场生成的测试钥匙,不需要发版私钥):选中新版、上层野 `node_modules` 不干扰、终端入口同样选中、改一个字节 / 多一个文件 / 依赖不同 / 壳太旧 / 记成坏版本都退回自带的 |
| `node scripts/engine-overlay-packaged.check.cjs`(desktop) | 同一套核对,换成打包后的 Electron 与安装包里的原生依赖;build-desktop 在三个平台上各跑一遍 |
| `src/boot/overlay.test.ts` | 判定函数的每一条 |
| `desktop/electron/engineUpdates.test.ts` | 只查本线标签、下载、只落签名表里的文件、落位、启动时收拾目录 |
| `scripts/engine-release-gate.test.mjs`(tangu-agent) | 版本号身份、依赖 / 迁移守卫、按基线安装包选 dist-tag |
| `desktop/electron/backendManager.test.ts` | 新版起不来 / 一用就崩时停用并退回 |

## 已知的边界

- **只惠及桌面。** web、mobile、云端 worker 用的是各自镜像里的引擎。
- **桌面里的「登录模型提供商」仍跑安装包自带的那份代码**(主进程直接 import 引擎的 `llm/providerOAuth.js`,不经启动器)。这块的修复要随安装包发。
- **随包的 Chrome 扩展不跟着热更新**:扩展目录始终指安装包那份,新引擎必须与安装包里的扩展兼容。
- **第一份带启动器的桌面版之前的安装包收不到热更新**:它们没有启动器,也没有更新器。
