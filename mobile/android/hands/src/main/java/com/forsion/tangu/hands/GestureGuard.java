package com.forsion.tangu.hands;

import java.util.List;

/**
 * 手势(坐标点击 / 节点动作失败后的兜底点击 / 滑动)派发前的判定(手机操控 T2,契约 §9.4)。**纯 Java**,JVM 可测(GestureGuardTest)。
 *
 * 手势是注入的触摸:由**按下点所在的最上层窗口**接住,之后的移动都归它。所以一切按「谁接住按下点」判,不按屏幕中心、不按前台:
 * - 接住的窗口过策略(保护 / 脱敏 / 只读 / 敏感设置 / 同意框);认不出(取不到根、包名空)→ UNKNOWN;别的无障碍服务的浮层 → OVERLAY;
 * - 点击:在该窗口**整棵树**里过提交词表(TapGuard.commitAtPoint,不受 observation 上限影响);
 * - 滑动:路径先按「被批准的窗口」的可见区算好(整屏中心起手会落进分屏另一半 / 输入法里),按下点必须由该窗口接、路径采样点都在该窗口内;
 * - expectWindow ≥ 0:按下点必须仍由当初核过的那个窗口接 —— 节点动作失败后兜底手势之前,界面可能已经换了(权限框弹出来了),
 *   同一坐标点下去就落在新窗口上(09-26 评审 P1)。
 * 调用方(HandsBridgeService)每次派发前**现取**快照再调这里。
 */
final class GestureGuard {
    private GestureGuard() {}

    /** 判定结果里的非策略码(策略码直接用 Policy 的 protected_app / redacted / read_only_app,提交词表用 commit_target)。 */
    static final String COMMIT = "commit_target";
    static final String UNKNOWN = "unknown";
    static final String WINDOW_CHANGED = "window_changed";
    static final String OVERLAY = "overlay";
    static final String OFF_WINDOW = "off_window";

    /** 滑动路径上的采样点数(含两端)。 */
    static final int SAMPLES = 8;

    /** 一个窗口在某份快照里的样子(纯数据视图)。 */
    interface Pane {
        int id();
        Policy.Win policy();
        /** 可触摸区域是否含该点(API 33+ 按 getRegionInScreen,否则按窗口边界)。 */
        boolean contains(int x, int y);
        /** 可触摸区域的外接矩形(左上含、右下不含)。 */
        int left();
        int top();
        int right();
        int bottom();
        /** 窗口根;取不到 → null(这种窗口认不出,落在上面的手势一律拒)。 */
        NodeView root();
        /** 别的无障碍服务的浮层(不是伴随包自己的):压在一切之上、会接住手势,我们不认识它 → 一律拒。 */
        boolean foreignOverlay();
    }

    /** 按下点由谁接:panes 从上到下(getWindows 的层序),第一个可触摸区域含该点的。都不含 → null。 */
    static <P extends Pane> P receiver(List<P> panes, int x, int y) {
        for (P p : panes) if (p.contains(x, y)) return p;
        return null;
    }

    /** 点击 (x,y) 前的判定:null = 放行;否则为结果码(见类注释)。expectWindow < 0 = 不要求是哪个窗口。 */
    static String checkTap(List<? extends Pane> panes, int x, int y, int expectWindow) {
        Pane p = receiver(panes, x, y);
        String v = receiverBlock(p, expectWindow);
        if (v != null) return v;
        TapGuard.Point hit = TapGuard.commitAtPoint(p.root(), x, y);
        if (hit == TapGuard.Point.COMMIT) return COMMIT;
        if (hit == TapGuard.Point.UNKNOWN) return UNKNOWN;
        return null;
    }

    /** 滑动前的判定:按下点由 expectWindow 接、过策略、路径采样点都在它的可触摸区域内。path = {x1,y1,x2,y2}。 */
    static String checkSwipe(List<? extends Pane> panes, int[] path, int expectWindow) {
        if (path == null || path.length != 4) return UNKNOWN;
        Pane p = receiver(panes, path[0], path[1]);
        String v = receiverBlock(p, expectWindow);
        if (v != null) return v;
        for (int i = 0; i < SAMPLES; i++) {
            int x = path[0] + (int) ((long) (path[2] - path[0]) * i / (SAMPLES - 1));
            int y = path[1] + (int) ((long) (path[3] - path[1]) * i / (SAMPLES - 1));
            if (!p.contains(x, y)) return OFF_WINDOW;
        }
        return null;
    }

    private static String receiverBlock(Pane p, int expectWindow) {
        if (p == null) return UNKNOWN;
        if (p.foreignOverlay()) return OVERLAY;
        if (expectWindow >= 0 && p.id() != expectWindow) return WINDOW_CHANGED;
        if (p.root() == null || p.policy() == null || p.policy().pkg.isEmpty()) return UNKNOWN;
        return Policy.mutateBlock(p.policy());
    }

    /**
     * approved 窗口里没被更上层窗口压住的那块(与 [l,t,r,b] 相交后):只从四边裁 —— 输入法、导航条、状态栏压在边上;
     * 整块被盖 → null;压在中间的不裁(留给 checkSwipe 按采样点拒)。返回 {l,t,r,b},空 → null。
     */
    static int[] uncovered(List<? extends Pane> panes, Pane approved, int l, int t, int r, int b) {
        l = Math.max(l, approved.left());
        t = Math.max(t, approved.top());
        r = Math.min(r, approved.right());
        b = Math.min(b, approved.bottom());
        for (Pane p : panes) {
            if (p == approved || p.id() == approved.id()) break; // 只看它上面的
            if (r <= l || b <= t) return null;
            int pl = p.left(), pt = p.top(), pr = p.right(), pb = p.bottom();
            if (pr <= l || pl >= r || pb <= t || pt >= b) continue; // 不相交
            boolean fullWidth = pl <= l && pr >= r;
            boolean fullHeight = pt <= t && pb >= b;
            if (fullWidth && fullHeight) return null;
            if (fullWidth) {
                if (pt <= t) t = pb;          // 压住上沿(状态栏)
                else if (pb >= b) b = pt;     // 压住下沿(输入法 / 导航条)
            } else if (fullHeight) {
                if (pl <= l) l = pr;
                else if (pr >= r) r = pl;
            }
        }
        return r > l && b > t ? new int[] {l, t, r, b} : null;
    }

    /**
     * 在 [l,t,r,b] 里算滑动路径 {x1,y1,x2,y2}:中心起、各走 1/3 边长,手指移动方向与内容滚动方向相反。
     * 区域太小(<3px)或方向不认 → null。
     */
    static int[] swipePath(int l, int t, int r, int b, String dir) {
        if (r - l < 3 || b - t < 3 || dir == null) return null;
        int cx = l + (r - l) / 2, cy = t + (b - t) / 2;
        int dx = (r - l) / 3, dy = (b - t) / 3;
        switch (dir) {
            case "down": return new int[] {cx, cy + dy, cx, cy - dy};
            case "up": return new int[] {cx, cy - dy, cx, cy + dy};
            case "left": return new int[] {cx + dx, cy, cx - dx, cy};
            case "right": return new int[] {cx - dx, cy, cx + dx, cy};
            default: return null;
        }
    }
}
