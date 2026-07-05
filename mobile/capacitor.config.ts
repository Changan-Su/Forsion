import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 配置。webDir=vite 产物;androidScheme=https 让 app 内容从 https://localhost 提供
 * (避免调 https 后端时的 mixed-content)。深链回跳 `tangu://auth-callback` 的 intent-filter 在
 * android/app/src/main/AndroidManifest.xml(cap add android 后手动加,见该文件的 tangu scheme 块)。
 *
 * 出包前须设绝对后端地址(native 下 location.origin=https://localhost,不能同源):
 *   VITE_API_URL=https://<forsion 网关>/api  npm run build && npx cap sync android
 *   (登录页取 VITE_AUTH_ORIGIN,缺省=去掉 /api 的同源;见 src/capacitorAuth.ts)
 */
const config: CapacitorConfig = {
  appId: 'com.forsion.tangu',
  appName: 'Tangu',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // dev 若要连 http 明文后端可临时开;prod 用 https,保持关闭。
    // allowMixedContent: false,
  },
}

export default config
