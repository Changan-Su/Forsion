package com.forsion.tangu.hands;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * GestureGuard 单测(JVM):手势按「接住按下点的那个窗口」判(契约 §9.4,09-26 二轮评审 P1 ×3)。
 * - 坐标点:只在接住它的窗口的整棵树里命中测试(旧实现跨全部窗口、用封顶节点表);
 * - 节点动作失败后的兜底点:按下点必须仍由当初核过的窗口接(旧实现不重判,权限框弹出来也照点);
 * - 滑动:路径按批准窗口的可见区算,按下点与路径都在它里面(旧实现按屏幕中心判策略、却从中心偏 1/3 屏起手)。
 * 跑法:cd mobile/android && ./gradlew :hands:testDebugUnitTest
 */
public class GestureGuardTest {

    /** 测试用窗口:矩形可触摸区。 */
    static final class P implements GestureGuard.Pane {
        final int id;
        final Policy.Win policy;
        final int l, t, r, b;
        final NodeView root;
        final boolean foreign;

        P(int id, String pkg, int l, int t, int r, int b, NodeView root, boolean foreign) {
            this.id = id;
            this.policy = new Policy.Win(pkg, null, "x", null);
            this.l = l;
            this.t = t;
            this.r = r;
            this.b = b;
            this.root = root;
            this.foreign = foreign;
        }

        static P app(int id, String pkg, int l, int t, int r, int b, NodeView root) {
            return new P(id, pkg, l, t, r, b, root, false);
        }

        @Override public int id() { return id; }
        @Override public Policy.Win policy() { return policy; }
        @Override public boolean contains(int x, int y) { return x >= l && x < r && y >= t && y < b; }
        @Override public int left() { return l; }
        @Override public int top() { return t; }
        @Override public int right() { return r; }
        @Override public int bottom() { return b; }
        @Override public NodeView root() { return root; }
        @Override public boolean foreignOverlay() { return foreign; }
    }

    private static FakeNode rootBox(int l, int t, int r, int b, FakeNode... kids) {
        FakeNode root = FakeNode.of("android.widget.FrameLayout").box(l, t, r, b);
        for (FakeNode k : kids) root.kid(k);
        return root;
    }

    @SafeVarargs
    private static <T> List<T> list(T... xs) {
        return new ArrayList<>(Arrays.asList(xs));
    }

    // ───────────── 坐标点(评审 P1 #2)─────────────

    /**
     * 上层窗口里一颗大的「Place order」按钮压在下层窗口一颗很小的普通按钮上。旧实现跨全部窗口挑「包含该点的最小可点节点」
     * → 挑到下层那颗小按钮 → 放行,触摸实际落在上层的下单按钮上。现在只认接住触摸的上层窗口。
     */
    @Test
    public void coordinateTapChecksOnlyTheReceivingWindow() {
        FakeNode order = FakeNode.of("android.widget.Button").text("Place order").clk().box(0, 2000, 1080, 2400);
        P top = P.app(2, "com.shop", 0, 2000, 1080, 2400, rootBox(0, 2000, 1080, 2400, order));
        FakeNode tiny = FakeNode.of("android.widget.ImageButton").desc("info").clk().box(500, 2100, 540, 2140);
        P under = P.app(1, "com.other", 0, 0, 1080, 2400, rootBox(0, 0, 1080, 2400, tiny));
        assertEquals(GestureGuard.COMMIT, GestureGuard.checkTap(list(top, under), 520, 2120, -1));
        // 下层窗口里的「支付」被上层盖住:触摸到不了它,按上层判(普通)→ 放行
        FakeNode pay = FakeNode.of("android.widget.Button").text("支付").clk().box(0, 0, 1080, 400);
        P covered = P.app(1, "com.other", 0, 0, 1080, 2400, rootBox(0, 0, 1080, 2400, pay));
        FakeNode ok = FakeNode.of("android.widget.Button").text("OK").clk().box(0, 0, 1080, 400);
        P dialog = P.app(3, "com.dialog", 0, 0, 1080, 400, rootBox(0, 0, 1080, 400, ok));
        assertNull(GestureGuard.checkTap(list(dialog, covered), 500, 200, -1));
    }

    @Test
    public void coordinateTapPolicyAndUnknowns() {
        FakeNode allow = FakeNode.of("android.widget.Button").text("Allow").clk().box(0, 1000, 1080, 1200);
        P perm = P.app(5, "com.android.permissioncontroller", 0, 800, 1080, 1400, rootBox(0, 800, 1080, 1400, allow));
        P app = P.app(1, "com.x", 0, 0, 1080, 2400, rootBox(0, 0, 1080, 2400));
        assertEquals("protected_app", GestureGuard.checkTap(list(perm, app), 500, 1100, -1));
        assertNull(GestureGuard.checkTap(list(perm, app), 500, 300, -1));
        // 取不到根的窗口 / 别的无障碍服务的浮层接住触摸 → 拒
        P opaque = P.app(6, "", 0, 0, 1080, 200, null);
        assertEquals(GestureGuard.UNKNOWN, GestureGuard.checkTap(list(opaque, app), 500, 100, -1));
        P overlay = new P(7, "com.other.a11y", 0, 0, 1080, 2400, null, true);
        assertEquals(GestureGuard.OVERLAY, GestureGuard.checkTap(list(overlay, app), 500, 1000, -1));
        // 没有窗口接住
        assertEquals(GestureGuard.UNKNOWN, GestureGuard.checkTap(list(P.app(1, "com.x", 0, 0, 10, 10, rootBox(0, 0, 10, 10))), 500, 500, -1));
    }

    // ───────────── 节点动作失败后的兜底手势(评审 P1 #3)─────────────

    /** 节点动作失败、准备在同一坐标补一枪时,权限框(或任何别的窗口)弹出来盖住了那一点 → 窗口变了,拒绝。 */
    @Test
    public void fallbackGestureRefusedWhenAnotherWindowNowCoversThePoint() {
        FakeNode target = FakeNode.of("android.widget.Button").text("Next").clk().box(0, 1000, 1080, 1200).win(1);
        P app = P.app(1, "com.x", 0, 0, 1080, 2400, rootBox(0, 0, 1080, 2400, target));
        assertNull(GestureGuard.checkTap(list(app), 540, 1100, 1)); // 当初核过的窗口仍在:放行
        // 一个普通 App 的对话框弹出来盖住了(策略不拦它)—— 仍要拒:它不是核过的那个窗口
        FakeNode cont = FakeNode.of("android.widget.Button").text("Continue").clk().box(0, 1000, 1080, 1200);
        P popup = P.app(9, "com.y", 0, 800, 1080, 1400, rootBox(0, 800, 1080, 1400, cont));
        assertEquals(GestureGuard.WINDOW_CHANGED, GestureGuard.checkTap(list(popup, app), 540, 1100, 1));
    }

    // ───────────── 滑动(评审 P1/P2 #7)─────────────

    /**
     * 分屏:上半是批准的 App(id 1),下半是另一个 App(id 2)。旧实现按整屏算路径(中心 ± 1/3 屏)、按屏幕中心判策略,
     * 下滑的按下点在 y=2000 —— 落进下半那个 App。现在:路径按批准窗口的可见区算;按整屏算的那条会被拒。
     */
    @Test
    public void swipeStartsInsideTheApprovedWindow() {
        P upper = P.app(1, "com.a", 0, 0, 1080, 1200, rootBox(0, 0, 1080, 1200));
        P lower = P.app(2, "com.b", 0, 1200, 1080, 2400, rootBox(0, 1200, 1080, 2400));
        List<P> panes = list(upper, lower);
        int[] screenPath = GestureGuard.swipePath(0, 0, 1080, 2400, "down");
        assertArrayEquals(new int[] {540, 2000, 540, 400}, screenPath);
        // 整条路径都在下半那个(普通)App 里:路径本身不出窗口,只有「按下点须由批准窗口接」这一条能拦住
        assertEquals(GestureGuard.WINDOW_CHANGED, GestureGuard.checkSwipe(panes, new int[] {540, 2200, 540, 1400}, 1));
        assertEquals(GestureGuard.WINDOW_CHANGED, GestureGuard.checkSwipe(panes, screenPath, 1));
        // 下半若是受保护 / 脱敏的 App,按下点落进去同样拒
        P alipay = P.app(2, "com.eg.android.AlipayGphone", 0, 1200, 1080, 2400, rootBox(0, 1200, 1080, 2400));
        assertNotNull(GestureGuard.checkSwipe(list(upper, alipay), screenPath, 1));

        int[] area = GestureGuard.uncovered(panes, upper, 0, 0, 1080, 2400);
        assertArrayEquals(new int[] {0, 0, 1080, 1200}, area);
        int[] path = GestureGuard.swipePath(area[0], area[1], area[2], area[3], "down");
        assertNull(GestureGuard.checkSwipe(panes, path, 1));
    }

    /** 输入法弹着(T-type 之后紧接 T-scroll 的真实场景):下滑的按下点不能落在键盘上 —— 从下沿裁掉输入法那块再算。 */
    @Test
    public void swipeAvoidsTheImeAndBars() {
        P status = P.app(10, "com.android.systemui", 0, 0, 1080, 63, rootBox(0, 0, 1080, 63));
        P ime = P.app(11, "com.google.android.inputmethod.latin", 0, 1400, 1080, 2400, rootBox(0, 1400, 1080, 2400));
        P app = P.app(1, "com.android.settings.intelligence", 0, 0, 1080, 2400, rootBox(0, 0, 1080, 2400));
        List<P> panes = list(status, ime, app);
        int[] naive = GestureGuard.swipePath(0, 0, 1080, 2400, "down");
        assertEquals(GestureGuard.WINDOW_CHANGED, GestureGuard.checkSwipe(panes, naive, 1)); // 按在键盘上
        int[] area = GestureGuard.uncovered(panes, app, 0, 0, 1080, 2400);
        assertArrayEquals(new int[] {0, 63, 1080, 1400}, area);
        for (String dir : new String[] {"down", "up", "left", "right"}) {
            int[] p = GestureGuard.swipePath(area[0], area[1], area[2], area[3], dir);
            assertNull(dir, GestureGuard.checkSwipe(panes, p, 1));
        }
    }

    @Test
    public void swipePathMustStayInsideTheWindow() {
        P app = P.app(1, "com.x", 0, 0, 1080, 1200, rootBox(0, 0, 1080, 1200));
        assertEquals(GestureGuard.OFF_WINDOW, GestureGuard.checkSwipe(list(app), new int[] {540, 600, 540, 1800}, 1));
        // 整块被盖住 → 无路可走
        P cover = P.app(2, "com.y", 0, 0, 1080, 1200, rootBox(0, 0, 1080, 1200));
        assertNull(GestureGuard.uncovered(list(cover, app), app, 0, 0, 1080, 1200));
        assertNull(GestureGuard.swipePath(0, 0, 2, 2, "down"));
        assertNull(GestureGuard.swipePath(0, 0, 100, 100, "sideways"));
    }

    @Test
    public void receiverIsTopmost() {
        P a = P.app(1, "com.a", 0, 0, 100, 100, null);
        P b = P.app(2, "com.b", 0, 0, 1080, 2400, null);
        assertSame(a, GestureGuard.receiver(list(a, b), 50, 50));
        assertSame(b, GestureGuard.receiver(list(a, b), 500, 500));
        assertTrue(GestureGuard.receiver(list(a, b), 5000, 5000) == null);
    }
}
