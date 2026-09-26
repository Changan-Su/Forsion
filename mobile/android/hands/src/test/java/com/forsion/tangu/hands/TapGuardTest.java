package com.forsion.tangu.hands;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * TapGuard 单测(JVM):提交词表按「实际被点的节点」判(契约 §9.4,09-26 评审 P1);
 * 手势落点在**接住手势的窗口的整棵树**里命中测试(09-26 二轮评审 P1:原来用 observation 的封顶节点表)。
 * 每个 commit 用例都是负对照:旧实现只看所选节点自己的 text(非空时不看 desc)、坐标点击不查 / 只查封顶节点表,这些用例在旧实现上都会放行。
 * 跑法:cd mobile/android && ./gradlew :hands:testDebugUnitTest
 */
public class TapGuardTest {

    /** 美团式结算条:可点容器(无字)里放着不可点的「提交订单」与「¥25.50」。 */
    private static FakeNode payBar(FakeNode[] outOrder, FakeNode[] outPrice) {
        FakeNode order = FakeNode.of("android.widget.TextView").text("提交订单").box(700, 2200, 1000, 2300);
        FakeNode price = FakeNode.of("android.widget.TextView").text("¥25.50").box(520, 2200, 690, 2300);
        FakeNode bar = FakeNode.of("android.widget.LinearLayout").clk().box(500, 2180, 1060, 2320).kid(price).kid(order);
        if (outOrder != null) outOrder[0] = order;
        if (outPrice != null) outPrice[0] = price;
        return bar;
    }

    private static FakeNode screen(FakeNode... kids) {
        FakeNode root = FakeNode.of("android.widget.FrameLayout").box(0, 0, 1080, 2400);
        for (FakeNode k : kids) root.kid(k);
        return root;
    }

    @Test
    public void clickableContainerWithCommitChild() {
        FakeNode bar = payBar(null, null);
        // 旧实现:label = 容器自己的 text = "" → 放行,ACTION_CLICK 落在容器上把单下了
        assertTrue(TapGuard.commitForNode(bar, false));
    }

    @Test
    public void nonClickablePriceInsidePayButton() {
        FakeNode[] price = new FakeNode[1];
        FakeNode bar = payBar(null, price);
        // 旧实现:label = "¥25.50" → 放行,click 向上爬到支付容器
        assertSame(bar, TapGuard.actor(price[0], false));
        assertTrue(TapGuard.commitForNode(price[0], false));
    }

    @Test
    public void descCheckedEvenWhenTextPresent() {
        FakeNode send = FakeNode.of("android.widget.ImageButton").text("✈").desc("Send").clk().box(900, 2000, 1000, 2100);
        assertTrue(TapGuard.commitForNode(send, false));
    }

    @Test
    public void coordinateTapIsHitTested() {
        FakeNode root = screen(payBar(null, null));
        // 旧实现:坐标点击完全不过词表
        assertEquals(TapGuard.Point.COMMIT, TapGuard.commitAtPoint(root, 560, 2250));   // 点在价格上,容器接住
        assertEquals(TapGuard.Point.COMMIT, TapGuard.commitAtPoint(root, 850, 2250));   // 点在「提交订单」上
        assertEquals(TapGuard.Point.OK, TapGuard.commitAtPoint(root, 100, 100));        // 空白处(落在根上)
    }

    @Test
    public void benignTargetsPass() {
        FakeNode add = FakeNode.of("android.widget.Button").text("加入购物车").clk().box(0, 0, 200, 100);
        assertFalse(TapGuard.commitForNode(add, false));
        // 可点内容卡片:后代里的长标题带「删除」「购买」不算(只认短标签),否则 B 站 / 小红书结果卡整张点不动
        FakeNode title = FakeNode.of("android.widget.TextView").text("手把手教你删除旧手机里的购买记录和聊天备份(完整版)")
            .box(10, 310, 1070, 380);
        FakeNode card = FakeNode.of("android.widget.FrameLayout").clk().box(0, 300, 1080, 600).kid(title)
            .kid(FakeNode.of("android.widget.TextView").text("12.3万播放").box(10, 400, 300, 440));
        assertFalse(TapGuard.commitForNode(card, false));
        assertEquals(TapGuard.Point.OK, TapGuard.commitAtPoint(screen(card), 500, 500));
    }

    @Test
    public void longPressUsesLongClickableActor() {
        FakeNode child = FakeNode.of("android.widget.TextView").text("A").box(0, 0, 10, 10);
        FakeNode clickOnly = FakeNode.of("android.widget.LinearLayout").clk().box(0, 0, 20, 20).kid(child);
        FakeNode longRow = FakeNode.of("android.widget.FrameLayout").lng().box(0, 0, 30, 30).kid(clickOnly);
        assertSame(clickOnly, TapGuard.actor(child, false));
        assertSame(longRow, TapGuard.actor(child, true));
        assertNull(TapGuard.actor(FakeNode.of("x"), false));
    }

    @Test
    public void callAndSaveTargets() {
        FakeNode call = FakeNode.of("android.widget.Button").text("Call").desc("dial").clk().box(0, 0, 100, 100);
        assertTrue(TapGuard.commitForNode(call, false));
        FakeNode save = FakeNode.of("android.widget.Button").text("保存").clk().box(0, 0, 100, 100);
        assertTrue(TapGuard.commitForNode(save, false));
    }

    /**
     * 二轮评审 P1 的原样复现:长页面里第 300 行才是「提交订单」,observation 的节点表封顶 250 —— 旧实现拿那张表命中测试,
     * 落点上什么都查不到 → 放行。整树现走必须认出它。
     */
    @Test
    public void commitBeyondObservationCapIsStillFound() {
        FakeNode list = FakeNode.of("androidx.recyclerview.widget.RecyclerView").scr().box(0, 0, 1080, 2400);
        FakeNode order = null;
        for (int i = 0; i < 300; i++) {
            int top = i * 8;
            FakeNode row = FakeNode.of("android.widget.LinearLayout").clk().box(0, top, 1080, top + 8)
                .kid(FakeNode.of("android.widget.TextView").text(i == 299 ? "提交订单" : "item " + i).box(0, top, 500, top + 8));
            list.kid(row);
            if (i == 299) order = row;
        }
        FakeNode root = screen(list);
        TreeSerializer.Result obs = TreeSerializer.serialize(Collections.singletonList(root), "App", "com.x", 1080, 2400, 1);
        assertTrue(obs.size() <= TreeSerializer.MAX_NODES);
        assertTrue(obs.text.contains("more not shown"));
        assertFalse("the commit row must be past the observation cap", obs.nodes.contains(order));
        // 旧口径(在封顶节点表里找包含该点的最小可点节点)在这里找不到任何可点节点,只剩整张列表 → 放行
        for (NodeView n : obs.nodes) if (TapGuard.contains(n, 100, order.top() + 4)) assertFalse(n.clickable());
        assertEquals(TapGuard.Point.COMMIT, TapGuard.commitAtPoint(root, 100, order.top() + 4));
        assertEquals(TapGuard.Point.OK, TapGuard.commitAtPoint(root, 100, 4)); // 第 0 行:普通
    }

    /** 互相重叠又不嵌套的两个可点节点(浮层按钮压在列表项上):谁接住触摸判不准 → 全部比对,任一命中就拒。 */
    @Test
    public void overlappingSiblingsAreAllChecked() {
        FakeNode row = FakeNode.of("android.widget.LinearLayout").clk().box(0, 1000, 1080, 1200)
            .kid(FakeNode.of("android.widget.TextView").text("订单详情").box(0, 1000, 500, 1200));
        // 「删除」按钮面积更大,旧的「最小可点节点」口径会只看 row
        FakeNode del = FakeNode.of("android.widget.Button").text("删除").clk().box(0, 900, 1080, 1300);
        assertEquals(TapGuard.Point.COMMIT, TapGuard.commitAtPoint(screen(row, del), 100, 1100));
    }

    /** 落点下什么都认不出(不在任何节点里)/ 树大到走不完 → UNKNOWN(调用方拒绝),不按「没命中」放行。 */
    @Test
    public void unknownWhenNothingOrTooBig() {
        FakeNode small = FakeNode.of("android.widget.FrameLayout").box(0, 0, 100, 100);
        assertEquals(TapGuard.Point.UNKNOWN, TapGuard.commitAtPoint(small, 500, 500));
        assertEquals(TapGuard.Point.UNKNOWN, TapGuard.commitAtPoint(null, 1, 1));
        FakeNode huge = FakeNode.of("android.webkit.WebView").box(0, 0, 1080, 2400);
        for (int i = 0; i <= TapGuard.MAX_WALK; i++) huge.kid(FakeNode.of("android.view.View").box(0, 0, 1, 1));
        assertEquals(TapGuard.Point.UNKNOWN, TapGuard.commitAtPoint(huge, 500, 500));
    }

    private static List<NodeView> list(NodeView... ns) {
        List<NodeView> out = new ArrayList<>();
        Collections.addAll(out, ns);
        return out;
    }

    @Test
    public void focusedEditableOnlyWhenFocused() {
        // 契约 §9.2:无句柄 type 只认输入焦点所在的可编辑控件;没焦点 → null(旧实现退到第一个可编辑控件)
        FakeNode name = FakeNode.of("android.widget.EditText").edit().box(0, 100, 1080, 200);
        FakeNode note = FakeNode.of("android.widget.EditText").edit().box(0, 300, 1080, 400);
        assertNull(TypeChain.focusedEditable(list(screen(name, note))));
        note.foc();
        assertSame(note, TypeChain.focusedEditable(list(screen(name, note))));
        FakeNode focusedButton = FakeNode.of("android.widget.Button").text("OK").clk().foc().box(0, 500, 200, 600);
        assertNull(TypeChain.focusedEditable(list(screen(focusedButton, name))));
    }
}
