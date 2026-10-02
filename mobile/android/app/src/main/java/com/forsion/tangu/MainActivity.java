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
        // 通用原生半屏(菜单 / 输入 / 确认)与原生顶栏:JS 侧 lcl/engine/nativeSheet.ts、nativeChrome.ts 的可选宿主。
        registerPlugin(NativeSheetPlugin.class);
        registerPlugin(NativeChromePlugin.class);
        // 系统文件选择器:原生半屏里点「添加文件」时 WebView 没有用户激活,<input type=file>.click() 会被 Chromium 静默丢掉。
        registerPlugin(NativeFilePickerPlugin.class);
        // 市场安装包的封顶下载:流式落盘、超过上限当场中止(Filesystem.downloadFile 是整个下完才看大小,能把存储写满)。
        registerPlugin(MarketDownloadPlugin.class);
        // 重建(配置变更 / 进程被杀后从最近任务回来)会重放当初的启动 intent:点岛跳会话只在全新启动时认一次。
        LiveIslandPlugin.freshLaunch = savedInstanceState == null;
        super.onCreate(savedInstanceState);
        // 仅 -PnativePreviewSample 的 debug 预览包:启动即进审阅样本页。-PnativePreview(并装预览)跑的是真 App。
        if (BuildConfig.NATIVE_PREVIEW_SAMPLE) {
            getBridge().getWebView().loadUrl("https://localhost/native-preview.html");
        }
    }
}
