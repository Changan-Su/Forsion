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
  它不代表外部插件安装/市场加载已经可用；移动桥当前 `listPlugins` 返回空列表，需另行设计外部加载与能力声明。
  预览消息和模型是样本，无登录、后端会话或模型请求。

### 独立预览 APK 与截图

```bash
FORSION_NATIVE_PREVIEW=1 npm run build
npx cap sync android
./android/gradlew -p android :app:assembleDebug :app:testDebugUnitTest -PnativePreview
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.forsion.tangu.nativepreview/com.forsion.tangu.MainActivity
# 等待应用出现后；仅连接一台设备，Node 22+
OUT=/absolute/review-output node scripts/native-picker-emu.cjs
```

预览使用独立包名 `com.forsion.tangu.nativepreview`，不会覆盖已安装正式版。
`native-preview.html` 只在显式预览构建中包含；发布前用普通 `npm run build` 再 `npx cap sync android`，
并去掉 Gradle 的 `-PnativePreview`。原生模型面板也接入普通应用入口，预览开关只控制样本页面与独立安装身份。

验收脚本通过真实 Compose 无障碍节点操作面板，并检查 Web 侧的草稿结果；输出浅色、深色、
英文、搜索键盘与插件截图，以及 `acceptance.json`。当前已覆盖 Android 15 模拟器；
真机、其他 Android 版本和完整外部插件目录仍待后续验收。

## Android 原生外壳：顶栏 + 通用底单（2026-10-02）

WebView 仍是内核，外壳换原生：两个可选宿主接缝在 `lcl/engine`，Android 宿主在 `src/nativeChrome.ts` / `src/nativeSheet.ts`，
Kotlin 在 `NativeChrome*` / `NativeSheet*`。没装宿主（桌面、Web、浏览器调试）时一切照旧走 Web UI。

- **`NativeChrome`**：原生 Material 顶栏取代 `.mb-topbar`（左抽屉 / 标题 / 右抽屉 / 标签页数 / 更多）。
  WebView 由插件放在顶栏下方（自管 insets，`--mb-top` 归零）。设置、引导、成就等全屏层用 `useNativeChromeClaim({ mode: 'hidden' })` 收起顶栏。
- **`NativeSheet`**：通用 Compose 半屏底单，三种 `kind`：`menu`（分组 / 勾选 / 子菜单 / 搜索 / 行尾按钮）、`prompt`、`confirm`。
  调用方用 `presentNativeMenu` / `presentNativePrompt` / `presentNativeConfirm`，拿到 `{ handled: false }` 就渲染自己的 Web UI。
  已接入：标签页底单、更多底单（无自定义组件项时）、`ContextMenu` 原语（`pickNativeCtxItem`）、`askString`、无 children 的 `ConfirmDialog`。
- 文案、图标、主题全部由 Web 侧传入（i18n 跟随当前语言）；Kotlin 不持有用户可见字符串，只做载荷校验（大小 / 深度 / id 唯一）。

真机验收（一台模拟器/设备，debug APK，后端全由 CDP 桩住，不碰真服务器；结束时还原 token / 语言 / 主题）：

```bash
rm -rf dist && npm run build && npx cap sync android
./android/gradlew -p android :app:assembleDebug :app:testDebugUnitTest
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
OUT=/absolute/out npm run emu:nativeshell   # ONLY=tabs,prompt 只跑子集
```

负对照在 `e2e:boot`：浏览器里没有原生宿主时必须仍是 `.mb-topbar` + Web 标签页底单。

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
