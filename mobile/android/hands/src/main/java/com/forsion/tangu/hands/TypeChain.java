package com.forsion.tangu.hands;

import java.util.List;

/**
 * type 的输入链(手机操控 T2,契约 §9.2)。**纯 Java**:只吃 Field / Clip / Guard 三个接口,JVM 可测(TypeChainTest);
 * 真身在 Actions(AccessibilityNodeInfo + 剪贴板)。
 *
 * 回退链 ACTION_SET_TEXT(三次重试)→ 剪贴板 + ACTION_PASTE 的思路**改写自 PokeClaw**(`tool/impl/InputTextTool.java`,
 * Apache-2.0,上游 ApkClaw),见本模块 NOTICE。
 *
 * ⚠️ 一条 type 是**一串**副作用(聚焦 / 点击 / 清空 / 重试 / 写剪贴板 / 粘贴),只在开头判一次闸不够:用户点了「停止」、
 *    租约到期、期限已过,后面几步照样落下去(09-26 评审 P1)。所以**每一步变更之前**都问 Guard,
 *    剪贴板那一步(主线程 post)由 Clip 实现方在 post 进去的那段里**再问一次**。Guard 一旦为假,整条链就此停下(STOPPED)。
 */
final class TypeChain {
    private TypeChain() {}

    /** 可编辑控件的最小动作面(真身:AccessibilityNodeInfo 的 performAction)。 */
    interface Field {
        boolean focus();
        boolean click();
        boolean select(int start, int end);
        boolean setText(String s);
        String text();
        boolean paste();
    }

    /** 写剪贴板。实现方在真正写之前(主线程那一步里)再问一次 guard,为假就不写并返回 false。 */
    interface Clip {
        boolean set(String text, Guard guard);
    }

    /** 「还可以继续」:租约在期且属本账号 ∧ 没被撤销(代数没变)∧ 没过本地期限。 */
    interface Guard {
        boolean ok();
    }

    interface Sleeper {
        void sleep(long ms);
    }

    enum Outcome { DONE, FAILED, STOPPED }

    static Outcome run(Field f, Clip clip, String text, boolean append, Guard g, Sleeper sleeper) {
        if (f == null || text == null) return Outcome.FAILED;
        if (!g.ok()) return Outcome.STOPPED;
        f.focus();
        if (!g.ok()) return Outcome.STOPPED;
        f.click();
        if (!append && !clear(f, g)) return Outcome.STOPPED;

        for (int attempt = 0; attempt < 3; attempt++) {
            if (!g.ok()) return Outcome.STOPPED;
            String existing = f.text();
            String candidate = append ? (existing != null ? existing : "") + text : text;
            if (f.setText(candidate)) return Outcome.DONE;
            sleeper.sleep(150);
            if (!g.ok()) return Outcome.STOPPED;
            f.focus();
            if (!g.ok()) return Outcome.STOPPED;
            f.click();
        }

        if (!g.ok()) return Outcome.STOPPED;
        if (!clip.set(text, g)) return g.ok() ? Outcome.FAILED : Outcome.STOPPED;
        if (append) {
            if (!g.ok()) return Outcome.STOPPED;
            String existing = f.text();
            int end = existing != null ? existing.length() : 0;
            f.select(end, end);
        } else if (!clear(f, g)) {
            return Outcome.STOPPED;
        }
        if (!g.ok()) return Outcome.STOPPED;
        return f.paste() ? Outcome.DONE : Outcome.FAILED;
    }

    /** 全选 + 置空。两步之间也问 guard;为假返回 false。 */
    private static boolean clear(Field f, Guard g) {
        if (!g.ok()) return false;
        f.select(0, Integer.MAX_VALUE);
        if (!g.ok()) return false;
        f.setText("");
        return true;
    }

    /**
     * 无句柄 type 的目标:当前**输入焦点**所在的可编辑控件(契约 §9.2)。没有 → null(调用方回 invalid_args、要求传句柄)。
     * ⚠️ 09-26 评审 P2:原来没有焦点时退到「第一个可编辑控件」—— 模型以为在往搜索框里打字,实际写进了页面上随便哪个框。
     * roots = 本次快照里**未被脱敏略去**的窗口根(从上到下)。
     */
    static NodeView focusedEditable(List<NodeView> roots) {
        for (NodeView root : roots) {
            NodeView f = findFocusedEditable(root, new int[] {0});
            if (f != null) return f;
        }
        return null;
    }

    private static final int MAX_WALK = 6000;

    private static NodeView findFocusedEditable(NodeView n, int[] seen) {
        if (n == null || seen[0]++ >= MAX_WALK) return null;
        if (n.focused() && n.editable() && n.visibleToUser()) return n;
        int c = n.childCount();
        for (int i = 0; i < c; i++) {
            NodeView r = findFocusedEditable(n.child(i), seen);
            if (r != null) return r;
        }
        return null;
    }
}
