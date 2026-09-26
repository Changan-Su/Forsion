package com.forsion.tangu.hands;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;


/**
 * 手机操控 T2 的浮层(契约 §9.5):租约同意浮层 + 常驻「停止」药丸。都用 TYPE_ACCESSIBILITY_OVERLAY,
 * 由无障碍服务的 context 挂到 WindowManager —— JS / 别的 App 点不到,也不需要 SYSTEM_ALERT_WINDOW。
 *
 * ⚠️ 所有 addView / removeView 都在主线程(WindowManager 要求);binder 线程只在 ConsentWait 上等。
 *    撤销(cancelAll / 急停 / 服务销毁)可能从 binder 线程来:这里只**当场了结**等待(ConsentWait.finish(false)),撤视图一律 post 到主线程。
 * ⚠️ 文案全部由主包经 configure 下发(占位符规则见 HandsVerbs.checkStrings);本类无用户可见字面量。
 * ⚠️ 按钮文字必须唯一(台架按文字点):allow/deny/stop 三个键各不相同。
 */
final class Overlay {
    private static final String TAG = "Hands";

    private final Handler main = new Handler(Looper.getMainLooper());
    private View consentView; // 仅主线程读写
    private View pillView;
    /**
     * 在途的租约同意。⚠️ 撤销时必须当场按拒绝了结它:只 removeView 不放行的话,等待的 binder 线程要挂到期限(T2 90s),
     * 执行道一直被占、后面的指令全成 busy(09-26 评审 P2)。
     */
    private final ConsentWait.Slot consent = new ConsentWait.Slot();
    private final Rect pillBounds = new Rect(); // 手势落点若在药丸内则拒绝(§9.4)

    private Context ctx() {
        return HandsAccessibilityService.getInstance();
    }

    private WindowManager wm() {
        Context c = ctx();
        return c == null ? null : (WindowManager) c.getSystemService(Context.WINDOW_SERVICE);
    }

    /**
     * 租约同意浮层。阻塞调用线程(binder)直到用户点选、到本地期限(deadline,elapsedRealtime 口径)、或被 cancelConsent 撤销。
     * 允许 → true;拒绝 / 到期自动关闭 / 被撤销 → false。
     */
    boolean showLeaseConsent(String title, String body, String allow, String deny, long deadline) {
        Context c = ctx();
        WindowManager wm = wm();
        if (c == null || wm == null) return false;
        final ConsentWait w = consent.open();

        main.post(() -> {
            if (w.isDone()) return; // 还没挂上就被撤了 / 已到期:不再弹
            try {
                dismissConsentLocked(wm);
                FrameLayout scrim = new FrameLayout(c);
                scrim.setBackgroundColor(0xB3000000); // 半透明遮罩

                LinearLayout card = new LinearLayout(c);
                card.setOrientation(LinearLayout.VERTICAL);
                card.setBackgroundColor(Color.WHITE);
                int pad = dp(c, 24);
                card.setPadding(pad, pad, pad, pad);

                TextView t = new TextView(c);
                t.setText(title);
                t.setTextColor(0xFF111111);
                t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
                card.addView(t);

                TextView bTv = new TextView(c);
                bTv.setText(body);
                bTv.setTextColor(0xFF333333);
                bTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
                LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                blp.topMargin = dp(c, 12);
                card.addView(bTv, blp);

                LinearLayout row = new LinearLayout(c);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.END);
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rlp.topMargin = dp(c, 20);

                Button denyBtn = new Button(c);
                denyBtn.setText(deny);
                denyBtn.setOnClickListener(v -> finishConsent(wm, w, false));
                row.addView(denyBtn);

                Button allowBtn = new Button(c);
                allowBtn.setText(allow);
                allowBtn.setOnClickListener(v -> finishConsent(wm, w, true));
                LinearLayout.LayoutParams albp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                albp.leftMargin = dp(c, 8);
                row.addView(allowBtn, albp);
                card.addView(row, rlp);

                FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(
                    Math.min(dp(c, 320), widthLimit(c)), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
                scrim.addView(card, clp);

                WindowManager.LayoutParams lp = baseParams();
                lp.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL; // 遮罩内可点,遮罩本身吃掉外部点击(scrim 铺满)
                lp.width = WindowManager.LayoutParams.MATCH_PARENT;
                lp.height = WindowManager.LayoutParams.MATCH_PARENT;
                lp.gravity = Gravity.CENTER;
                consentView = scrim;
                wm.addView(scrim, lp);
            } catch (RuntimeException e) {
                Log.w(TAG, "consent overlay failed: " + e.getClass().getSimpleName());
                w.finish(false);
            }
        });

        boolean granted;
        try {
            granted = w.await(deadline - SystemClock.elapsedRealtime()); // 到期 = 拒绝
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            w.finish(false);
            granted = false;
        } finally {
            consent.close(w);
        }
        // 不论怎么了结,浮层都撤掉(排在上面那段 addView 之后,FIFO 保证不会漏撤)。
        main.post(this::dismissConsentNow);
        return granted;
    }

    /** 主线程:按钮回调。只有先了结的那一下算数。 */
    private void finishConsent(WindowManager wm, ConsentWait w, boolean yes) {
        w.finish(yes);
        dismissConsentLocked(wm);
    }

    /**
     * 撤销在途的同意(cancelAll / 急停 / 服务销毁):当场按拒绝了结 —— 等待的 binder 线程立刻返回、执行道随之放行;
     * 浮层 post 到主线程撤。任意线程可调。
     */
    void cancelConsent() {
        consent.cancel();
        main.post(this::dismissConsentNow);
    }

    /** 主线程。 */
    private void dismissConsentNow() {
        WindowManager wm = wm();
        if (wm != null) dismissConsentLocked(wm);
        else consentView = null;
    }

    private void dismissConsentLocked(WindowManager wm) {
        if (consentView != null) {
            try { wm.removeView(consentView); } catch (RuntimeException ignored) { /* not attached */ }
            consentView = null;
        }
    }

    // ───────────────────────────── 停止药丸 ─────────────────────────────

    /**
     * 租约期间常驻屏幕边缘的药丸:说明 + 停止键。点停止 → onStop.run()(撤租约 + 主包 abort)。
     * stillWanted 在主线程、真正 addView 之前再问一次(租约仍在期):授予与挂药丸之间若被撤销,撤销的 hidePill 已排在前面,
     * 不问的话药丸会在租约没了之后挂上去,而到期定时也已撤掉 —— 从此一直挂着(09-26 评审)。
     */
    void showPill(String label, String stop, Runnable onStop, java.util.function.BooleanSupplier stillWanted) {
        Context c = ctx();
        WindowManager wm = wm();
        if (c == null || wm == null) return;
        main.post(() -> {
            try {
                if (pillView != null) return; // 已在
                if (!stillWanted.getAsBoolean()) return;
                LinearLayout pill = new LinearLayout(c);
                pill.setOrientation(LinearLayout.HORIZONTAL);
                pill.setGravity(Gravity.CENTER_VERTICAL);
                pill.setBackgroundColor(0xE6C62828); // 醒目红
                int padH = dp(c, 14), padV = dp(c, 8);
                pill.setPadding(padH, padV, padH, padV);

                TextView t = new TextView(c);
                t.setText(label);
                t.setTextColor(Color.WHITE);
                t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
                pill.addView(t);

                Button stopBtn = new Button(c);
                stopBtn.setText(stop);
                stopBtn.setAllCaps(false);
                stopBtn.setOnClickListener(v -> { if (onStop != null) onStop.run(); });
                LinearLayout.LayoutParams sbp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                sbp.leftMargin = dp(c, 10);
                pill.addView(stopBtn, sbp);

                WindowManager.LayoutParams lp = baseParams();
                lp.flags = pillFlags();
                lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
                lp.y = dp(c, 40);
                lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
                lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
                pillView = pill;
                wm.addView(pill, lp);
                pill.post(() -> {
                    if (pillView == null) return;
                    int[] loc = new int[2];
                    pillView.getLocationOnScreen(loc);
                    pillBounds.set(loc[0], loc[1], loc[0] + pillView.getWidth(), loc[1] + pillView.getHeight());
                });
            } catch (RuntimeException e) {
                Log.w(TAG, "pill overlay failed: " + e.getClass().getSimpleName());
            }
        });
    }

    void hidePill() {
        WindowManager wm = wm();
        main.post(() -> {
            if (pillView != null && wm != null) {
                try { wm.removeView(pillView); } catch (RuntimeException ignored) { /* not attached */ }
            }
            pillView = null;
            pillBounds.setEmpty();
        });
    }

    void dismissAll() {
        cancelConsent();
        hidePill();
    }

    /**
     * 药丸窗口的 flags。⚠️ 必须 NOT_FOCUSABLE | NOT_TOUCH_MODAL:flags=0 的非 Activity 窗口是「模态」的 ——
     * WindowManager 给它整屏的触摸区域并把按键焦点抢走,租约期间用户碰哪儿都没反应、返回键落到药丸上,
     * T2 自己的手势点击 / 滑动 / key back 也全被它吞掉却回 ok(09-26 评审 P1)。同意浮层(scrim)刻意保持模态。
     */
    static int pillFlags() {
        return WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
    }

    /** 坐标手势落点是否在药丸内(§9.4:落在自己浮层内的手势拒绝)。 */
    boolean isInsidePill(int x, int y) {
        return !pillBounds.isEmpty() && pillBounds.contains(x, y);
    }

    private static WindowManager.LayoutParams baseParams() {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams();
        lp.type = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY;
        lp.format = PixelFormat.TRANSLUCENT;
        return lp;
    }

    private static int dp(Context c, int v) {
        return Math.round(v * c.getResources().getDisplayMetrics().density);
    }

    private static int widthLimit(Context c) {
        return c.getResources().getDisplayMetrics().widthPixels - dp(c, 32);
    }
}
