package com.forsion.tangu.hands;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * TreeSerializer 的纯逻辑单测(JVM):observation 格式、过滤、密码脱敏、图标兜底、上限、过期句柄重绑。
 * 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §9.3。跑法:cd mobile/android && ./gradlew :hands:testDebugUnitTest
 */
public class TreeSerializerTest {

    private static List<NodeView> roots(NodeView... rs) {
        return new ArrayList<>(Arrays.asList(rs));
    }

    @Test
    public void headerAndBasicNodes() {
        FakeNode root = FakeNode.of("android.widget.FrameLayout")
            .kid(FakeNode.of("android.widget.Button").text("网络和互联网").clk().at(540, 610))
            .kid(FakeNode.of("android.widget.EditText").edit().foc().hint("搜索设置").at(540, 300));
        TreeSerializer.Result r = TreeSerializer.serialize(roots(root), "设置", "com.android.settings", 1080, 2400, 7);
        String[] lines = r.text.split("\n");
        assertEquals("app: 设置 (com.android.settings) · screen 1080x2400 · obs 7", lines[0]);
        assertEquals("[1] Button \"网络和互联网\" {clk} (540,610)", lines[1]);
        assertEquals("[2] EditText \"\" {edit,focused} hint=\"搜索设置\" (540,300)", lines[2]);
        assertEquals(2, r.size());
    }

    @Test
    public void checkableShowsCheckedState() {
        FakeNode root = FakeNode.of("android.widget.FrameLayout")
            .kid(FakeNode.of("android.widget.Switch").text("深色主题").clk().check(true).at(980, 1210));
        TreeSerializer.Result r = TreeSerializer.serialize(roots(root), "设置", "com.android.settings", 1080, 2400, 1);
        assertTrue(r.text.contains("[1] Switch \"深色主题\" {clk,checked} (980,1210)"));
    }

    @Test
    public void skipsInvisibleAndMeaninglessNodes() {
        FakeNode root = FakeNode.of("android.widget.FrameLayout")
            .kid(FakeNode.of("android.widget.LinearLayout").at(1, 1))                       // 无意义:不收
            .kid(FakeNode.of("android.widget.Button").text("hidden").clk().invisible()) // 不可见:不收
            .kid(FakeNode.of("android.widget.TextView").text("Visible label").at(2, 2));       // 有文字:收
        TreeSerializer.Result r = TreeSerializer.serialize(roots(root), "App", "com.x", 1080, 2400, 1);
        assertEquals(1, r.size());
        assertTrue(r.text.contains("\"Visible label\""));
        assertFalse(r.text.contains("hidden"));
    }

    @Test
    public void passwordIsMasked() {
        FakeNode root = FakeNode.of("x")
            .kid(FakeNode.of("android.widget.EditText").edit().pwd().text("hunter2").at(5, 5));
        TreeSerializer.Result r = TreeSerializer.serialize(roots(root), "App", "com.x", 1080, 2400, 1);
        assertTrue(r.text.contains(TreeSerializer.MASK));
        assertFalse(r.text.contains("hunter2"));
        // 签名里也不能泄露真值
        assertEquals(TreeSerializer.MASK, r.sigs.get(0).text);
    }

    @Test
    public void iconButtonFallsBackToShortId() {
        FakeNode root = FakeNode.of("x")
            .kid(FakeNode.of("android.widget.ImageButton").clk().id("com.android.settings:id/search_action_bar").at(9, 9));
        TreeSerializer.Result r = TreeSerializer.serialize(roots(root), "App", "com.x", 1080, 2400, 1);
        assertTrue(r.text.contains("id=search_action_bar"));
    }

    @Test
    public void nodeCapEmitsMoreNotShown() {
        FakeNode root = FakeNode.of("x");
        for (int i = 0; i < TreeSerializer.MAX_NODES + 5; i++) {
            root.kid(FakeNode.of("android.widget.Button").text("b" + i).clk().at(i, i));
        }
        TreeSerializer.Result r = TreeSerializer.serialize(roots(root), "App", "com.x", 1080, 2400, 1);
        assertEquals(TreeSerializer.MAX_NODES, r.size());
        assertTrue(r.text.contains("more not shown)"));
    }

    private static TreeSerializer.Sig sig(String id, String cls, String text, String desc) {
        return new TreeSerializer.Sig(id, cls, text, desc);
    }

    @Test
    public void rebindUniqueAmbiguousNone() {
        List<TreeSerializer.Sig> current = new ArrayList<>();
        current.add(sig("id/a", "Button", "One", null));
        current.add(sig("id/b", "Button", "Two", null));
        current.add(sig("id/b", "Button", "Two", null)); // 重复 → 不唯一
        assertEquals(0, TreeSerializer.rebind(current, sig("id/a", "Button", "One", null)));
        assertEquals(-2, TreeSerializer.rebind(current, sig("id/b", "Button", "Two", null)));
        assertEquals(-1, TreeSerializer.rebind(current, sig("id/c", "Button", "Three", null)));
    }

    @Test
    public void rebindRejectsEmptyIdentity() {
        List<TreeSerializer.Sig> current = new ArrayList<>();
        current.add(sig(null, "FrameLayout", null, null));
        // 空身份(无 id、无文本、无 desc)不许匹配:满屏 FrameLayout 会误命中
        assertEquals(-2, TreeSerializer.rebind(current, sig(null, "FrameLayout", null, null)));
        // 有 desc 就不是空身份(desc-only 的纯图标按钮)
        assertFalse(sig(null, "Button", null, "Add to cart").isEmptyIdentity());
    }

    @Test
    public void sigIncludesContentDescription() {
        FakeNode root = FakeNode.of("x")
            .kid(FakeNode.of("android.widget.Button").clk().desc("加入购物车:生椰拿铁").at(1, 1))
            .kid(FakeNode.of("android.widget.Button").clk().desc("加入购物车:美式").at(2, 2));
        TreeSerializer.Result r = TreeSerializer.serialize(roots(root), "App", "com.x", 1080, 2400, 1);
        assertEquals("加入购物车:生椰拿铁", r.sigs.get(0).desc);
        assertFalse(r.sigs.get(0).equals(r.sigs.get(1))); // 只差 desc 的两个按钮签名不同
    }

    // ── resolve(§9.3,09-26 评审):① 最新 obs 同下标签名一致 → 按下标;② 否则唯一重绑;③ STALE ──

    private static Map<Integer, List<TreeSerializer.Sig>> history(int obs, List<TreeSerializer.Sig> sigs) {
        Map<Integer, List<TreeSerializer.Sig>> h = new HashMap<>();
        h.put(obs, sigs);
        return h;
    }

    @Test
    public void resolveCurrentObsDuplicateSigsByPosition() {
        // 一列三个「关注」(同 id 同文本):旧实现一律走唯一重绑 → 永远 stale_handle
        List<TreeSerializer.Sig> rows = Arrays.asList(
            sig("app:id/follow", "Button", "关注", null), sig("app:id/follow", "Button", "关注", null),
            sig("app:id/follow", "Button", "关注", null));
        TreeSerializer.Resolution r = TreeSerializer.resolve(history(7, rows), 7, 2, 7, rows);
        assertFalse(r.stale);
        assertEquals(1, r.index);
        assertNull(r.note);
        // obs 缺省(-1)= 最新
        assertEquals(2, TreeSerializer.resolve(history(7, rows), 7, 3, -1, rows).index);
    }

    @Test
    public void resolveCurrentObsEmptyIdentityByPosition() {
        // 设置页的可点行(无 id 无文本,文字挂在子节点上)与每行同 id 的 Switch
        List<TreeSerializer.Sig> page = Arrays.asList(
            sig(null, "LinearLayout", null, null), sig("android:id/switch_widget", "Switch", null, null),
            sig(null, "LinearLayout", null, null), sig("android:id/switch_widget", "Switch", null, null));
        TreeSerializer.Resolution r = TreeSerializer.resolve(history(3, page), 3, 4, 3, page);
        assertFalse(r.stale);
        assertEquals(3, r.index);
        assertFalse(TreeSerializer.resolve(history(3, page), 3, 1, 3, page).stale);
    }

    @Test
    public void resolveStaleObsFallsBackToUniqueRebind() {
        Map<Integer, List<TreeSerializer.Sig>> h = new HashMap<>();
        h.put(6, Arrays.asList(sig(null, "TextView", "Header", null), sig(null, "Button", null, "Add to cart")));
        h.put(8, new ArrayList<>());
        List<TreeSerializer.Sig> fresh = Arrays.asList(
            sig(null, "TextView", "Banner", null), sig(null, "TextView", "Header", null), sig(null, "Button", null, "Add to cart"));
        TreeSerializer.Resolution r = TreeSerializer.resolve(h, 8, 2, 6, fresh);
        assertFalse(r.stale);
        assertEquals(2, r.index);
        // ⚠️ 引擎只认这个格式的首行(^n\d+ \(obs \d+\) re-bound to n\d+$)
        assertEquals("n2 (obs 6) re-bound to n3", r.note);
    }

    @Test
    public void resolveCurrentObsShiftedFallsBackToRebind() {
        // 同一 obs,但屏幕自己动了(顶上插进一条):同下标签名对不上 → 唯一重绑并写说明
        List<TreeSerializer.Sig> old = Arrays.asList(sig("id/a", "Button", "A", null), sig("id/b", "Button", "B", null));
        List<TreeSerializer.Sig> fresh = Arrays.asList(sig("id/new", "Button", "New", null), sig("id/a", "Button", "A", null),
            sig("id/b", "Button", "B", null));
        TreeSerializer.Resolution r = TreeSerializer.resolve(history(4, old), 4, 2, 4, fresh);
        assertEquals(2, r.index);
        assertEquals("n2 (obs 4) re-bound to n3", r.note);
    }

    @Test
    public void resolveStaleCases() {
        List<TreeSerializer.Sig> rows = Arrays.asList(sig("id/f", "Button", "关注", null), sig("id/f", "Button", "关注", null));
        Map<Integer, List<TreeSerializer.Sig>> h = new HashMap<>();
        h.put(1, rows);
        h.put(2, rows);
        assertTrue(TreeSerializer.resolve(h, 2, 1, 1, rows).stale);   // 过期 obs + 重复签名 → 不唯一
        assertTrue(TreeSerializer.resolve(h, 2, 3, 2, rows).stale);   // 快照里没有这个句柄
        assertTrue(TreeSerializer.resolve(h, 2, 1, 99, rows).stale);  // 没有这个 obs
        List<TreeSerializer.Sig> empty = Arrays.asList(sig(null, "LinearLayout", null, null));
        Map<Integer, List<TreeSerializer.Sig>> he = new HashMap<>();
        he.put(1, empty);
        he.put(2, new ArrayList<>());
        assertTrue(TreeSerializer.resolve(he, 2, 1, 1, empty).stale); // 过期 obs + 空身份 → 不重绑
    }

    @Test
    public void hiddenWindowsLine() {
        FakeNode root = FakeNode.of("x").kid(FakeNode.of("android.widget.Button").text("OK").clk().at(1, 1));
        TreeSerializer.Result r = TreeSerializer.serialize(roots(root), "App", "com.x", 1080, 2400, 1, 1);
        assertTrue(r.text.endsWith("(1 window from a private app hidden)\n"));
        assertFalse(TreeSerializer.serialize(roots(root), "App", "com.x", 1080, 2400, 1).text.contains("hidden"));
    }

    @Test
    public void cleanStripsControlAndQuotes() {
        assertEquals("a b", TreeSerializer.clean("a\nb"));
        assertEquals("a'b", TreeSerializer.clean("a\"b"));
    }

    @Test
    public void shortClassAndId() {
        assertEquals("Button", TreeSerializer.shortClass("android.widget.Button"));
        assertEquals("EditText", TreeSerializer.shortClass("android.widget.EditText$Inner"));
        assertEquals("search", TreeSerializer.shortId("com.app:id/search"));
    }
}
