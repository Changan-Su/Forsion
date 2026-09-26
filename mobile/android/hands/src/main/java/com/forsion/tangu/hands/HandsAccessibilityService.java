package com.forsion.tangu.hands;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 手机操控 T2 的无障碍服务(伴随包)。契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §9。
 *
 * 只做「手势 + 全局键 + 截图 + 事件订阅」这几件事,不含任何策略 / 租约判定(那些在 Policy / HandsBridgeService);
 * 读屏(getWindows 快照)也在 HandsBridgeService,让策略与序列化出自同一份快照。
 * ⚠️ 事件订阅默认置 0(未租约时不收任何无障碍事件,契约 §9.1);租约开启时才打开窗口状态 / 内容事件,
 *    用来判界面稳定(settle)。手势回调在独立 HandlerThread,绝不堵主线程。
 */
public final class HandsAccessibilityService extends AccessibilityService {
    private static final String TAG = "Hands";
    private static volatile HandsAccessibilityService instance;

    /** 最近一次窗口事件的 elapsedRealtime(settle 判定用)。 */
    private volatile long lastEventElapsed;
    /** 租约期内收到的 TYPE_WINDOWS_CHANGED 计数:截图前后比一次,期间有窗口增删 / 换焦点就丢图(ShotGuard,09-26 评审 P1)。 */
    private final AtomicLong windowsChanged = new AtomicLong();
    private volatile boolean leaseEvents;

    private HandlerThread gestureThread;
    private Handler gestureHandler;

    static HandsAccessibilityService getInstance() {
        return instance;
    }

    /** 系统设置里该服务是否已启用(不代表已连上;判 hands 状态用这个,不必绑定)。 */
    static boolean isEnabledInSettings(Context ctx) {
        try {
            if (Settings.Secure.getInt(ctx.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) {
                return false;
            }
            String enabled = Settings.Secure.getString(ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (enabled == null || enabled.isEmpty()) return false;
            String me = ctx.getPackageName() + "/" + HandsAccessibilityService.class.getName();
            for (String part : enabled.split(":")) {
                if (part.equalsIgnoreCase(me)) return true;
            }
            return false;
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        gestureThread = new HandlerThread("hands-gesture");
        gestureThread.start();
        gestureHandler = new Handler(gestureThread.getLooper());
        applyEventTypes(false); // 未租约:不收事件
        Log.i(TAG, "accessibility service connected");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        lastEventElapsed = SystemClock.elapsedRealtime();
        if (event != null && event.getEventType() == AccessibilityEvent.TYPE_WINDOWS_CHANGED) windowsChanged.incrementAndGet();
        HandsBridgeService.checkLeaseExpiry(); // 事件只在租约期内订阅;深睡醒来时靠它及时撤掉过期药丸
    }

    @Override
    public void onInterrupt() {
        // 无长任务可中断;settle 靠事件时间戳,不依赖此回调。
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) instance = null;
        if (gestureThread != null) gestureThread.quitSafely();
        HandsBridgeService.onServiceGone();
        Log.i(TAG, "accessibility service destroyed");
    }

    // ───────────────────────────── 事件订阅开关(契约 §9.1) ─────────────────────────────

    /** 租约开 → 订阅窗口状态 / 内容变化(判 settle)与窗口增删(截图守卫);租约关 → 置 0(不收任何事件)。 */
    void setLeaseEvents(boolean on) {
        if (leaseEvents == on) return;
        leaseEvents = on;
        applyEventTypes(on);
    }

    private void applyEventTypes(boolean on) {
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info == null) return;
            info.eventTypes = on
                ? (AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                    | AccessibilityEvent.TYPE_WINDOWS_CHANGED)
                : 0;
            setServiceInfo(info);
        } catch (RuntimeException e) {
            Log.w(TAG, "setServiceInfo failed: " + e.getClass().getSimpleName());
        }
    }

    long lastEventElapsed() {
        return lastEventElapsed;
    }

    long windowsChangedCount() {
        return windowsChanged.get();
    }

    void markSettleBaseline() {
        lastEventElapsed = SystemClock.elapsedRealtime();
    }

    // ───────────────────────────── 全局键 ─────────────────────────────

    boolean globalKey(String key) {
        int action;
        switch (key) {
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            default: return false;
        }
        return performGlobalAction(action);
    }

    // ───────────────────────────── 手势(HandlerThread,不堵主线程) ─────────────────────────────

    boolean tap(int x, int y, boolean longPress) {
        Path p = new Path();
        p.moveTo(x, y);
        long dur = longPress ? 700 : 60;
        GestureDescription g = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(p, 0, dur)).build();
        return dispatch(g);
    }

    boolean swipe(int x1, int y1, int x2, int y2, long durationMs) {
        Path p = new Path();
        p.moveTo(x1, y1);
        p.lineTo(x2, y2);
        GestureDescription g = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(p, 0, durationMs)).build();
        return dispatch(g);
    }

    private boolean dispatch(GestureDescription gesture) {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicBoolean ok = new AtomicBoolean(false);
        boolean posted = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { ok.set(true); latch.countDown(); }
            @Override public void onCancelled(GestureDescription g) { ok.set(false); latch.countDown(); }
        }, gestureHandler);
        if (!posted) return false;
        try {
            latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        return ok.get();
    }

    // ───────────────────────────── 截图(API 30+,契约 §9.2) ─────────────────────────────

    /** 长边 ≤1080、JPEG ≤300KB;取不到 / 低于 API 30 → null(observe 仍回文本树,只是没图)。 */
    byte[] screenshotJpeg() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null;
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<Bitmap> out = new AtomicReference<>();
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, r -> r.run(), new TakeScreenshotCallback() {
                @Override
                public void onSuccess(ScreenshotResult res) {
                    try {
                        Bitmap bmp = Bitmap.wrapHardwareBuffer(res.getHardwareBuffer(), res.getColorSpace());
                        out.set(bmp == null ? null : bmp.copy(Bitmap.Config.ARGB_8888, false));
                        if (bmp != null) bmp.recycle();
                    } catch (RuntimeException e) {
                        Log.w(TAG, "screenshot wrap failed: " + e.getClass().getSimpleName());
                    } finally {
                        try { res.getHardwareBuffer().close(); } catch (RuntimeException ignored) { /* already closed */ }
                        latch.countDown();
                    }
                }

                @Override
                public void onFailure(int errorCode) {
                    Log.w(TAG, "screenshot failed: " + errorCode);
                    latch.countDown();
                }
            });
            if (!latch.await(3, TimeUnit.SECONDS)) return null;
        } catch (RuntimeException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return null;
        }
        Bitmap bmp = out.get();
        if (bmp == null) return null;
        try {
            return encodeJpeg(bmp);
        } finally {
            bmp.recycle();
        }
    }

    private static byte[] encodeJpeg(Bitmap src) {
        int w = src.getWidth(), h = src.getHeight();
        int longEdge = Math.max(w, h);
        Bitmap scaled = src;
        boolean recycleScaled = false;
        if (longEdge > 1080) {
            float ratio = 1080f / longEdge;
            scaled = Bitmap.createScaledBitmap(src, Math.round(w * ratio), Math.round(h * ratio), true);
            recycleScaled = scaled != src;
        }
        try {
            for (int quality = 80; quality >= 30; quality -= 15) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                scaled.compress(Bitmap.CompressFormat.JPEG, quality, bos);
                byte[] bytes = bos.toByteArray();
                if (bytes.length <= 300 * 1024 || quality == 30) return bytes;
            }
        } finally {
            if (recycleScaled) scaled.recycle();
        }
        return null;
    }
}
