package com.forsion.tangu.hands;

import java.util.ArrayList;
import java.util.List;

/** 测试用的 NodeView 假实现(JVM,无 android)。链式设置,addChild 组树。 */
final class FakeNode implements NodeView {
    String className = "android.view.View";
    String text;
    String contentDescription;
    String viewId;
    String hint;
    boolean clickable;
    boolean longClickable;
    boolean editable;
    boolean checkable;
    boolean checked;
    boolean scrollable;
    boolean focused;
    boolean password;
    boolean visible = true;
    boolean enabled = true;
    int cx;
    int cy;
    int l, t, r, b; // 边界;at() 给的是零面积框(不参与命中测试),box() 给真框
    int windowId;
    FakeNode parent;
    final List<NodeView> children = new ArrayList<>();

    static FakeNode of(String className) {
        FakeNode n = new FakeNode();
        n.className = className;
        return n;
    }

    // 建造方法用短别名,避开与 NodeView 同名 getter 的冲突(clk/edit/… ≠ clickable()/editable()/…)。
    FakeNode text(String t) { this.text = t; return this; }
    FakeNode desc(String d) { this.contentDescription = d; return this; }
    FakeNode id(String v) { this.viewId = v; return this; }
    FakeNode hint(String h) { this.hint = h; return this; }
    FakeNode clk() { this.clickable = true; return this; }
    FakeNode lng() { this.longClickable = true; return this; }
    FakeNode edit() { this.editable = true; return this; }
    FakeNode check(boolean isChecked) { this.checkable = true; this.checked = isChecked; return this; }
    FakeNode scr() { this.scrollable = true; return this; }
    FakeNode foc() { this.focused = true; return this; }
    FakeNode pwd() { this.password = true; return this; }
    FakeNode invisible() { this.visible = false; return this; }
    FakeNode at(int x, int y) { this.cx = x; this.cy = y; this.l = x; this.t = y; this.r = x; this.b = y; return this; }
    FakeNode box(int left, int top, int right, int bottom) {
        this.l = left; this.t = top; this.r = right; this.b = bottom;
        this.cx = (left + right) / 2; this.cy = (top + bottom) / 2;
        return this;
    }
    FakeNode win(int id) { this.windowId = id; return this; }
    FakeNode kid(NodeView child) {
        this.children.add(child);
        if (child instanceof FakeNode) ((FakeNode) child).parent = this;
        return this;
    }

    @Override public String className() { return className; }
    @Override public String text() { return text; }
    @Override public String contentDescription() { return contentDescription; }
    @Override public String viewIdResourceName() { return viewId; }
    @Override public String hintText() { return hint; }
    @Override public boolean clickable() { return clickable; }
    @Override public boolean longClickable() { return longClickable; }
    @Override public boolean editable() { return editable; }
    @Override public boolean checkable() { return checkable; }
    @Override public boolean isChecked() { return checked; }
    @Override public boolean scrollable() { return scrollable; }
    @Override public boolean focused() { return focused; }
    @Override public boolean password() { return password; }
    @Override public boolean visibleToUser() { return visible; }
    @Override public boolean enabled() { return enabled; }
    @Override public int centerX() { return cx; }
    @Override public int centerY() { return cy; }
    @Override public int left() { return l; }
    @Override public int top() { return t; }
    @Override public int right() { return r; }
    @Override public int bottom() { return b; }
    @Override public int windowId() { return windowId; }
    @Override public int childCount() { return children.size(); }
    @Override public NodeView child(int index) { return index >= 0 && index < children.size() ? children.get(index) : null; }
    @Override public NodeView parent() { return parent; }
}
