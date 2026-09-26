package com.forsion.tangu.hands;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * ShotGuard 单测(JVM):observe 截图的脱敏守卫(契约 §9.3,09-26 二轮评审 P1 #1)。
 * 旧实现只在截之前看一份快照、且 getWindows() 取不到时按「没有脱敏窗口」放行 —— 截的过程中切进支付宝 / 拉下通知栏都照截。
 * 跑法:cd mobile/android && ./gradlew :hands:testDebugUnitTest
 */
public class ShotGuardTest {
    private static final String SETTINGS = "com.android.settings";
    private static final String ALIPAY = "com.eg.android.AlipayGphone";

    private static List<ShotGuard.Key> keys(Object... idPkg) {
        List<ShotGuard.Key> out = new ArrayList<>();
        for (int i = 0; i < idPkg.length; i += 2) out.add(new ShotGuard.Key((Integer) idPkg[i], (String) idPkg[i + 1]));
        return out;
    }

    @Test
    public void refusesWhenWindowsCannotBeIdentified() {
        assertFalse(ShotGuard.mayCapture(false, keys(1, SETTINGS), SETTINGS)); // getWindows 空,只凑了个活动窗口
        assertFalse(ShotGuard.mayCapture(true, Collections.emptyList(), SETTINGS));
        assertFalse(ShotGuard.mayCapture(true, keys(1, SETTINGS), ""));        // 前台认不出
        assertFalse(ShotGuard.mayCapture(true, keys(2, ALIPAY, 1, SETTINGS), SETTINGS));
        assertTrue(ShotGuard.mayCapture(true, keys(2, "com.android.systemui", 1, SETTINGS), SETTINGS));
    }

    @Test
    public void keepsOnlyWhenNothingChanged() {
        List<ShotGuard.Key> before = keys(2, "com.android.systemui", 1, SETTINGS);
        assertTrue(ShotGuard.keep(before, SETTINGS, true, keys(2, "com.android.systemui", 1, SETTINGS), SETTINGS, true));
        // 截的过程中支付宝到了前台
        assertFalse(ShotGuard.keep(before, SETTINGS, true, keys(3, ALIPAY, 2, "com.android.systemui"), ALIPAY, true));
        // 前台换了(同一组窗口里换了焦点)
        assertFalse(ShotGuard.keep(before, SETTINGS, true, before, "com.android.systemui", true));
        // 多了一个窗口(通知栏拉下 / 浮窗),哪怕它本身不在脱敏名单
        assertFalse(ShotGuard.keep(before, SETTINGS, true, keys(9, "com.example.chat", 2, "com.android.systemui", 1, SETTINGS), SETTINGS, true));
        // 窗口集合前后一致,但截的期间来过窗口变化事件(闪进闪出)
        assertFalse(ShotGuard.keep(before, SETTINGS, true, before, SETTINGS, false));
        // 截后取不到窗口
        assertFalse(ShotGuard.keep(before, SETTINGS, false, before, SETTINGS, true));
        assertTrue(Arrays.asList(new ShotGuard.Key(1, "a")).equals(Arrays.asList(new ShotGuard.Key(1, "a"))));
    }
}
