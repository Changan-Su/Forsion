package com.forsion.tangu.hands;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 手机操控 T2 的**节点动作**(点 / 长按 / 输入 / 滚动)。契约 §9.2。
 *
 * 输入回退链(ACTION_SET_TEXT → 重试 → 剪贴板 + ACTION_PASTE)与点击「可点祖先、再退坐标手势」的思路
 * **改写自 PokeClaw**(`tool/impl/InputTextTool.java`、`service/ClawAccessibilityService.java`,Apache-2.0),
 * 其上游为 ApkClaw。见本模块 NOTICE 的双署名。改写:去掉 PokeClaw 的自动点「允许」、typeAllMask 与调试 HTTP。
 *
 * ⚠️ 这里**只做节点动作**,不派发手势:节点动作被拒后的坐标兜底由 HandsBridgeService 在派发前一刻现取快照、
 *    按落点所在窗口重判策略与提交词表之后才发(GestureGuard)。原来 click / scroll 在这里失败就直接在同一坐标补一枪,
 *    不管这期间弹出了什么窗口(09-26 评审 P1)。
 */
final class Actions {
    private Actions() {}

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /**
     * 点击:对 actor(自身或最近的可点祖先,见 TapGuard.actor,调用方已按提交词表核过)发 ACTION_CLICK / LONG_CLICK。
     * 被拒 → false(调用方决定要不要走手势兜底)。
     * ⚠️ 绝不在动作失败后继续往上找祖先:那样实际被点的节点就不是核过词表的那个(09-26 评审 P1)。
     */
    static boolean performClick(AccessibilityNodeInfo actor, boolean longPress) {
        int action = longPress ? AccessibilityNodeInfo.ACTION_LONG_CLICK : AccessibilityNodeInfo.ACTION_CLICK;
        return actor != null && actor.performAction(action);
    }

    /**
     * 输入(链本身在 TypeChain,纯 Java):每一步变更前问 guard,剪贴板那一步在主线程里再问一次。
     * ⚠️ 只对可编辑控件:链里的 ACTION_CLICK 落在按钮上就是一次绕过提交词表的点击(09-26 评审 P1)。
     */
    static TypeChain.Outcome setText(Context ctx, AccessibilityNodeInfo node, String text, boolean append,
                                     TypeChain.Guard guard) {
        if (node == null || text == null || !node.isEditable()) return TypeChain.Outcome.FAILED;
        return TypeChain.run(new NodeField(node), (t, g) -> setClipboard(ctx, t, g), text, append, guard, Actions::sleep);
    }

    /** TypeChain.Field 的真身:AccessibilityNodeInfo 的 performAction。 */
    private static final class NodeField implements TypeChain.Field {
        private final AccessibilityNodeInfo node;

        NodeField(AccessibilityNodeInfo node) {
            this.node = node;
        }

        @Override public boolean focus() { return node.performAction(AccessibilityNodeInfo.ACTION_FOCUS); }
        @Override public boolean click() { return node.performAction(AccessibilityNodeInfo.ACTION_CLICK); }

        @Override public boolean select(int start, int end) {
            Bundle b = new Bundle();
            b.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start);
            b.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end);
            return node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, b);
        }

        @Override public boolean setText(String s) {
            Bundle b = new Bundle();
            b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, s);
            return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
        }

        @Override public String text() {
            CharSequence c = node.getText();
            return c == null ? null : c.toString();
        }

        @Override public boolean paste() { return node.performAction(AccessibilityNodeInfo.ACTION_PASTE); }
    }

    /** 滚动:自身或可滚动祖先的方向动作。都没有 / 被拒 → false(调用方决定要不要走滑动手势兜底)。 */
    static boolean scrollAction(AccessibilityNodeInfo node, String dir) {
        AccessibilityNodeInfo scrollable = scrollableFrom(node);
        int action = directionalAction(dir);
        return scrollable != null && action != 0 && scrollable.performAction(action);
    }

    private static int directionalAction(String dir) {
        switch (dir) {
            case "down": return AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.getId();
            case "up": return AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.getId();
            case "left": return AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.getId();
            case "right": return AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.getId();
            default: return 0;
        }
    }

    static AccessibilityNodeInfo scrollableFrom(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo n = node;
        while (n != null) {
            if (n.isScrollable()) return n;
            n = n.getParent();
        }
        return null;
    }

    /** 写剪贴板(主线程)。⚠️ post 进去的那一段里再问一次 guard:排队等主线程的这段时间里可能已被停止 / 过期。 */
    private static boolean setClipboard(Context ctx, String text, TypeChain.Guard guard) {
        CountDownLatch latch = new CountDownLatch(1);
        boolean[] ok = {false};
        MAIN.post(() -> {
            try {
                if (!guard.ok()) return;
                ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("hands", text));
                    ok[0] = true;
                }
            } catch (RuntimeException ignored) {
                // 个别 ROM 后台写剪贴板受限
            } finally {
                latch.countDown();
            }
        });
        try {
            latch.await(2, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return ok[0];
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
