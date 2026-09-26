package com.forsion.tangu;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * 手机操控的原生自取配置 —— apiBase 与 token **绝不接受 JS 传入**(契约 §1):
 * 主 frame 的任意脚本都能调 Capacitor 桥,要是 JS 能指定地址,它就能把 token 连同回执发往任意主机。
 *
 * - apiBase:APK 内 `assets/public/forsion-native.json`,由 mobile/vite.config.ts 的 nativeConfig() 构建期生成、
 *   cap sync 拷进来(与 src/capacitorAuth.ts 的 apiBase() 同一规则)。读一次缓存(随 APK 固定,不会变)。
 * - token:@capacitor/preferences 的存储 —— SharedPreferences 组 `CapacitorStorage`、键 `forsion_token`(不带前缀;
 *   见 node_modules/@capacitor/preferences 的 PreferencesConfiguration / Preferences.java)。**每次请求现读**:
 *   登出清掉 token 后,在途的 commit / result 自然失败(fail closed)。
 */
final class NativeConfig {
    private NativeConfig() {}

    private static final String TAG = "PhoneControl";
    static final String ASSET = "public/forsion-native.json";
    static final String PREFS_GROUP = "CapacitorStorage";
    static final String TOKEN_KEY = "forsion_token";

    private static volatile boolean loaded;
    private static volatile String apiBase;

    /** 形如 `https://api.forsion.net/api`;缺文件 / 不合规 → null。 */
    static String apiBase(Context ctx) {
        if (loaded) return apiBase;
        synchronized (NativeConfig.class) {
            if (loaded) return apiBase;
            try (InputStream in = ctx.getAssets().open(ASSET)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                apiBase = PhoneVerbs.checkApiBase(new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8)).optString("apiBase", null));
                if (apiBase == null) Log.w(TAG, "forsion-native.json has no usable apiBase; phone control stays inert");
            } catch (Exception e) {
                Log.w(TAG, "cannot read " + ASSET + " (" + e.getClass().getSimpleName() + "); phone control stays inert");
                apiBase = null;
            }
            loaded = true;
            return apiBase;
        }
    }

    static String token(Context ctx) {
        String t = ctx.getSharedPreferences(PREFS_GROUP, Context.MODE_PRIVATE).getString(TOKEN_KEY, null);
        return t == null || t.isEmpty() ? null : t;
    }
}
