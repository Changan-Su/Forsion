package com.forsion.tangu;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import androidx.lifecycle.Lifecycle;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import java.util.Collections;

/**
 * 唯一的 Activity。⚠️ 清单里的 `.MainActivity` 不是它,而是指向它的默认桌面入口(activity-alias,见 LauncherIconPlugin):
 * 代码里要显式打开本页一律用 AppActivity.class —— 入口会随应用图标被关掉,这个类不会。
 */
public class AppActivity extends BridgeActivity {
    /** WebView 的渲染进程没了、页面还没重建(在后台时等回到前台再建,见 onRenderProcessGone)。 */
    private boolean rendererGone;

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
        // 系统返回手势的过程(Android 14 起才有)与「再返回一次退出」的提示;一下返回做什么仍在页面里定(MobileRoot)。
        registerPlugin(NativeBackPlugin.class);
        // 系统文件选择器:原生半屏里点「添加文件」时 WebView 没有用户激活,<input type=file>.click() 会被 Chromium 静默丢掉。
        registerPlugin(NativeFilePickerPlugin.class);
        // 分享到 Forsion:系统分享面板送来的文字 / 文件(清单里 AppActivity 的 SEND / SEND_MULTIPLE 过滤器)。
        registerPlugin(ShareInboxPlugin.class);
        // 市场安装包的封顶下载:流式落盘、超过上限当场中止(Filesystem.downloadFile 是整个下完才看大小,能把存储写满)。
        registerPlugin(MarketDownloadPlugin.class);
        registerPlugin(PhoneControlPlugin.class);
        // 桌面图标跟随「设置 → 外观 → 应用图标」里的内置图标(清单里的入口别名)。
        registerPlugin(LauncherIconPlugin.class);
        // 重建(配置变更 / 进程被杀后从最近任务回来)会重放当初的启动 intent:点岛跳会话只在全新启动时认一次。
        LiveIslandPlugin.freshLaunch = savedInstanceState == null;
        super.onCreate(savedInstanceState);
        // 渲染进程被系统回收(后台内存紧,它比主进程还大)时,不接这一下 Chromium 会连整个 App 一起杀掉
        // ("wasn't handled by all associated webviews, killing application"):回来就是冷启动。接住它,只重建页面。
        // 系统在还原(进程在后台被杀后从最近任务回来 / 上面渲染进程没了的重建):告诉页面「这是回来,不是新开」,
        // 页面据此回到上次的 Space、会话和草稿(mobile/src/restoreSnapshot.ts),新开照旧进主页。必须赶在页面脚本之前:
        // 启动 Space 是模块装载时同步定的。
        // 只给这一份文档:之后页面自己 reload(登录成功、换账号)不是「回来」,不许再还原(上一个账号的草稿会被放回去)。
        // ponytail: 注册排在 bridge 首次 loadUrl 之后;API 35 模拟器多轮都赶上了首个文档。没赶上 / 系统 WebView 太旧 = 按新开处理(进主页),不出错。
        ScriptHandler restoredFlag = null;
        if (savedInstanceState != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            String origin = Uri.parse(getBridge().getAppUrl()).buildUpon().path(null).fragment(null).clearQuery().build().toString();
            restoredFlag = WebViewCompat.addDocumentStartJavaScript(getBridge().getWebView(), "window.__forsionRestored=true", Collections.singleton(origin));
        }
        final ScriptHandler oneShot = restoredFlag;
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                if (oneShot != null) oneShot.remove();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                onRendererGone(view);
                return true;
            }
        });
        // 不带「可调试」标记的并装预览(-PnativePreviewFast):桥按该标记把远程调试关了,这里再打开。只有 debug 那一档能把它设成真。
        if (BuildConfig.WEBVIEW_INSPECTABLE) android.webkit.WebView.setWebContentsDebuggingEnabled(true);
        // 仅 -PnativePreviewSample 的 debug 预览包:启动即进审阅样本页。-PnativePreview(并装预览)跑的是真 App。
        if (BuildConfig.NATIVE_PREVIEW_SAMPLE) {
            getBridge().getWebView().loadUrl("https://localhost/native-preview.html");
        }
    }

    /**
     * 这个 WebView 已不能再用(系统要求摘下并销毁)。在前台就当场重建 Activity;在后台先不建 —— 渲染进程正是为腾内存被收的,
     * 马上再起一个多半又被收 —— 等回到前台再建。重建带 savedInstanceState,页面按「回来」还原(而不是冷启动落主页)。
     * 进程保住了:插件里的前台服务、Unit 中继等原生状态都还在,只有页面重载。
     */
    private void onRendererGone(WebView view) {
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        view.destroy();
        rendererGone = true;
        if (getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) recreate();
    }

    /** 页面已死时来了新 intent(登录回跳 / 分享 / 点岛):旧 Bridge 的插件转给死页面就丢了,重建又会把它当旧事跳过。
     *  直接按「新开」带着它重新起一次:插件按冷启动处理启动 intent,一条不丢。 */
    @Override
    protected void onNewIntent(Intent intent) {
        if (rendererGone) {
            rendererGone = false;
            finish();
            startActivity(intent);
            return;
        }
        super.onNewIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (rendererGone) {
            rendererGone = false;
            recreate();
        }
    }
}
