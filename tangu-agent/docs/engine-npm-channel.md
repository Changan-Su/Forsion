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
- **关掉:** 环境变量 `TANGU_ENGINE_OVERLAY=off` 只跑自带的;`=verbose` 让终端里的 `tangu` 也把挑选过程打出来。

## 什么样的新版会被收下

判定只有一份实现:`src/boot/overlay.ts` 的 `checkOverlay`。更新器落盘前、启动器每次拉起前跑的是同一个函数。五条全过才收:

| 条件 | 为什么 |
|---|---|
| 包名对、正式版号、比安装包自带的新 | 永不降级;预发布不进这条通道 |
| `forsion.minDesktop` 不高于壳的版本 | 新引擎可能依赖更新的壳。壳版本取自带引擎的版本号(两者同号发版是 build-desktop 的门禁) |
| `dependencies` 与自带的完全相同 | 新版用的是安装包里那份 `node_modules` |
| 建表 / 迁移文件与自带的逐字节相同 | 带迁移的版本只能随安装包发,这样退回自带引擎永远安全 |
| `SIGNATURE` 对得上钉死的公钥,目录里的文件恰好是签过的那些 | npm 的 sha512 只证明「下的是 registry 上那份」,证不了「那份是我们发的」 |

后三条在发版前就由 `scripts/engine-release-gate.mjs` 拦一遍:不满足就不发,免得发出一个没有桌面会收的版本(npm 版本号用掉就收不回)。

## 发一次引擎热更新

一次热更新 = 从它所针对的那个桌面正式版拉出来的修复分支。**不要从 main 的最新提交发**:main 上有没随安装包发出去的功能、依赖和迁移。

1. 从目标桌面 tag 开分支:`git switch -c hotfix/tangu-2.13.5 v2.13.4`,把修复放进去(只动引擎,不动依赖、不动迁移)。
2. 把 `tangu-agent/package.json` 的版本号抬到下一个补丁号(`desktop/package.json` 不动)。版本号与桌面共用一条线:
   这个号从此归这次热更新,下一个桌面正式版要再往后取 —— build-desktop 的门禁见到同号的 `tangu-v*` tag 就拒发。
3. 本机验证:`npm run build && npm run e2e:overlay`,再跑这次修复相关的测试。发 npm 前的验证不能比发安装包松:npm 版本撤不回,坏版本只能向前修。
4. 推分支,推 tag `tangu-v2.13.5`。`publish-engine.yml` 构建、过门禁、签名、端到端核对,然后发 npm。
5. 把修复照常合进 main。

`forsion.minDesktop` 缺省就是它所基于的那个桌面版本(CI 用最近的 `v*` tag 填),也就是只送给那一版的壳。
确认更老的壳也能用时,才在 `package.json` 里写一个更低的值;老壳是否真的收下仍由依赖清单和建表文件两条把关。

## 首次发布(只做一次)

npm 规定包先存在才能登记自动发布,所以第一次要手动:

1. 把签名私钥配进仓库:Settings → Secrets → Actions → `TANGU_ENGINE_SIGNING_KEY`,内容是
   `~/.forsion-dev/secrets/tangu-engine-signing/key.pem` 的全文。
2. Actions 页手动运行 `publish-engine`(只打包不发布),下载产物 `forsion-tangu-agent-<版本>.tgz`。
   手动运行打出来的包,版本号恒等于它所基于的那个桌面正式版 —— 一个已经发过的号,没有任何桌面会装它,只用来占位。
3. `npm login` → `npm publish forsion-tangu-agent-<版本>.tgz --access public`。
4. 登记自动发布:`npx -y npm@11 trust github @forsion/tangu-agent --repo Changan-Su/Forsion --file publish-engine.yml --allow-publish`。

之后推 `tangu-v*` tag 就自动发。

## 签名私钥

ed25519。公钥编在 `src/boot/signingKey.ts`,随每一份安装包发出去。**这把钥匙永不轮换**:换了,所有已装机器都会拒绝之后的每一个引擎更新。
私钥只在两处:仓库 secret `TANGU_ENGINE_SIGNING_KEY`,和维护者本机 `~/.forsion-dev/secrets/tangu-engine-signing/key.pem`。

## 仪器

| 命令 | 核什么 |
|---|---|
| `npm run e2e:overlay`(tangu-agent) | 真打包 + 真签名 + 真启动器 + 真引擎:选中新版、上层野 `node_modules` 不干扰、终端入口同样选中、改一个字节 / 多一个文件 / 依赖不同 / 壳太旧 / 记成坏版本都退回自带的 |
| `node scripts/engine-overlay-packaged.check.cjs`(desktop) | 同一套核对,换成打包后的 Electron 与安装包里的原生依赖;build-desktop 在三个平台上各跑一遍 |
| `src/boot/overlay.test.ts` | 判定函数的每一条 |
| `desktop/electron/engineUpdates.test.ts` | 下载、只落签名表里的文件、落位、启动时收拾目录 |
| `desktop/electron/backendManager.test.ts` | 新版起不来 / 一用就崩时停用并退回 |

## 已知的边界

- **只惠及桌面。** web、mobile、云端 worker 用的是各自镜像里的引擎。
- **桌面里的「登录模型提供商」仍跑安装包自带的那份代码**(主进程直接 import 引擎的 `llm/providerOAuth.js`,不经启动器)。这块的修复要随安装包发。
- **随包的 Chrome 扩展不跟着热更新**:扩展目录始终指安装包那份,新引擎必须与安装包里的扩展兼容。
- **第一份带启动器的桌面版之前的安装包收不到热更新**:它们没有启动器,也没有更新器。
