package com.forsion.tangu.hands;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;

/**
 * Policy 硬防线单测(JVM)。契约 §9.4。跑法:cd mobile/android && ./gradlew :hands:testDebugUnitTest
 */
public class PolicyTest {

    @Test
    public void protectedPackages() {
        assertTrue(Policy.isProtectedPackage("com.forsion.tangu"));
        assertTrue(Policy.isProtectedPackage("com.forsion.tangu.hands"));
        assertTrue(Policy.isProtectedPackage("com.google.android.permissioncontroller"));
        assertTrue(Policy.isProtectedPackage("com.android.packageinstaller"));
        assertTrue(Policy.isProtectedPackage("com.android.vending"));
        assertFalse(Policy.isProtectedPackage("com.android.settings"));
        // VPN 授权框:「确定」= 把全机流量交给别的 App(09-26 评审)
        assertTrue(Policy.isProtectedPackage("com.android.vpndialogs"));
    }

    @Test
    public void redactedAndReadOnly() {
        assertTrue(Policy.isRedactedPackage("com.eg.android.AlipayGphone"));
        assertTrue(Policy.isRedactedPackage("com.unionpay"));
        assertTrue(Policy.isRedactedPackage("com.icbc"));
        assertTrue(Policy.isReadOnlyPackage("com.tencent.mm"));
        assertFalse(Policy.isRedactedPackage("com.tencent.mm"));
    }

    @Test
    public void observeBlockOnlyForRedacted() {
        assertEquals("redacted", Policy.observeBlock("com.eg.android.AlipayGphone"));
        assertNull(Policy.observeBlock("com.tencent.mm"));   // 只读包可 observe
        assertNull(Policy.observeBlock("com.forsion.tangu")); // 保护包可 observe
        assertNull(Policy.observeBlock("com.android.settings"));
    }

    @Test
    public void mutateBlockOrdering() {
        assertEquals("protected_app", Policy.mutateBlock("com.forsion.tangu", ""));
        assertEquals("redacted", Policy.mutateBlock("com.eg.android.AlipayGphone", ""));
        assertEquals("read_only_app", Policy.mutateBlock("com.tencent.mm", ""));
        assertNull(Policy.mutateBlock("com.android.settings", "Display"));
    }

    @Test
    public void sensitiveSettingsOnlyInsideSettings() {
        assertEquals("protected_app", Policy.mutateBlock("com.android.settings", "无障碍"));
        assertEquals("protected_app", Policy.mutateBlock("com.android.settings", "Accessibility"));
        assertEquals("protected_app", Policy.mutateBlock("com.android.settings", "Developer options"));
        assertEquals("protected_app", Policy.mutateBlock("com.miui.securitycenter", "密码"));
        // 普通 App 里叫「安全」的页不算(不是设置包)
        assertNull(Policy.mutateBlock("com.some.app", "安全中心"));
        // 设置里的普通页可操作
        assertNull(Policy.mutateBlock("com.android.settings", "显示"));
    }

    @Test
    public void commitLabels() {
        assertTrue(Policy.isCommitLabel("发送"));
        assertTrue(Policy.isCommitLabel("确认支付"));
        assertTrue(Policy.isCommitLabel("Send"));
        assertTrue(Policy.isCommitLabel("PAY NOW")); // 大小写 + 子串
        assertTrue(Policy.isCommitLabel("Place order"));
        assertFalse(Policy.isCommitLabel("Cancel"));
        assertFalse(Policy.isCommitLabel(""));
        assertFalse(Policy.isCommitLabel(null));
    }

    @Test
    public void callAndSaveAreCommitWordsWithBoundaries() {
        // T1 开启确认框承诺「发送、拨打、保存永远由你自己按」:T2 点得到屏幕后必须守住
        assertTrue(Policy.isCommitLabel("Call"));
        assertTrue(Policy.isCommitLabel("Video call"));
        assertTrue(Policy.isCommitLabel("dial"));
        assertTrue(Policy.isCommitLabel("Save"));
        assertTrue(Policy.isCommitLabel("Don't save"));
        assertTrue(Policy.isCommitLabel("拨打电话"));
        assertTrue(Policy.isCommitLabel("呼叫"));
        assertTrue(Policy.isCommitLabel("保存"));
        // 词边界:子串会误伤这些
        assertFalse(Policy.isCommitLabel("Calls"));
        assertFalse(Policy.isCommitLabel("Recall"));
        assertFalse(Policy.isCommitLabel("Data Saver"));
        assertFalse(Policy.isCommitLabel("Saved"));
        assertFalse(Policy.isCommitLabel("Dialog"));
        assertFalse(Policy.isCommitLabel("Display"));
    }

    private static Policy.Win win(String pkg, String title, String heading, String... texts) {
        return new Policy.Win(pkg, title, heading, Arrays.asList(texts));
    }

    @Test
    public void sensitiveSettingsByTitleOrHeading() {
        // 窗口标题泛泛(「Settings」)时看首个标题:旧实现只在标题为 null 时才看,这些页全放行
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.settings", "Settings", "Device & app notifications")));
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.settings", "Settings", "Display over other apps")));
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.settings", "Settings", "Usage access")));
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.settings", "设置", "特殊应用权限")));
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.settings", "", "所有文件访问权限")));
        // 认不出是哪页(标题与首个标题都空)→ fail closed
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.settings", "", null)));
        // 普通设置页照常可操作
        assertNull(Policy.mutateBlock(win("com.android.settings", "Settings", "Network & internet")));
    }

    @Test
    public void consentDialogPhrasesOnSystemSurfaces() {
        // 无障碍服务授权确认:标题是服务名、首个标题可能是别的,靠整窗措辞认
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.settings", "TalkBack", "TalkBack",
            "Allow TalkBack to have full control of your device?", "Allow", "Deny")));
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.settings", "TalkBack", "TalkBack",
            "要允许“TalkBack”完全控制您的设备吗？")));
        // 投屏 / 录屏授权(systemui 的 MediaProjection 框)与 USB 调试授权
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.systemui", null, "Start recording or casting with X?",
            "Start recording or casting with X?", "Start")));
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.systemui", null, "x",
            "X will start capturing everything that's displayed on your screen.", "Start now")));
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.systemui", null, "x", "Allow USB debugging?")));
        assertEquals("protected_app", Policy.mutateBlock(win("com.android.systemui", null, "x", "允许 USB 调试吗？")));
        // 通知栏 / 快捷设置照常可操作:「投放」磁贴、通知里的推广按钮、开了调试常驻的「已连接 USB 调试」都不算
        assertNull(Policy.mutateBlock(win("com.android.systemui", null, "12:30", "Internet", "Bluetooth", "Screen Cast", "投放")));
        assertNull(Policy.mutateBlock(win("com.android.systemui", null, "12:30", "今日训练已就绪", "立即开始", "Start now")));
        assertNull(Policy.mutateBlock(win("com.android.systemui", null, "12:30", "USB debugging connected", "已连接 USB 调试")));
        // 设置首页列着「无障碍 / 安全 / 密码和账号」这些行:整窗扫描只认同意框措辞,不能把首页拦死
        assertNull(Policy.mutateBlock(win("com.android.settings", "Settings", "Search settings",
            "Accessibility", "Security & privacy", "Passwords & accounts", "Network & internet")));
        // 内容 App 里出现同样措辞不算(只在系统配置面判)
        assertNull(Policy.mutateBlock(win("tv.danmaku.bili", "哔哩哔哩", "x", "full control", "立即开始")));
    }
}
