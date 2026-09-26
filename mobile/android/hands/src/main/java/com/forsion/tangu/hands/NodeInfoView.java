package com.forsion.tangu.hands;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * NodeView 对 AccessibilityNodeInfo 的适配(手机操控 T2)。TreeSerializer 只认 NodeView,真身在这里。
 * raw() 暴露底层节点,供执行动作(ACTION_CLICK / SET_TEXT / SCROLL)与坐标兜底用。
 *
 * ⚠️ 生命周期:observe 一轮里由 HandsAccessibilityService 持有窗口根的强引用,序列化 + 建映射期间不回收。
 *    child() 惰性包装,不额外缓存 —— 一次遍历用完即弃。
 */
final class NodeInfoView implements NodeView {
    private final AccessibilityNodeInfo node;
    private final Rect bounds = new Rect();

    NodeInfoView(AccessibilityNodeInfo node) {
        this.node = node;
        node.getBoundsInScreen(bounds);
    }

    AccessibilityNodeInfo raw() {
        return node;
    }

    @Override public String className() {
        CharSequence c = node.getClassName();
        return c == null ? null : c.toString();
    }

    @Override public String text() {
        CharSequence c = node.getText();
        return c == null ? null : c.toString();
    }

    @Override public String contentDescription() {
        CharSequence c = node.getContentDescription();
        return c == null ? null : c.toString();
    }

    @Override public String viewIdResourceName() {
        return node.getViewIdResourceName();
    }

    @Override public String hintText() {
        CharSequence c = node.getHintText();
        return c == null ? null : c.toString();
    }

    @Override public boolean clickable() { return node.isClickable(); }
    @Override public boolean longClickable() { return node.isLongClickable(); }
    @Override public boolean editable() { return node.isEditable(); }
    @Override public boolean checkable() { return node.isCheckable(); }
    @Override public boolean isChecked() { return node.isChecked(); }
    @Override public boolean scrollable() { return node.isScrollable(); }
    @Override public boolean focused() { return node.isFocused(); }
    @Override public boolean password() { return node.isPassword(); }
    @Override public boolean visibleToUser() { return node.isVisibleToUser(); }
    @Override public boolean enabled() { return node.isEnabled(); }

    @Override public int centerX() { return bounds.centerX(); }
    @Override public int centerY() { return bounds.centerY(); }
    @Override public int left() { return bounds.left; }
    @Override public int top() { return bounds.top; }
    @Override public int right() { return bounds.right; }
    @Override public int bottom() { return bounds.bottom; }
    @Override public int windowId() { return node.getWindowId(); }

    @Override public int childCount() { return node.getChildCount(); }

    @Override public NodeView child(int index) {
        try {
            AccessibilityNodeInfo c = node.getChild(index);
            return c == null ? null : new NodeInfoView(c);
        } catch (RuntimeException e) {
            return null;
        }
    }

    @Override public NodeView parent() {
        try {
            AccessibilityNodeInfo p = node.getParent();
            return p == null ? null : new NodeInfoView(p);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
