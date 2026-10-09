# Tangu Mobile(Android 优先)

移动端 Tangu:复用 `../desktop/frontend` 渲染层(Vite 别名,不复制源码),换单列 `MobileShell` 外壳,
Capacitor 打 Android APK,走 Forsion 网关云连(手机控云会话)。iOS 暂缓。

## 架构

- 渲染层经 `@ → ../desktop/frontend/src` 别名复用。共享组件保留可选宿主展示接口；Android 可接原生交互，桌面和浏览器继续使用 Web 展示。
- `vite.config.ts` 的 `resolveId` 插件按绝对路径把引擎 3 个 Dockview 模块换成移动版:
  `engine/workspaceStore → src/engine/mobileWorkspaceStore`、`engine/{Shell,WorkspaceHost} → src/engine/emptyHost`。
- `src/engine/MobileShell.tsx` = 顶栏 + 全屏主 leaf + **底部 Space 切换栏** + 侧滑抽屉。
- `src/mobileShim.ts` + `src/capacitorAuth.ts`:native 用 Preferences 存 token + 深链登录;web(dev)用 localStorage + /auth。

## 开发(浏览器窄屏联调,不出包)

```bash
npm i
npm run dev   # http://localhost:5274,同源经 vite proxy 到 BACKEND_URL(缺省 localhost:3001)
```

## 出 Android APK

后端地址:**native 缺省烤入生产网关 `https://api.forsion.net`**(`src/capacitorAuth.ts` 的 `PROD_ORIGIN`),
直接 build 即产生产包;连 dev/自托管网关才需覆盖 `VITE_API_ORIGIN`(纯源不含 /api,约定见
`docs/Function/前端环境变量约定.md`):

```bash
npm ci
npm run build                                # 生产包;自托管:VITE_API_ORIGIN=https://<网关> npm run build
                                             # 登录页不同源再加 VITE_AUTH_ORIGIN=https://<站点>
npx cap sync android
cd android && ./gradlew assembleDebug
# 产物:android/app/build/outputs/apk/debug/app-debug.apk
```

需本机/CI 具备 Android SDK + JDK 21 + gradle。`android/` 已入库(含深链 intent-filter),CI 直接 build 即可。

## Android 原生交互试点（2026-10-01）

首个交付是 Kotlin + Jetpack Compose 模型选择半屏面板。聊天与插件共用的 `ModelPill`
通过 `modelPickerHost.ts` 展示协议调用 Capacitor `NativeModelPicker`；模型目录、中文/英文文案、
模型 ID 和业务回调仍由调用方负责。搜索聚焦时面板展开；完成时一次提交模型与思考档，
系统返回、下滑或点击遮罩取消。高级默认模型与上下文入口按原调用方能力展示。
上下文窗口只适用于打开面板时的模型；切换模型后重新打开面板才能修改该模型的窗口。

- `ctx.ui.mountChatBox` 的插件无需新增 Android UI 代码即可共用此面板。
- 现有 DOM View、Amadeus 编辑器、ProseMirror 扩展继续运行在 WebView；本次没有重写编辑器或全部页面。
- 切换会话/执行目标、模型目录变化、输入框卸载、插件禁用或页面重载会取消旧请求。
  结果按请求目录校验；原生插件缺失/调用失败时回退现有 Web 菜单。
- Android 15 的系统栏与刘海间距使用 Capacitor `adjustMarginsForEdgeToEdge: auto`，避免内容被状态栏覆盖。
- **验证范围**：示例插件实际经过 `pluginStore` 注册、挂载共享输入框和卸载。
  外部插件的安装与装载见下面「Android 插件」一节。
  预览消息和模型是样本，无登录、后端会话或模型请求。

### 并装预览 APK（真 App，独立包名）

给人试用的预览包：**真 App**（与正式版同一份代码、同一个生产网关），包名 `com.forsion.tangu.nativepreview`、
桌面名「Forsion Preview」，与已装正式版（`com.forsion.tangu`）及其数据并存，互不覆盖。

```bash
rm -rf dist && npm run build && npx cap sync android
./android/gradlew -p android :app:assembleDebug -PnativePreview
cp android/app/build/outputs/apk/debug/app-debug.apk outputs/forsion-nativepreview-debug.apk   # 与普通 debug 包同一输出路径,先拷走
adb install -r outputs/forsion-nativepreview-debug.apk
adb shell am start -n com.forsion.tangu.nativepreview/com.forsion.tangu.MainActivity
```

- 这是 **debug 签名**的包（WebView 可远程调试、`src/debug` 的网络配置只对 localhost / 10.0.2.2 放行明文），只给内部试用，
  不发外;**不用、也不碰正式 keystore**。`-PnativePreview` 只挂在 `debug {}` 上，`assembleRelease` 不受影响。
- 两个包都注册了 `tangu://auth-callback`：在预览包里登录时系统会弹「用哪个应用打开」，选 Forsion Preview。
  scheme 是深链绑定身份，**不改**。
- 插件、笔记缓存、设置都在各自包的私有目录里，两边互不可见。

### 审阅样本页（模型面板截图台架）

```bash
FORSION_NATIVE_PREVIEW=1 npm run build
npx cap sync android
./android/gradlew -p android :app:assembleDebug :app:testDebugUnitTest -PnativePreviewSample
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.forsion.tangu.nativepreview/com.forsion.tangu.MainActivity
# 等待应用出现后；仅连接一台设备，Node 22+
OUT=/absolute/review-output node scripts/native-picker-emu.cjs
```

`-PnativePreviewSample` 与上面同一包名，但启动直接进 `native-preview.html` 样本页（`BuildConfig.NATIVE_PREVIEW_SAMPLE`）。
`native-preview.html` 只在 `FORSION_NATIVE_PREVIEW=1` 构建中包含；发布前用普通 `npm run build` 再 `npx cap sync android`，
并去掉 Gradle 的预览参数。原生模型面板也接入普通应用入口，样本开关只控制样本页面。
台架自己会跳到 `/native-preview.html`，所以装的是 `-PnativePreview` 包也能跑，只要 dist 带了样本页。

验收脚本通过真实 Compose 无障碍节点操作面板，并检查 Web 侧的草稿结果；输出浅色、深色、
英文、搜索键盘与插件截图，以及 `acceptance.json`。当前已覆盖 Android 15 模拟器；
真机、其他 Android 版本和完整外部插件目录仍待后续验收。

## Android 原生外壳：顶栏 + 通用底单（2026-10-02）

WebView 仍是内核，外壳换原生：两个可选宿主接缝在 `lcl/engine`，Android 宿主在 `src/nativeChrome.ts` / `src/nativeSheet.ts`，
Kotlin 在 `NativeChrome*` / `NativeSheet*`。没装宿主（桌面、Web、浏览器调试）时一切照旧走 Web UI。

- **`NativeChrome`**：原生 Material 顶栏取代 `.mb-topbar`（左抽屉 / 标题 / 右抽屉 / 标签页数 / 更多）。
  WebView 由插件放在顶栏下方（自管 insets，`--mb-top` 归零）。引导、成就、互联设备、旁聊等自带头部的全屏层用 `useNativeChromeClaim({ mode: 'hidden' })` 收起顶栏；
  **设置**改用 `page` 模式（标题 + 返回，分类页再加 `close` ×），Web 头部只在 `data-native-chrome` 时隐藏。
  **底部导航栏**：Space 切换由同一插件画成原生底栏（外壳把 Space 列表随 `spaces` 推过去，图标由宿主按 Space 的图标组件序列化）。
  图标是一张图的 Space（插件 Space 的 `iconFile`）：PNG 在页面里缩成 72px 随状态发过去、原色显示；图还没好、是 SVG 或超出体积预算时画配方 `icon` 的线条图标（`SpaceIcon.nativeFallback`）。
  点 = 切 Space；点当前那格不做事；长按 = 固定到桌面。超过 5 个时**第一格（主页）固定不动**，其余格子在它右边横向滚动（固定 1 格 + 滚动 4.5 格）：
  当前格在前五个里时不滚；再往后只滚到「当前格完整可见、下一格露半个」为止。固定按位置不按 id（JS 列出的第一个 Space）。
  只在 `shell` 模式的**第一层页面**且 Space ≥ 2 时出现，键盘弹起、`page` / `hidden` 时收起；WebView 的下边距由插件一并管理。当前 Space 镜像在 `.mb-shell[data-space]`（仪器锚点）。
- **两级导航**（2026-10-04；只在画底栏的原生宿主下生效，Web / 桌面手机框 / 手机浏览器仍是抽屉）：有左栏的 Space 进来先看左栏 —— 全屏、标题 = Space 名、带底栏；
  点条目进主区（顶栏左侧变返回箭头、底栏收起）；系统返回 = 标签页内后退 → 回列表 → 在列表再按一次退到后台。冷启动、切 Space、重置布局都落在列表层。
  左栏不是「点开一项进主区」的列表时，在 Space 定义里写 `listFirst: false`（日历的待办）：主区是第一层，左栏仍是抽屉。
  配方 Space（插件包里带的 `space.json`）一律主区是第一层：配方照桌面三栏写，它的左栏未必能把人带进主区。
  没有左栏的 Space（主页、Muse…）主区就是第一层。层级镜像在 `.mb-shell[data-nav]` = `list` / `detail` / 缺省（仪器锚点）。
- **账号 / 设置 / Forsion Unit 切换**（2026-10-04，10-05 改）：原生宿主下左栏底部那一排不再渲染。账号是第一层页面顶栏最右的头像（有头像图用图，否则首字母；未登录是人形图标），
  点开是同一份账号菜单 —— 账号卡隐身挂在 `MobileRoot`，经 `@/services/accountChip` 把「显示什么 / 点了做什么」交给 `src/nativeChrome.ts`；头像图在 JS 侧裁方、缩到 96px 再过桥。
  **设置与「Forsion Unit 切换」是这张菜单里的两行**（同微信「我 → 设置」；10-04 那一版排在「⋯」最前，一天后按用户意见搬走），所以只在第一层页面点得到；
  未登录 / 登录过期时点头像同样开菜单（登录是其中一行），不再直接跳登录。判据只有一份：`lcl/engine/moreSheet.ts` 的 `accountMenuItems` / `moreItems`
  —— 一项要么在头像菜单、要么在「⋯」；宿主没有账号项（没有头像）时这两项留在「⋯」最前。
- **本地 / 云端**（2026-10-05）：原先占着每个左栏顶部一行的「本地 | 云端」胶囊，手机上并进了「Forsion Unit 切换」弹层最前面的「智库」一段（桌面 08-23 就并进了 Unit 切换器，同样排在最前）。
  它只换笔记库（`window.amadeusVaultMode.switch`），与同一弹层里的「在哪运行」是两根轴。弹层没上架（无 `unitsList` 桥）时 `VaultSideSwitch` 仍画胶囊，库切换不会两头都没有。
- **`NativeSheet`**：通用 Compose 半屏底单，三种 `kind`：`menu`（分组 / 勾选 / 子菜单 / 搜索 / 行尾按钮）、`prompt`、`confirm`。
  调用方用 `presentNativeMenu` / `presentNativePrompt` / `presentNativeConfirm`，拿到 `{ handled: false }` 就渲染自己的 Web UI。
  已接入：标签页底单、更多底单（无自定义组件项时）、`ContextMenu` 原语（`pickNativeCtxItem`）、`askString`、无 children 的 `ConfirmDialog`。
- **「⋯」里的插件命令**：命令声明 `moreGroup = { id, title }` 就按组列进「⋯」（Web sheet 与原生底单同一份整形，`lcl/engine/moreSheet.ts`）；
  外置插件的命令由 `amadeusPlugins.ts` 的桥按插件分节（节标题 = 插件名，开关命令带勾选态）。手机没有 ribbon，这是插件命令的一键入口。
- **应用市场**与设置同款走 `page` 模式：列表页「返回」= 退出市场；详情页标题 = 条目名，「返回」= 回列表、「×」= 退出市场。
- **`SheetMenu`**（`lcl/engine/nativeSheetMenu.ts`）：一份条目（文案 + `run` 回调）同时喂 Web 菜单与原生底单。
  点击触发的菜单用 `openNativeSheetMenu(build, { onFallback })`（无宿主同步返回 false，走原 Web 路径）；
  状态驱动的右键/长按菜单用 `useNativeSheetMenu(open, build, onClose)`（返回是否该渲染 Web 菜单）。
  已接入：输入框模式菜单（审批档走同一个 `setApproval`）、添加菜单（会话 / View 二级页带搜索）、回退菜单、项目选择器、
  账号卡片（额度 + 切换账号 + 退出）、侧栏会话 / 工作区菜单、Orbits「+」与行菜单、设备会话菜单、Workspace 模式、主页收纳夹菜单。
  刻意留 Web：斜杠面板、@ 提及、`[[` 弹层、选区工具栏、上下文环、审批托盘、Ultra 确认、群聊设置、审批规则、壁纸面板、收纳层。
- **`NativeFilePicker`**：底单里选「添加文件」时 WebView 没有用户激活，`<input type=file>.click()` 会被 Chromium 静默丢弃；
  改走系统文档选择器（`window.tangu.pickFiles`，单个 25MB / 合计 60MB / 最多 20 个，超限的列名提示，不静默丢）。
  「＋」底单里它拆成三行：**拍照**（`takePhoto`：系统相机 App 拍进本应用缓存的 `camera/`，经自家 FileProvider 读回；
  清单声明了 CAMERA，所以拍之前先申请这一项，被拒有提示）、**相册**（`pickPhotos`：系统照片选择器，只列图片，
  文件名是系统给的编号 —— 选择器不透露原名）、**文件**（原来那条）。同一时刻只开一个选择器 / 相机（原生 `busy` 闸）。
- **下拉框**（`lcl/engine/nativeSelect.ts`）：`<select>` 点开的是 WebView 自带的白底对话框、不跟主题。原生宿主在场时，
  一只捕获阶段监听把这次按下接过去，选项走同一张原生底单，选中后写回元素并派发 `input` + `change`（React 的 `onChange` 照常走），
  组件一处不用改。不接管的：多选 / 列表框、超过底单条数上限的、插件 iframe 里的；宿主呈现失败过一次的那个下拉此后交还浏览器。
- 文案、图标、主题全部由 Web 侧传入（i18n 跟随当前语言）；Kotlin 不持有用户可见字符串，只做载荷校验（大小 / 深度 / id 唯一）。

真机验收（一台模拟器/设备，debug APK，后端全由 CDP 桩住，不碰真服务器；结束时还原 token / 语言 / 主题）：

```bash
rm -rf dist && npm run build && npx cap sync android
./android/gradlew -p android :app:assembleDebug :app:testDebugUnitTest
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
OUT=/absolute/out npm run emu:nativeshell   # ONLY=tabs,prompt 只跑子集
```

负对照在 `e2e:boot`：浏览器里没有原生宿主时必须仍是 `.mb-topbar` + Web 标签页底单。

### 桌面图标（应用图标的入口别名）

「设置 → 外观 → 应用图标」选内置图标时，桌面图标跟着换。桌面上的图标是清单里的一个入口（`activity-alias`），Android 只允许在安装包声明过的入口之间切换，所以上传的图片 / 插件图标只在应用内显示。真正的 Activity 是 `AppActivity`；默认入口沿用旧组件名 `.MainActivity`（用户桌面上已有的图标认这个名字）。原生半身 `LauncherIconPlugin.kt`，页面半身 `src/launcherIcon.ts`。

两条模拟器上实测出来的规矩（都写在 `LauncherIconPlugin.kt` 顶部）：在前台不切、离开应用才切（否则系统约一秒后把正在用的任务移除）；先把快捷方式搬到新入口再关旧入口（否则桌面把已固定的 Space 快捷方式摘掉）。

新增内置图标：清单加一个 `android:enabled="false"` 的别名 + 图标资源，`LauncherIconPlugin.ENTRIES` 加一行。

```bash
ONLY='app icon:' OUT=/absolute/out npm run emu:nativeshell
# 升级验收：先装旧包固定一个 Space 快捷方式，再覆盖装新包（旧包 = 入口还是 Activity 本身的版本，≤ 2.13.x）
OLD_APK=/absolute/old.apk NEW_APK=android/app/build/outputs/apk/debug/app-debug.apk npm run emu:launchericon
```

只在 API 35 模拟器的 Pixel 桌面上看过；各家定制桌面（MIUI / ColorOS 等）切换入口后的表现没有验证。

同一台架也跑 Android 插件的真机链路：假市场（CDP 桩）+ 宿主上的真 HTTP 下载服务（`PLUGIN_PORT`，缺省 5317），
经原生下载器（`ForsionMarketDownload`，台架核对请求 UA 不是 WebView）装进 `files/plugins/<slug>`，
「⋯」里插件分节运行命令 → 插件视图（CSP `'unsafe-eval'` + 插件自己的 `new Function`）、冷启动（force-stop + 重开）后仍启用且数据在、
设置 → 插件卸载后目录消失。模拟器在飞行模式下到不了 `10.0.2.2`（台架不改设备设置），所以缺省用 `adb reverse` 把宿主端口映射成设备 `localhost`；
网络通时可 `PLUGIN_HOST=http://10.0.2.2:5317`。结束时删掉 e2e 插件目录与私有数据、撤掉 reverse。

评审修复的真机核对也在这一台架里（2026-10-02，负对照：对修复前的包跑 `replaced menu / rewind: leaving / prompt: input past` 三条必红）：

- **系统文件选择器**：往设备 `Download/`、`Documents/` 推三个夹具文件（结束时删掉），经「＋ → 添加文件」真选：
  小文件与 1 MB 文件进输入框（名字、字节数、sha256 逐一核对；`_capacitor_content_` 响应全 200、logcat 无 `Unable to open content URL`），
  26 MB 那个被提示条点名且不进输入框，多选走 clipData，取消什么都不发生。需要系统语言为英文（按 DocumentsUI 的文案找根目录）。
- **封顶下载**：声明 30 MB 与不给长度的无尽流都以 `too large` 失败，下载期间缓存里的临时文件从不超过 25 MB，结束后 `cache/` 里没有 `forsion-market-*`。
- **覆盖安装**：已装时在市场里再装一次（1.0.1），目录切到新版，`files/plugins` 下没有 `.staging-*` / `.backup-*`。
- **输入长度封顶**：往原生输入框贴 12 万字，确定后回 10 万字的文本（修复前是静默取消）。
- **回退请求作废**：统计未回时切走会话 → 不弹；半屏开着时切会话 → 自动收起；两种都不写任何请求。
- **菜单互相顶替**：一个原生菜单开着时再开第二个，第二个留在屏上且绑定的是第二个对象。

`PKG=com.forsion.tangu.nativepreview` 可对并存预览包跑同一台架。模拟器建议 `-gpu host` 启动：软件 GL（SwiftShader）下 WebView 的
半透明描边圆角卡片会花屏（与 App 无关，系统 HTML 查看器里的静态页同样复现），宿主 GPU 下正常。

## 系统通知（2026-10-05）

都只在进程活着时有（刚退到后台的那一阵，或有 agent 在跑、灵动岛的前台服务在保活）；进程被系统收走之后的推送要服务器来发，不在这里。
实现在 `src/liveIsland.ts` / `src/liveIslandDerive.ts`（纯函数）与 `LiveIslandPlugin.java`，三个通知 id：`7201` 常驻的岛、`7202` 事件（每类一个 tag）、`7203` 完成态。

- **岛上的「拒绝 / 允许」**：岛上显示的是待批审批时带按钮，点了走审批卡同一个 `decideApproval`，不用回 App。
  - 放哪个按钮、点下去认不认，都由 `shadeAsk` / `shadeAnswer` 一处判（单测 `npm run test:liveisland`）。
  - 「允许」只给普通审批（档位本就要问 / 你自己写的规则要问）里的命令类工具（`run_bash` / `run_background`：只有它们的预览是命令原文，
    写文件 / 改文件 / 补丁的预览是一行摘要），而且命令得短到通知展开后能整段显示（≤120 字、≤3 行，进 `BigTextStyle`）；
    看不全的、越界写入、受保护路径、设备操控、只能在执行设备上批的，只给「拒绝」，要批准得进会话看完整的审批卡。远程来源的审批不放按钮。
  - 两个按钮都要求设备已解锁（`setAuthenticationRequired`，Android 12+）；更老的系统不放按钮。「允许」永远只是这一次，不是「总是允许」。
  - 按钮背后是一条只发给本应用的广播，接收器运行时注册、不导出；页面收到后照当时的 store 重判，通知是旧的就什么都不做。
- **应用内通知跟发系统通知**：`window.tangu.notify`（与桌面同一座桥，`notificationStore` 调）。只在 App 不在前台时贴，同类只留最新一条，回到前台即撤；
  「跑完了」不走这条（由岛报）。设置 → 通知里现有的开关照旧管着。通知权限只在第一次上岛时问，这里不另问。
- **完成态**：run 结束时常驻那条随服务撤掉，另贴一条「已完成 · 用时」（用时与会话里末条回复下面那行同源）。
  以前是同一个 id 原地覆盖：系统在服务松手时会把旧通知再贴一遍，落在后面就把「已完成」盖回「思考中…」且一直挂着（API 35 模拟器 6 轮里 3 轮）。

台架：`ONLY='island:,notifications:' npm run emu:nativeshell`（三条，约 4 分钟；需要模拟器的 root shell）。岛在的时候通知栏读不了无障碍树
（岛上的计时器每秒一跳，`uiautomator dump` 永远等不到空闲）：按钮背后的意图改从 `dumpsys notification` + `dumpsys activity intents` 核对，
岛在通知栏里的位置从系统界面自己的 dump 取；「拒绝」用 root shell 发同一条广播，「允许」真点。
通知权限回执的两条路（第一发 `show` 弹权限框，答之前 run 已结束 → 不把旧岛贴回来；没结束 → 岛出现）：`node scripts/live-island-emu.cjs perm`
（会撤掉本包的通知权限并冷启两次，不在上面那套里：那套要先把权限给上）。

## Android 插件(2026-10-02)

外部 Forsion 插件(`amadeus-plugin`)可从应用市场装进 App 并直接运行,与桌面同一份 `pluginStore` / `ctx`。

- **存储**:`Directory.Data/plugins/<slug>/{manifest.json, main.js, README.md, CHANGELOG.md, icon.png}`,
  私有数据 `Directory.Data/plugins-data/<id>.json(.alt)`。应用级,不在任何笔记库里(云端库 / 本地库同一份)。
- **装配**:`src/plugins/installMobilePlugins.ts`,由 `main.tsx` 在 `import('./mobileEntry')` 之前调用:
  `window.amadeus` 转发壳上叠 `listPlugins / uninstallPlugin / readPluginData / writePluginData`(`pluginHost.ts`)
  并声明 `hostCaps.pluginsFolder=false`;`window.tangu` 挂 `marketTypes` + `market*` 六个方法(`mobileMarket.ts`)。
  只有这一处引用 `@capacitor/filesystem`(`capacitorPluginFs.ts`),web 包图不经过它。
- **下载**:真机走 `Filesystem.downloadFile`(原生 HTTP,不受 CORS 限制、流式落 Cache、先看大小再读);
  浏览器 / 台架走 `fetch`(下载主机要给 CORS)。
- **校验**(全部发生在写盘之前):ZIP 魔数、下载 ≤25 MB、解压 ≤64 MB、≤2000 个文件、slug / type / 下载地址、
  穿越条目整包拒、按最浅的 manifest 重定根、`isDesktopOnly: true` 拒装、与内置插件同 id 拒装、有 `integrity` 就校验 SRI。
  解包规则与桌面共用 `desktop/shared/marketPackage.ts`。落盘时先清旧目录,`manifest.json` 最后写(半截目录没有 manifest,不会被当成插件)。
- **私有数据防写坏**:双槽(`.json` / `.json.alt`)+ 带序号的 JSON 信封,每次写较旧的那一槽;写到一半被杀只坏那一槽,
  读取取序号最大的有效槽 —— 不依赖 rename / 覆盖语义。
- **CSP**:`index.html` 的 `script-src` 带 `'unsafe-eval'`,插件代码经 `new Function` 求值(同桌面)。
- **包里带的 Space**(2026-10-09):`plugins/<slug>/spaces/<目录>/space.json` 由 `pluginHost.ts` 的 `listSpaces` 读出,经
  `window.tangu.spacesList` 交给渲染层的 `userSpaces.loadUserSpaces`(形状同桌面 `spaces:list` 里插件那一半)—— 装完 / 启停 / 卸载 / 冷启动
  之后 Space 跟着进出底部导航栏。`iconFile` 的查找次序与门禁同桌面(`desktop/shared/spaceIcon.ts`)。装不起来的插件(版本门禁 / 仅桌面)不贡献 Space。
  此前这座桥不存在:商店里的插件大多把 Space 写在包里,装上以后命令和视图都在,Space 不出现。
- **手机暂不支持**:插件状态栏项(没有状态栏)、捆绑包里的引擎插件 / Agent / 技能(没有本机引擎)、主题 / Space / 技能 / Agent 类市场条目、
  用户自建 Space(没有 `spacesSave` / `spacesDelete`)、npm 来源的条目(桌面同样不支持)。
- **安全**:插件代码与 App 渲染层同一个 JS 作用域 —— 能调 `window.tangu` / `window.amadeus` 的一切,包括已登录账号的云端接口
  (与桌面一样:安装 = 信任)。手机上额外的约束只有市场这一个来源和上面的包体校验;没有可见的插件目录,侧载不了。

```bash
npm run test:plugins                 # 宿主 / 市场纯逻辑单测(内存文件系统,不用 build)
rm -rf dist && npm run build && npm run e2e:plugins   # 真浏览器:市场 → 安装 → 运行 → 包里带的 Space → 刷新 → 停用 → 卸载
npm run e2e:plugins -- --negative    # 负对照:去掉 'unsafe-eval' 后必须红
```

## 深链登录(需服务端确认一处)

native 无 nginx 的同源 `/auth` 代理 → 系统浏览器打开 `${VITE_AUTH_ORIGIN}/auth?redirect=tangu://auth-callback&app=tangu-mobile`,
登录成功后 Forsion 须 302 回 `tangu://auth-callback?token=…`(Manifest intent-filter 已接收 → 存 Preferences → reload)。

⚠️ 若 Forsion `/auth` 只放行 http(s) 作 redirect 目标,需其一:
1. 服务端把 `tangu://` 加入 redirect 白名单;或
2. 用一个 https bounce 中转页 302 到 `tangu://auth-callback?token=…`;或
3. 改用 Android App Links(https + `assetlinks.json` 域名校验)。

## 里程碑

- **M0**(本 app):Tangu Space 会话控制 + APK。骨架 + 承重 spike 已验证(见 `docs/Log`)。
- **M1**:Inbox Space —— 需服务端把 inbox 从 hostExec 解耦成云端 user-scoped。
- **M2**:Amadeus Space —— 触屏笔记 UI + 数据后端(Capacitor FS 本地 → 云笔记 API 同步)。
