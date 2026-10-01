package com.forsion.tangu;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // ⚠️ 必须排在 super.onCreate **之前**:BridgeActivity 在 super 里就把桥连同插件表一起装好了,
        //    晚一步注册 JS 侧就 registerPlugin 不到,表现为「调用永远 reject: plugin not implemented」。
        registerPlugin(SpaceShortcutsPlugin.class);
        registerPlugin(LiveIslandPlugin.class);
        // P1-K8:手机作为 Unit 的身份 + 远端引擎请求的原生中继(调用方票只在原生,见 UnitPlugin)。
        registerPlugin(UnitPlugin.class);
        // P1-DL:存到系统「下载」(Capacitor WebView 没有 DownloadListener,<a download> 在 App 里是哑弹)。
        registerPlugin(DownloadsPlugin.class);
        registerPlugin(NativeModelPickerPlugin.class);
        // 重建(配置变更 / 进程被杀后从最近任务回来)会重放当初的启动 intent:点岛跳会话只在全新启动时认一次。
        LiveIslandPlugin.freshLaunch = savedInstanceState == null;
        super.onCreate(savedInstanceState);
        if (BuildConfig.NATIVE_PREVIEW) {
            getBridge().getWebView().loadUrl("https://localhost/native-preview.html");
        }
    }
}
