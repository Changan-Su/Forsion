package com.forsion.tangu.hands;

/**
 * 屏幕节点的**纯 Java 视图**(手机操控 T2)。TreeSerializer 只吃这个接口,于是序列化逻辑能在 JVM 上跑 JUnit
 * (TreeSerializerTest 用假实现),不必起设备。真身是 AccessibilityNodeInfo,由 NodeInfoView 适配。
 * 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §9.3。
 *
 * ⚠️ 只读快照语义:实现方在被序列化期间不得让底层节点回收失效。NodeInfoView 在 observe 一轮里持有强引用。
 */
interface NodeView {
    String className();
    String text();
    String contentDescription();
    /** 完整 resource-id(如 com.android.settings:id/search)。无 → null。 */
    String viewIdResourceName();
    /** 可编辑控件的 hint(占位符)。 */
    String hintText();

    boolean clickable();
    boolean longClickable();
    boolean editable();
    boolean checkable();
    boolean isChecked();
    boolean scrollable();
    boolean focused();
    boolean password();
    boolean visibleToUser();
    boolean enabled();

    int centerX();
    int centerY();
    /** 屏幕坐标下的边界(左上含、右下不含)。命中测试用:坐标点击落在谁身上(§9.4 提交词表)。 */
    int left();
    int top();
    int right();
    int bottom();

    /** 所属窗口 id(AccessibilityNodeInfo.getWindowId);策略按目标所在窗口判(§9.4 多窗口)。 */
    int windowId();

    int childCount();
    /** 越界 / 取不到 → null(实现方兜住)。 */
    NodeView child(int index);
    /** 父节点;根 / 取不到 → null。ACTION_CLICK 实际落在「自身或最近可点祖先」上,提交词表要按它判。 */
    NodeView parent();
}
