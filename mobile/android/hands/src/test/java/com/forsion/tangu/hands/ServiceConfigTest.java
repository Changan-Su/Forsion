package com.forsion.tangu.hands;

import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.junit.Test;

/**
 * 无障碍服务配置的能力声明(res/xml/hands_accessibility.xml)。
 * ⚠️ 漏了 canPerformGestures,系统静默忽略 dispatchGesture、回调永不触发:坐标点击 / 滑动兜底 / 长按全部 5s 超时回 error,
 *    而节点动作照常 —— 09-26 真屏幕台架「无句柄滚动」才暴露(capabilities=129,没有手势位)。
 *    JUnit 跑在模块目录下,直接读源 XML 做文本断言即可。
 */
public class ServiceConfigTest {
    private static String config() throws Exception {
        return new String(Files.readAllBytes(Paths.get("src/main/res/xml/hands_accessibility.xml")), StandardCharsets.UTF_8);
    }

    @Test
    public void declaresEveryCapabilityTheBridgeUses() throws Exception {
        String xml = config();
        assertTrue("dispatchGesture needs canPerformGestures", xml.contains("android:canPerformGestures=\"true\""));
        assertTrue("observe needs canRetrieveWindowContent", xml.contains("android:canRetrieveWindowContent=\"true\""));
        assertTrue("screenshot needs canTakeScreenshot", xml.contains("android:canTakeScreenshot=\"true\""));
    }
}
