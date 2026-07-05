# Tangu Mobile(Android 优先)

移动端 Tangu:复用 `../desktop/frontend` 渲染层(Vite 别名,不复制源码),换单列 `MobileShell` 外壳,
Capacitor 打 Android APK,走 Forsion 网关云连(手机控云会话)。iOS 暂缓。

## 架构

- 渲染层经 `@ → ../desktop/frontend/src` 别名整体复用;**desktop 源零改**。
- `vite.config.ts` 的 `resolveId` 插件按绝对路径把引擎 3 个 Dockview 模块换成移动版:
  `engine/workspaceStore → src/engine/mobileWorkspaceStore`、`engine/{Shell,WorkspaceHost} → src/engine/emptyHost`。
- `src/engine/MobileShell.tsx` = 顶栏 + 全屏主 leaf + **底部 Space 切换栏** + 侧滑抽屉。
- `src/mobileShim.ts` + `src/capacitorAuth.ts`:native 用 Preferences 存 token + 深链登录;web(dev)用 localStorage + /auth。

## 开发(浏览器窄屏联调,不出包)

```bash
npm i
# 指向可用的 Forsion 网关;dev 也可用 vite proxy 到 localhost:3001
VITE_API_URL=https://<forsion>/api npm run dev   # http://localhost:5274
```

## 出 Android APK

**出包前必须**设绝对后端地址(native 下 `location.origin=https://localhost`,不能同源):

```bash
npm ci
VITE_API_URL=https://<forsion 网关>/api \
VITE_AUTH_ORIGIN=https://<forsion 站点> \   # 提供 /auth 登录页的 origin;缺省=去掉 /api
  npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
# 产物:android/app/build/outputs/apk/debug/app-debug.apk
```

需本机/CI 具备 Android SDK + JDK 17 + gradle。`android/` 已入库(含深链 intent-filter),CI 直接 build 即可。

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
