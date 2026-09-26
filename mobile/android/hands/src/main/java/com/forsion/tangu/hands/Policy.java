package com.forsion.tangu.hands;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 伴随包内的**硬防线**(手机操控 T2,契约 §9.4)—— 不经 JS、不经引擎,变更类 op 在这里 fail closed。
 * 纯 Java,可 JUnit(PolicyTest)。判定只看包名、窗口标题 / 首个标题文本、窗口内文字(仅系统配置面)+ 目标控件文字,
 * 不读任何外部「风险」字段。按**目标所在窗口**判(Win),不只看前台窗口(分屏 / 通知栏 / 浮窗,§9.4 多窗口)。
 *
 * ⚠️ 这些名单会随 App 改版漂移,是**启发式**,对外(文案 / 提示)绝不许写成硬边界(§9.4)。
 * 清单最后核对:2026-09-26(名单来源:各 App 官方包名;银行取头部若干,不求全 —— 求全不可能,防线靠「默认可操作、
 * 命中即拒」而不是「枚举所有危险」)。
 */
final class Policy {
    private Policy() {}

    static final String OWN = "com.forsion.tangu";
    static final String HANDS = "com.forsion.tangu.hands";

    /** 保护包:拒绝一切变更类 op(protected_app)。Forsion 自身 + 权限 / 安装 / 应用商店 + VPN 授权框。 */
    private static final Set<String> PROTECTED_EXACT = set(OWN, HANDS, "com.android.vending",
        "com.android.vpndialogs"); // 「连接请求 · 确定」= 把全机流量交给别的 App
    static final String SYSTEMUI = "com.android.systemui";
    private static final String[] PROTECTED_SUFFIX = {"permissioncontroller", "packageinstaller"};

    /**
     * 脱敏包:observe 不给树也不给截图,变更类 op 拒绝(redacted)。支付 / 银联 / 头部银行 / 头部证券。
     * 最后核对 2026-09-26。
     */
    private static final Set<String> REDACTED_EXACT = set(
        // 支付 / 清算
        "com.eg.android.AlipayGphone",        // 支付宝
        "com.unionpay",                       // 云闪付(银联)
        // 头部银行
        "com.icbc",                           // 工商银行
        "com.chinamworld.main",               // 建设银行
        "com.android.bankabc",                // 农业银行
        "com.chinamworld.bocmbci",            // 中国银行
        "com.bankcomm.Bankcomm",              // 交通银行
        "cmb.pb",                             // 招商银行
        "com.cmbc.bank.mobile",               // 民生银行(部分版本)
        "com.pingan.paces.ccms",              // 平安口袋银行(部分)
        "com.ecitic.bank.mobile",             // 中信银行
        "com.cib.cibmb",                      // 兴业银行
        "com.spdbccc.app",                    // 浦发信用卡(部分)
        // 头部证券
        "com.hexin.plat.android",             // 同花顺
        "com.eastmoney.android.berlin",       // 东方财富
        "cn.com.gf.app",                      // 广发证券(部分)
        "com.thinkive.mobile.account_zxzq");  // 部分券商开户

    /** 只读包:可 observe,变更类 op 拒绝(read_only_app)。微信 App 自身风控会封禁自动化。 */
    private static final Set<String> READ_ONLY_EXACT = set("com.tencent.mm");

    /**
     * 敏感设置页(只读,protected_app):窗口标题**或**首个标题文本命中即拒。启发式。zh + en。
     * 后半截(09-26 评审)是「把设备级能力授给别的 App」的系统同意面:无障碍服务详情 / 完全控制确认、通知使用权、
     * 悬浮窗、使用情况访问、所有文件访问、修改系统设置、特殊应用权限 —— 否则经设置搜索点进去就能替别的 App 开权限。
     */
    private static final String[] SENSITIVE_SETTINGS = {
        "无障碍", "accessibility",
        "设备管理", "device admin",
        "安装未知应用", "install unknown apps", "unknown apps",
        "开发者选项", "developer options",
        "密码", "password",
        "账号", "帐号", "accounts",
        "安全", "security",
        "完全控制", "full control",
        "通知使用权", "通知访问", "设备和应用通知", "notification access", "device & app notifications",
        "显示在其他应用的上层", "悬浮窗", "display over other apps", "appear on top",
        "使用情况访问", "usage access",
        "所有文件访问", "all files access",
        "修改系统设置", "modify system settings",
        "特殊应用权限", "特殊应用访问", "special app access"};

    /**
     * 同意框专有措辞:在系统配置面(设置类包 + systemui)的**整窗文字**里命中即拒。只收同意框独有的句子 ——
     * 设置首页就列着「无障碍 / 安全 / 密码和账号」,拿上面那张宽表扫整窗会把整个设置场景拦死。
     * 无障碍「允许 X 完全控制您的设备?」、投屏 / 录屏授权(MediaProjection,API 29–35 各版措辞)、USB 调试授权。
     * ⚠️ 别收裸词 cast / 投放(快捷设置里就有「投放」磁贴)、按钮字 Start now / 立即开始(通知里常见的推广按钮)、
     *    USB debugging 本身(开了调试的手机通知栏常驻「已连接 USB 调试」)—— 否则整个通知栏被拦成只读。只收对话框的句子。
     */
    private static final String[] CONSENT_PHRASES = {
        "完全控制", "full control",
        "capturing everything", "截取您的屏幕", "recording or casting", "录制或投放", "录制或投屏",
        "share your screen", "共享您的屏幕", "共享屏幕吗",
        "anything shown on your screen", "visible on your screen or played",
        "allow usb debugging", "允许 usb 调试", "允许usb调试"};

    /**
     * 提交词表(commit_target):点击目标 text / contentDescription 命中即拒并交还用户。启发式。zh + en。子串匹配。
     * 拨打 / 呼叫 / 拨号 / 保存:T1 开启确认框对用户承诺「发送、拨打、保存永远由你自己按」,T2 能点屏幕后必须守住(09-26 评审)。
     */
    private static final String[] COMMIT_WORDS = {
        "发送", "支付", "付款", "提交", "下单", "购买", "确认支付", "确认付款", "转账", "删除", "立即支付", "立即购买",
        "拨打", "呼叫", "拨号", "保存",
        "send", "pay", "submit", "place order", "buy", "delete", "transfer", "check out", "checkout", "confirm payment"};
    /** 按词边界匹配的英文词:子串会误伤 Data Saver / Calls / Saved / recall / Dialog。 */
    private static final String[] COMMIT_WORDS_BOUNDED = {"call", "save", "dial"};

    // ───────────────────────────── 判定 ─────────────────────────────

    static boolean isProtectedPackage(String pkg) {
        if (pkg == null) return false;
        if (PROTECTED_EXACT.contains(pkg)) return true;
        String p = pkg.toLowerCase(Locale.ROOT);
        for (String suf : PROTECTED_SUFFIX) if (p.endsWith(suf) || p.contains("." + suf) || p.contains(suf)) return true;
        return false;
    }

    static boolean isRedactedPackage(String pkg) {
        return pkg != null && REDACTED_EXACT.contains(pkg);
    }

    static boolean isReadOnlyPackage(String pkg) {
        return pkg != null && READ_ONLY_EXACT.contains(pkg);
    }

    /**
     * 敏感设置页(仅在系统设置类包里才判;避免把普通 App 里叫「安全」的页误伤)。标题**或**首个标题文本命中即算 ——
     * 窗口标题常是泛泛的「设置」/ 空串,只在标题为 null 时才看首个标题(09-26 前的写法)等于放过这些页。
     * 两者都空 = 认不出是哪页 → fail closed(设置包里无标题的对话框多半是授权确认)。
     */
    static boolean isSensitiveSettings(String pkg, String title, String heading) {
        if (!isSettingsPackage(pkg)) return false;
        if (isBlank(title) && isBlank(heading)) return true;
        return containsAny(title, SENSITIVE_SETTINGS) || containsAny(heading, SENSITIVE_SETTINGS);
    }

    static boolean isSystemUi(String pkg) {
        return pkg != null && (SYSTEMUI.equals(pkg) || pkg.toLowerCase(Locale.ROOT).contains("systemui"));
    }

    /** 系统配置面(设置类包 / systemui)的窗口文字里出现同意框专有措辞。 */
    static boolean isConsentSurface(String pkg, List<String> texts) {
        if (texts == null || !(isSettingsPackage(pkg) || isSystemUi(pkg))) return false;
        for (String t : texts) if (containsAny(t, CONSENT_PHRASES)) return true;
        return false;
    }

    static boolean isSettingsPackage(String pkg) {
        if (pkg == null) return false;
        // AOSP 是 com.android.settings;各 OEM 把「密码 / 安全 / 账号」塞进自家安全中心(MIUI com.miui.securitycenter、
        // 部分 ROM 的 *securitycore)。统一按含 "settings" / "securitycenter" / "securitycore" 兜底(启发式)。
        // ⚠️ 刻意只在系统配置面里判敏感标题:否则内容 App 里叫「账号」「安全中心」的页会被误当敏感设置全拦下。
        String p = pkg.toLowerCase(Locale.ROOT);
        return p.contains("settings") || p.contains("securitycenter") || p.contains("securitycore");
    }

    /** 命中提交词表(大小写不敏感;COMMIT_WORDS 子串匹配,COMMIT_WORDS_BOUNDED 按词边界)。 */
    static boolean isCommitLabel(String label) {
        if (label == null) return false;
        String s = label.trim().toLowerCase(Locale.ROOT);
        if (s.isEmpty()) return false;
        for (String w : COMMIT_WORDS) if (s.contains(w.toLowerCase(Locale.ROOT))) return true;
        for (String w : COMMIT_WORDS_BOUNDED) if (containsWord(s, w)) return true;
        return false;
    }

    /** s 里有独立的 w(前后都不是字母 / 数字)。 */
    static boolean containsWord(String s, String w) {
        for (int i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + 1)) {
            int end = i + w.length();
            boolean leftOk = i == 0 || !Character.isLetterOrDigit(s.charAt(i - 1));
            boolean rightOk = end == s.length() || !Character.isLetterOrDigit(s.charAt(end));
            if (leftOk && rightOk) return true;
        }
        return false;
    }

    /** observe 是否被脱敏拦下:redacted 包 → "redacted",否则 null(protected / sensitive / readonly 均可 observe)。 */
    static String observeBlock(String pkg) {
        return isRedactedPackage(pkg) ? "redacted" : null;
    }

    /**
     * 策略判定用的窗口视图(纯数据,由 HandsBridgeService 从**同一份** getWindows() 快照取,与序列化同源)。
     * heading = 窗口内首个非空文字;texts = 窗口内前若干条文字(只对设置类包 / systemui 取,供同意框措辞扫描)。
     */
    static final class Win {
        final String pkg;
        final String title;
        final String heading;
        final List<String> texts;

        Win(String pkg, String title, String heading, List<String> texts) {
            this.pkg = pkg == null ? "" : pkg;
            this.title = title;
            this.heading = heading;
            this.texts = texts == null ? Collections.<String>emptyList() : texts;
        }
    }

    /** 变更类 op 是否被策略拦下:命中返回结果码,否则 null。顺序:保护 → 脱敏 → 只读 → 敏感设置页 → 同意框。 */
    static String mutateBlock(Win w) {
        String pkg = w.pkg;
        if (isProtectedPackage(pkg)) return "protected_app";
        if (isRedactedPackage(pkg)) return "redacted";
        if (isReadOnlyPackage(pkg)) return "read_only_app";
        if (isSensitiveSettings(pkg, w.title, w.heading)) return "protected_app";
        if (isConsentSurface(pkg, w.texts)) return "protected_app";
        return null;
    }

    /** 旧签名(测试 / 只有包名与标题时):heading 视同 title。 */
    static String mutateBlock(String pkg, String title) {
        return mutateBlock(new Win(pkg, title, title, null));
    }

    private static boolean containsAny(String hay, String[] words) {
        if (hay == null) return false;
        String t = hay.toLowerCase(Locale.ROOT);
        for (String w : words) if (t.contains(w.toLowerCase(Locale.ROOT))) return true;
        return false;
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    @SafeVarargs
    private static <T> Set<T> set(T... xs) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(xs)));
    }

    /** 供测试断言用:提交词表(只读;子串词在前,词边界词在后)。 */
    static List<String> commitWords() {
        List<String> all = new java.util.ArrayList<>(Arrays.asList(COMMIT_WORDS));
        all.addAll(Arrays.asList(COMMIT_WORDS_BOUNDED));
        return Collections.unmodifiableList(all);
    }
}
