package com.forsion.tangu.hands;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import android.view.WindowManager;

import org.junit.Test;

/**
 * 停止药丸的窗口 flags(契约 §9.5,09-26 评审 P1):flags=0 的非 Activity 窗口是模态的 —— 整屏触摸与按键焦点都归它,
 * 租约期间用户与 T2 手势全被吞掉。常量在编译期内联,JVM 上可直接断言。
 */
public class OverlayTest {

    @Test
    public void pillIsNotFocusableAndNotTouchModal() {
        int f = Overlay.pillFlags();
        assertNotEquals(0, f & WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        assertNotEquals(0, f & WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);
        assertEquals(0, f & WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH);
    }
}
