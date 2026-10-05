import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 配置。webDir=vite 产物;androidScheme=https 让 app 内容从 https://localhost 提供
 * (避免调 https 后端时的 mixed-content)。深链回跳 `tangu://auth-callback` 的 intent-filter 在
 * android/app/src/main/AndroidManifest.xml(cap add android 后手动加,见该文件的 tangu scheme 块)。
 *
 * 后端地址:native 缺省烤入生产网关 https://api.forsion.net(见 src/capacitorAuth.ts),
 * dev/自托管出包用 VITE_API_ORIGIN 覆盖:
 *   VITE_API_ORIGIN=https://<forsion 网关>  npm run build && npx cap sync android
 *
 * ⚠️ appId/scheme 是签名与深链的绑定身份,永不改;显示名只改 appName + res/values/strings.xml。
 */
const config: CapacitorConfig = {
  appId: 'com.forsion.tangu',
  appName: 'Forsion',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // Android 15 enforces edge-to-edge: keep Web content clear of system bars/cutouts.
    adjustMarginsForEdgeToEdge: 'auto',
    // dev 若要连 http 明文后端可临时开;prod 用 https,保持关闭。
    // allowMixedContent: false,
  },
}

export default config
