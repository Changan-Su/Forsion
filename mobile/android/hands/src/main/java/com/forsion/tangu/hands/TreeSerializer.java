package com.forsion.tangu.hands;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 屏幕树 → 模型直读的文本 observation(手机操控 T2,契约 §9.3)。**纯 Java**:输入 NodeView,输出文本 + 句柄表,
 * 于是能在 JVM 上跑 JUnit(TreeSerializerTest),不碰 android.*。
 *
 * 只收有意义的节点(可点 / 可长按 / 可编辑 / 可滚动 / 可勾选 / 有文字或 contentDescription);纯图标按钮用
 * resource-id 短名兜底。上限 250 节点 / 12000 字符,超出写 `(+M more not shown)`。
 * 密码框文本恒为 `••••`(§9.3),真值绝不出现在 observation 里。
 *
 * ⚠️ 句柄 `[n]`(n 从 1 起)只对这一个 obs 有效。返回的 sigs / nodes 与句柄一一对应(下标 n-1),
 *    调用方据此建 obs→节点映射,并把 sigs 存进 obs 历史供 resolve()(§9.3)。
 */
final class TreeSerializer {
    private TreeSerializer() {}

    static final int MAX_NODES = 250;
    static final int MAX_CHARS = 12_000;
    static final String MASK = "••••"; // ••••
    private static final int MAX_TEXT = 120; // 单个字段截断,防一条长文本撑爆整树

    /**
     * 一个节点的身份签名(句柄解析用):resource-id + 类名 + 文本 + contentDescription。
     * ⚠️ desc 必须在内:无 id 的 Compose / RN / Flutter 纯图标按钮只有 desc,缺了它就成了「空身份」永远重绑不上(09-26 评审)。
     */
    static final class Sig {
        final String viewId;
        final String className;
        final String text;
        final String desc;

        Sig(String viewId, String className, String text, String desc) {
            this.viewId = norm(viewId);
            this.className = norm(className);
            this.text = norm(text);
            this.desc = norm(desc);
        }

        private static String norm(String s) {
            return s == null ? "" : s;
        }

        @Override
        public boolean equals(Object o) {
            if (!(o instanceof Sig)) return false;
            Sig s = (Sig) o;
            return viewId.equals(s.viewId) && className.equals(s.className) && text.equals(s.text) && desc.equals(s.desc);
        }

        @Override
        public int hashCode() {
            return ((viewId.hashCode() * 31 + className.hashCode()) * 31 + text.hashCode()) * 31 + desc.hashCode();
        }

        /** 空身份 = 无 id、无文本、无 desc(只剩类名):满屏 FrameLayout 会误命中,不许按签名重绑。 */
        boolean isEmptyIdentity() {
            return viewId.trim().isEmpty() && text.trim().isEmpty() && desc.trim().isEmpty();
        }
    }

    static final class Result {
        final String text;
        /** 下标 i = 句柄 [i+1]。 */
        final List<Sig> sigs;
        final List<NodeView> nodes;

        Result(String text, List<Sig> sigs, List<NodeView> nodes) {
            this.text = text;
            this.sigs = sigs;
            this.nodes = nodes;
        }

        int size() {
            return nodes.size();
        }
    }

    /**
     * @param roots     从前到后的窗口根(getWindows 顺序;含输入法与浮层,调用方已剔除伴随包自己的浮层窗口)
     * @param appLabel  前台 App 显示名(取不到给包名)
     * @param pkg       前台包名
     * @param screenW/H 屏幕像素
     * @param obs       本次 observation 序号
     */
    static Result serialize(List<NodeView> roots, String appLabel, String pkg, int screenW, int screenH, int obs) {
        return serialize(roots, appLabel, pkg, screenW, screenH, obs, 0);
    }

    /** @param hiddenWindows 因属脱敏包而整窗略去的窗口数(§9.4 多窗口:分屏 / 通知栏盖在支付宝上时,支付宝那窗不出树)。 */
    static Result serialize(List<NodeView> roots, String appLabel, String pkg, int screenW, int screenH, int obs,
                            int hiddenWindows) {
        StringBuilder head = new StringBuilder();
        head.append("app: ").append(clean(appLabel)).append(" (").append(clean(pkg)).append(')')
            .append(" · screen ").append(screenW).append('x').append(screenH)
            .append(" · obs ").append(obs).append('\n');

        List<Sig> sigs = new ArrayList<>();
        List<NodeView> nodes = new ArrayList<>();
        StringBuilder body = new StringBuilder();
        int[] omitted = {0}; // 因超限没收进来的有意义节点数
        for (NodeView root : roots) {
            walk(root, body, sigs, nodes, head.length(), omitted);
        }

        StringBuilder out = new StringBuilder(head).append(body);
        if (omitted[0] > 0) {
            out.append("…(+").append(omitted[0]).append(" more not shown)\n");
        }
        if (hiddenWindows > 0) {
            out.append("(").append(hiddenWindows).append(hiddenWindows == 1 ? " window" : " windows")
                .append(" from a private app hidden)\n");
        }
        return new Result(out.toString(), sigs, nodes);
    }

    private static void walk(NodeView n, StringBuilder body, List<Sig> sigs, List<NodeView> nodes,
                             int headLen, int[] omitted) {
        if (n == null) return;
        if (n.visibleToUser() && meaningful(n)) {
            if (nodes.size() >= MAX_NODES || headLen + body.length() >= MAX_CHARS) {
                omitted[0]++;
            } else {
                int handle = nodes.size() + 1;
                String line = line(n, handle);
                if (headLen + body.length() + line.length() > MAX_CHARS) {
                    omitted[0]++;
                } else {
                    body.append(line);
                    nodes.add(n);
                    sigs.add(new Sig(n.viewIdResourceName(), n.className(), n.password() ? MASK : n.text(), n.contentDescription()));
                }
            }
        }
        int count = n.childCount();
        for (int i = 0; i < count; i++) {
            walk(n.child(i), body, sigs, nodes, headLen, omitted);
        }
    }

    /** 有意义 = 可交互(点 / 长按 / 编辑 / 滚动 / 勾选)或有文字 / contentDescription。 */
    static boolean meaningful(NodeView n) {
        if (n.clickable() || n.longClickable() || n.editable() || n.scrollable() || n.checkable()) return true;
        return notBlank(n.text()) || notBlank(n.contentDescription());
    }

    private static String line(NodeView n, int handle) {
        StringBuilder b = new StringBuilder();
        b.append('[').append(handle).append("] ").append(shortClass(n.className()));
        String label = n.password() ? MASK : labelOf(n);
        b.append(" \"").append(clean(trunc(label))).append('"');

        List<String> flags = new ArrayList<>();
        if (n.clickable()) flags.add("clk");
        if (n.longClickable()) flags.add("long");
        if (n.editable()) flags.add("edit");
        if (n.scrollable()) flags.add("scroll");
        if (n.focused()) flags.add("focused");
        if (n.checkable()) flags.add(n.isChecked() ? "checked" : "unchecked");
        if (!n.enabled()) flags.add("disabled");
        if (!flags.isEmpty()) {
            b.append(" {");
            for (int i = 0; i < flags.size(); i++) {
                if (i > 0) b.append(',');
                b.append(flags.get(i));
            }
            b.append('}');
        }

        if (n.editable() && notBlank(n.hintText())) {
            b.append(" hint=\"").append(clean(trunc(n.hintText()))).append('"');
        }
        // 纯图标按钮(无文字 / 无描述)用 resource-id 短名兜底,给模型一个抓手。
        if (isBlank(label) && !n.password()) {
            String id = shortId(n.viewIdResourceName());
            if (id != null) b.append(" id=").append(id);
        }
        b.append(" (").append(n.centerX()).append(',').append(n.centerY()).append(")\n");
        return b.toString();
    }

    /** android.widget.Button → Button;带 $ 的匿名内部类取到 $ 前。 */
    static String shortClass(String cn) {
        if (isBlank(cn)) return "View";
        String s = cn;
        int dot = s.lastIndexOf('.');
        if (dot >= 0) s = s.substring(dot + 1);
        int dollar = s.indexOf('$');
        if (dollar > 0) s = s.substring(0, dollar);
        return s.isEmpty() ? "View" : s;
    }

    /** com.android.settings:id/search_action_bar → search_action_bar。 */
    static String shortId(String viewId) {
        if (isBlank(viewId)) return null;
        int slash = viewId.lastIndexOf('/');
        String s = slash >= 0 ? viewId.substring(slash + 1) : viewId;
        s = s.trim();
        return s.isEmpty() ? null : s;
    }

    private static String trunc(String s) {
        if (s == null) return "";
        return s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) + "…" : s;
    }

    /** 剥换行 / 制表 / 控制字符与 bidi 覆写(§3.3 同口径),压成单行,双引号转义。 */
    static String clean(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') { b.append('\''); continue; }
            if (c == '\n' || c == '\r' || c == '\t') { b.append(' '); continue; }
            if (c < 0x20 || c == 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
                || c == 0x200e || c == 0x200f || c == 0x061c) continue;
            b.append(c);
        }
        return b.toString().trim();
    }

    private static String firstNonBlank(String a, String b) {
        return notBlank(a) ? a : (notBlank(b) ? b : "");
    }

    static String labelOf(NodeView n) {
        return firstNonBlank(n.text(), n.contentDescription());
    }

    private static boolean notBlank(String s) {
        return !isBlank(s);
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    /**
     * 按签名重绑(§9.3):在 current 里找与 target 签名相等的唯一下标。
     * 返回 ≥0 = 唯一命中的下标;-1 = 没有;-2 = 多个(不唯一,调用方回 stale_handle)。
     * ⚠️ 空身份签名(无 id、无文本、无 desc,只剩类名)一律当不唯一 —— 满屏 FrameLayout 会误命中。
     */
    static int rebind(List<Sig> current, Sig target) {
        if (target == null || target.isEmptyIdentity()) return -2;
        int found = -1;
        for (int i = 0; i < current.size(); i++) {
            if (current.get(i).equals(target)) {
                if (found >= 0) return -2;
                found = i;
            }
        }
        return found;
    }

    /** 句柄解析的结果:index = 现读树里的下标;note = 重绑说明(首行,引擎按固定格式提到围栏外);stale = 回 stale_handle。 */
    static final class Resolution {
        final int index;
        final String note;
        final boolean stale;

        private Resolution(int index, String note, boolean stale) {
            this.index = index;
            this.note = note;
            this.stale = stale;
        }

        static final Resolution STALE = new Resolution(-1, null, true);
    }

    /**
     * 句柄 → 现读树里的下标(§9.3)。纯函数,JVM 可测(TreeSerializerTest)。
     * ① obs 是最新一份(缺省 = 最新)且现读树同下标签名与存档一致 → 直接按下标,无说明:重复签名(一列「关注」、
     *    每行同 id 的 Switch)与空身份(无 id / 文本 / desc 的可点行)只有这条路点得准;
     * ② 否则(obs 过期 / 同下标已不是它)→ 按签名在现读树里**唯一**匹配 → 重绑,首行写 `n12 (obs 6) re-bound to n15`;
     * ③ 快照里没有这个句柄 / 不唯一 / 没有 / 空身份 → STALE。
     * ⚠️ 09-26 评审前一律走 ②,于是 ① 里那几类控件拿最新 obs 也永远 stale;live 台架的假手机(fake-phone.mjs resolve)逐条镜像这里。
     *
     * @param history    obs → 当时的签名表(下标 i = 句柄 i+1)
     * @param currentObs 最近一次登记的 obs
     * @param handle     句柄(1 起)
     * @param obs        模型传来的 obs;<0 = 按最新
     * @param fresh      现读树的签名表(与 capture 同一口径序列化)
     */
    static Resolution resolve(Map<Integer, List<Sig>> history, int currentObs, int handle, int obs, List<Sig> fresh) {
        int targetObs = obs < 0 ? currentObs : obs;
        List<Sig> sigs = history.get(targetObs);
        if (sigs == null || handle < 1 || handle - 1 >= sigs.size()) return Resolution.STALE;
        Sig sig = sigs.get(handle - 1);
        if (targetObs == currentObs && handle - 1 < fresh.size() && fresh.get(handle - 1).equals(sig)) {
            return new Resolution(handle - 1, null, false);
        }
        int idx = rebind(fresh, sig);
        if (idx < 0) return Resolution.STALE;
        return new Resolution(idx, "n" + handle + " (obs " + targetObs + ") re-bound to n" + (idx + 1), false);
    }
}
