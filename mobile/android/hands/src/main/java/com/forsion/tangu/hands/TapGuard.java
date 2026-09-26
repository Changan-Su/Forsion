package com.forsion.tangu.hands;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * 点击的提交词表防线(手机操控 T2,契约 §9.4)。**纯 Java**,只吃 NodeView,JVM 可测(TapGuardTest)。
 *
 * ⚠️ 09-26 评审:原来只看模型挑的那个节点自己的 text(非空时连 desc 都不看),可 ACTION_CLICK 落在「自身或最近的可点祖先」上 ——
 *    点无字的可点容器(子节点写着「提交订单」)、或点支付按钮里不可点的「¥25.50」,都会绕过词表把单下了;坐标点击则完全不查。
 *    现在的口径:先定下**实际被点的节点**(actor),再拿它自己的 text + desc、它子树里的短标签、所选节点自身的 text + desc 比对;
 *    手势(坐标点 / 兜底)按落点在**接住它的那个窗口的整棵树**里命中测试(commitAtPoint)。仍是**启发式**(纯图标、无标签控件会漏),
 *    对外不许写成硬边界。
 * ⚠️ 09-26 二轮评审 P1:手势命中测试原来用的是 observation 的节点表 —— 那张表有 250 节点 / 12k 字符上限,而且跨全部窗口;
 *    长页面里上限之外的「提交订单」、或被别的窗口盖住的节点,坐标点下去都查不到。现在只认接住手势的窗口、整棵树现走(不受上限影响),
 *    走不完(超 MAX_WALK)/ 落点下什么都认不出 → UNKNOWN,调用方拒绝,不按「没命中」放行。
 */
final class TapGuard {
    private TapGuard() {}

    /** 子树扫描上限(节点数):按钮的子树很小,整页容器的子树才会超 —— 超了就停,不再往下看。 */
    static final int MAX_SCAN = 120;
    /**
     * 后代文字只认短标签(按钮式,≤24 字):可点的内容卡片(B 站 / 小红书搜索结果)标题里常带「删除」「购买」,
     * 拿长标题比子串会让整张卡点不动;按钮上的字(「提交订单 ¥25.50」「Place order」)都短。
     */
    static final int SHORT_LABEL = 24;
    /** 手势命中测试整棵树的上限(节点数)。Chrome 等 WebView 会吐出几千个虚拟节点;超了 → UNKNOWN(拒绝),不截断了事。 */
    static final int MAX_WALK = 6000;

    /** 手势落点的判定。 */
    enum Point { OK, COMMIT, UNKNOWN }

    /** ACTION_CLICK / LONG_CLICK 实际落到的节点:自身可点(长按:可长按)→ 自身;否则最近的这样的祖先;都没有 → null(走手势)。 */
    static NodeView actor(NodeView chosen, boolean longPress) {
        for (NodeView n = chosen; n != null; n = n.parent()) {
            if (longPress ? n.longClickable() : n.clickable()) return n;
        }
        return null;
    }

    static boolean contains(NodeView n, int x, int y) {
        return n.right() > n.left() && n.bottom() > n.top()
            && x >= n.left() && x < n.right() && y >= n.top() && y < n.bottom();
    }

    /**
     * 按句柄点 chosen(节点动作那一下)会不会碰到提交类控件:chosen 自身(text + desc)、actor 及其子树。
     * 动作被拒后的手势兜底**不在这里判** —— 调用方在派发手势前一刻按落点重判(GestureGuard.checkTap → commitAtPoint)。
     */
    static boolean commitForNode(NodeView chosen, boolean longPress) {
        if (ownCommit(chosen)) return true;
        NodeView act = actor(chosen, longPress);
        return act != null && subtreeCommit(act);
    }

    /**
     * 手势按在 (x,y) 会不会碰到提交类控件。root = **接住这次手势的窗口**的根,整棵树现走(不受 observation 上限影响)。
     * 候选 = 可见、含该点、可点(或可长按)、且没有同样含该点的可点后代的节点(即最里层的可点节点):
     * 一般只有一个;互相重叠又不嵌套的(浮层按钮压在列表项上)不止一个 —— 谁真接住触摸由绘制顺序定,我们判不准,**全部**比对。
     * 另比对落点下最小节点自身的 text + desc;没有候选时退到它及其最近可点祖先的子树。
     * 走超上限 / 落点下一个节点都没有 → UNKNOWN。
     */
    static Point commitAtPoint(NodeView root, int x, int y) {
        if (root == null) return Point.UNKNOWN;
        List<NodeView> candidates = new ArrayList<>();
        Walk w = new Walk(x, y);
        w.visit(root, candidates);
        if (w.overflow) return Point.UNKNOWN;
        for (NodeView c : candidates) {
            if (subtreeCommit(c)) return Point.COMMIT;
        }
        NodeView s = w.smallest;
        if (s == null) return candidates.isEmpty() ? Point.UNKNOWN : Point.OK;
        if (ownCommit(s)) return Point.COMMIT;
        if (candidates.isEmpty()) {
            // 落点下没有可点节点:触摸冒泡到最近的可点祖先(若它的边界没把该点包进来,上面就没收成候选)。
            // ⚠️ 不扫 s 自己的子树:s 是含该点的最小节点,它的后代都不在指下 —— 落在空白处时 s 常是整窗根,
            //    扫它等于「整页有个『发送』就哪儿都不许点」。
            NodeView act = actor(s, false);
            if (act != null && subtreeCommit(act)) return Point.COMMIT;
        }
        return Point.OK;
    }

    /** 一次整树命中遍历的状态。 */
    private static final class Walk {
        final int x;
        final int y;
        int seen;
        boolean overflow;
        NodeView smallest;
        long smallestArea = Long.MAX_VALUE;

        Walk(int x, int y) {
            this.x = x;
            this.y = y;
        }

        /** 返回 n 或其后代里有没有「可见、含该点、可点」的节点;最里层的那些收进 candidates。 */
        boolean visit(NodeView n, List<NodeView> candidates) {
            if (n == null || overflow) return false;
            if (++seen > MAX_WALK) {
                overflow = true;
                return false;
            }
            boolean inside = n.visibleToUser() && contains(n, x, y);
            boolean below = false;
            int c = n.childCount();
            for (int i = 0; i < c && !overflow; i++) {
                if (visit(n.child(i), candidates)) below = true;
            }
            boolean clk = inside && (n.clickable() || n.longClickable());
            if (clk && !below) candidates.add(n);
            if (inside) {
                long area = (long) (n.right() - n.left()) * (n.bottom() - n.top());
                if (area < smallestArea) {
                    smallest = n;
                    smallestArea = area;
                }
            }
            return below || clk;
        }
    }

    private static boolean ownCommit(NodeView n) {
        return Policy.isCommitLabel(n.text()) || Policy.isCommitLabel(n.contentDescription());
    }

    /** n 自身 text + desc(不限长),加上子树里可见后代的短标签(text / desc 各自 ≤ SHORT_LABEL),最多看 MAX_SCAN 个节点。 */
    static boolean subtreeCommit(NodeView root) {
        if (ownCommit(root)) return true;
        ArrayDeque<NodeView> queue = new ArrayDeque<>();
        enqueueChildren(root, queue);
        int seen = 0;
        while (!queue.isEmpty() && seen < MAX_SCAN) {
            NodeView n = queue.poll();
            seen++;
            if (n.visibleToUser() && (shortCommit(n.text()) || shortCommit(n.contentDescription()))) return true;
            enqueueChildren(n, queue);
        }
        return false;
    }

    private static boolean shortCommit(String label) {
        return label != null && label.trim().length() <= SHORT_LABEL && Policy.isCommitLabel(label);
    }

    private static void enqueueChildren(NodeView n, ArrayDeque<NodeView> queue) {
        int c = n.childCount();
        for (int i = 0; i < c; i++) {
            NodeView k = n.child(i);
            if (k != null) queue.add(k);
        }
    }
}
