package com.forsion.tangu;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 手机操控 T1 的**纯逻辑**半身:校验 client_cmd、把 op+args 规划成 IntentSpec(或直接系统调用的描述)、
 * 分级(R1 本机可逆 / R2 交接草稿 / R3 需原生确认 / 拒)、号码清洗、App 名匹配、确认框模板。
 * 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §3.1、§4。
 *
 * 刻意不 import 任何 android.*(org.json 在测试里由 testImplementation 'org.json:json' 提供真实现),
 * 于是整类都能在 JVM 上跑 JUnit(PhoneVerbsTest)。真正碰系统的部分在 PhoneControlPlugin。
 *
 * ⚠️ 分级只看 op + args + 本机 resolveActivity 的事实,**绝不**读 body 里任何「风险」字段 —— body 经过 JS。
 */
final class PhoneVerbs {
    private PhoneVerbs() {}

    enum Tier { R1, R2, R3 }

    /** 本机 verb 表(契约 §4)。不在表里的 op:校验阶段就丢弃(不 claim、不回执)。 */
    static final Set<String> OPS = set("launch", "view", "sendto", "dial", "send", "insert_event",
        "alarm", "timer", "settings", "media", "volume", "torch", "clip");
    /** 要启动 Activity 的 op:Forsion 不在前台 → needs_foreground(后台启动 Activity 会被系统拦)。 */
    static final Set<String> ACTIVITY_OPS = set("launch", "view", "sendto", "dial", "send", "insert_event",
        "alarm", "timer", "settings");

    /**
     * view 一律拒绝的 scheme。契约列的五个之外加了 android-app:它就是 intent: 的另一种写法(Intent.parseUri 认)。
     * tangu = 本 App 自己的 scheme:`tangu://auth-callback?token=…` 会被 MainActivity 当登录回跳吃下(换成对方的账号,
     * 登录 CSRF),确认框上只看得到「Forsion (tangu://auth-callback)」。接手者是本包的兜底在 PhoneControlPlugin.view。
     * ⚠️ 比较前先转小写 —— `JavaScript:` 也得拒。
     */
    static final Set<String> REFUSED_SCHEMES = set("intent", "android-app", "file", "content", "javascript", "data", "tangu");
    /** 先 resolveActivity、落到浏览器 / 地图白名单才免确认的 scheme;其余 App scheme 一律 R3。 */
    static final Set<String> WEB_SCHEMES = set("http", "https", "geo");
    /** 地图 App 自家的导航 scheme(引擎 phoneLinks.ts 的导航候选排在最前的就是它们):只有落到 MAPS 白名单才免确认 ——
     *  否则装了高德的手机每次导航都要弹一次确认框。落到别的包(有人注册了同名 scheme)照旧 R3。 */
    static final Set<String> MAP_SCHEMES = set("amapuri", "androidamap", "baidumap", "qqmap");

    /** 浏览器白名单(包名精确匹配)。https/geo 解析到它们 = R1。 */
    static final Set<String> BROWSERS = set(
        "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary", "org.chromium.chrome",
        "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "org.mozilla.focus",
        "com.microsoft.emmx", "com.sec.android.app.sbrowser", "com.opera.browser", "com.opera.mini.native",
        "com.brave.browser", "com.duckduckgo.mobile.android", "com.vivaldi.browser", "com.kiwibrowser.browser",
        "com.android.browser", "com.mi.globalbrowser", "com.huawei.browser", "com.heytap.browser",
        "com.vivo.browser", "com.UCMobile", "com.uc.browser.en", "com.tencent.mtt", "com.quark.browser");
    /** 地图白名单。 */
    static final Set<String> MAPS = set(
        "com.google.android.apps.maps", "com.autonavi.minimap", "com.baidu.BaiduMap", "com.tencent.map",
        "com.huawei.maps.app", "com.sogou.map.android.maps", "com.here.app.maps", "net.osmand", "net.osmand.plus",
        "com.waze");

    static final int MAX_BODY = 256 * 1024;
    static final int MAX_TEXT = 50_000;
    static final int MAX_CANDIDATES = 6;
    static final int MAX_URI = 2048;
    static final int MAX_AMBIGUOUS = 8;

    private static final Pattern RUN_ID = Pattern.compile("^[A-Za-z0-9._:-]{1,128}$");
    private static final Pattern ACK_ID = Pattern.compile("^cc_[A-Za-z0-9_-]{1,128}$");
    private static final Pattern SCHEME = Pattern.compile("^([A-Za-z][A-Za-z0-9+.-]*):");
    private static final Pattern PACKAGE = Pattern.compile("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$");

    /** 规划失败:code 进 result(invalid_args / refused / unsupported),message 是给模型看的英文。 */
    static final class Reject extends Exception {
        final String code;

        Reject(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    // ───────────────────────────── 1 · 校验(契约 §3.1) ─────────────────────────────

    /** 通过校验的一条指令。body 原样保留:digest 必须按收到的字节算,绝不能拿解析后的对象重新序列化。 */
    static final class Command {
        final String runId;
        final String ackId;
        final String body;
        final String op;
        final JSONObject args;

        Command(String runId, String ackId, String body, String op, JSONObject args) {
            this.runId = runId;
            this.ackId = ackId;
            this.body = body;
            this.op = op;
            this.args = args;
        }
    }

    /**
     * 契约 §3.1 的全部检查(外加 target.kind==='origin':远程驱动以后走另一条信任路径,老包不该接)。
     * 任何一条不符 → null:调用方不 claim、不执行、不回执。LRU 去重由调用方做。
     */
    static Command parseCommand(String runId, String ackId, String body) {
        if (runId == null || ackId == null || body == null) return null;
        if (!RUN_ID.matcher(runId).matches() || !ACK_ID.matcher(ackId).matches()) return null;
        if (body.length() > MAX_BODY) return null;
        try {
            JSONObject o = new JSONObject(body);
            Object v = o.opt("v");
            if (!(v instanceof Integer) || (Integer) v != 1) return null;
            if (!runId.equals(o.opt("runId")) || !ackId.equals(o.opt("ackId"))) return null;
            if (!"phone".equals(o.opt("ns"))) return null;
            Object op = o.opt("op");
            if (!(op instanceof String) || !OPS.contains(op)) return null;
            Object target = o.opt("target");
            if (!(target instanceof JSONObject) || !"origin".equals(((JSONObject) target).opt("kind"))) return null;
            Object args = o.opt("args");
            if (args == null || args == JSONObject.NULL) args = new JSONObject();
            if (!(args instanceof JSONObject)) return null;
            return new Command(runId, ackId, body, (String) op, (JSONObject) args);
        } catch (JSONException e) {
            return null;
        }
    }

    /** claim 的 digest:body 的 UTF-8 字节 sha256,小写 hex。 */
    static String sha256Hex(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder(d.length * 2);
            for (byte x : d) b.append(String.format(Locale.ROOT, "%02x", x));
            return b.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ───────────────────────────── 2 · 规划(契约 §4) ─────────────────────────────

    /**
     * 一条 op 的执行计划。intents 非空 = 启动 Activity(按序尝试);否则是直接系统调用(media/volume/torch/clip)
     * 或 launch(按包名 / App 名现查)。tier 为 null 仅见于 view:按每个候选 resolveActivity 的结果现定。
     */
    static final class Plan {
        final String op;
        final Tier tier;
        final List<IntentSpec> intents;
        /** launch:二选一。 */
        final String pkg;
        final String name;
        /** media 的 key / volume 的 dir(已校验的闭集值)。 */
        final String choice;
        /** torch。 */
        final boolean on;
        /** clip。 */
        final String text;
        /** alarm/timer:OEM 可能不认 SKIP_UI,结果写 verified:false。 */
        final boolean unverified;

        private Plan(String op, Tier tier, List<IntentSpec> intents, String pkg, String name, String choice,
                     boolean on, String text, boolean unverified) {
            this.op = op;
            this.tier = tier;
            this.intents = intents == null ? Collections.<IntentSpec>emptyList() : Collections.unmodifiableList(intents);
            this.pkg = pkg;
            this.name = name;
            this.choice = choice;
            this.on = on;
            this.text = text;
            this.unverified = unverified;
        }

        boolean needsForeground() {
            return ACTIVITY_OPS.contains(op);
        }

        private static Plan intents(String op, Tier tier, boolean unverified, IntentSpec... specs) {
            return new Plan(op, tier, new ArrayList<>(Arrays.asList(specs)), null, null, null, false, null, unverified);
        }

        private static Plan direct(String op, String choice, boolean on, String text) {
            return new Plan(op, Tier.R1, null, null, null, choice, on, text, false);
        }
    }

    /**
     * op + args → Plan。ownPkg = 本 App 包名(settings 的 app_details 页);zone = 设备时区(insert_event 的无时区时刻)。
     */
    static Plan plan(String op, JSONObject a, String ownPkg, ZoneId zone) throws Reject {
        switch (op) {
            case "launch": {
                String pkg = str(a, "pkg", 200, false);
                String name = str(a, "name", 80, false);
                if (pkg != null && !pkg.trim().isEmpty()) {
                    pkg = pkg.trim();
                    if (!PACKAGE.matcher(pkg).matches()) throw bad("pkg is not a valid Android package name");
                    return new Plan(op, Tier.R1, null, pkg, null, null, false, null, false);
                }
                if (name != null && !name.trim().isEmpty()) {
                    return new Plan(op, Tier.R1, null, null, name.trim(), null, false, null, false);
                }
                throw bad("launch needs pkg or name");
            }
            case "view": {
                JSONArray c = a.optJSONArray("candidates");
                if (c == null || c.length() == 0 || c.length() > MAX_CANDIDATES) {
                    throw bad("candidates must be 1-" + MAX_CANDIDATES + " URIs");
                }
                List<IntentSpec> specs = new ArrayList<>();
                // 先整体校验:任何一个候选是危险 scheme,整条拒绝(不「跳过坏的、试好的」)。
                for (int i = 0; i < c.length(); i++) {
                    Object o = c.opt(i);
                    if (!(o instanceof String)) throw bad("candidates must be strings");
                    String uri = ((String) o).trim();
                    if (uri.isEmpty() || uri.length() > MAX_URI || hasControlChars(uri)) throw bad("invalid URI in candidates");
                    String scheme = schemeOf(uri);
                    if (scheme == null) throw bad("URI has no scheme: candidates must be absolute URIs");
                    if (REFUSED_SCHEMES.contains(scheme)) throw new Reject("refused", "The " + scheme + ": scheme is not allowed.");
                    IntentSpec.Builder b = IntentSpec.of("android.intent.action.VIEW").data(uri)
                        .flags(IntentSpec.FLAG_ACTIVITY_NEW_TASK);
                    // 与浏览器里点链接同一口径:只让声明了 BROWSABLE 的 Activity 接(App 内部页面够不着)。
                    // geo: 例外 —— 部分地图 App 的 geo 过滤器不带 BROWSABLE,加上会让导航候选全落空。
                    if (!"geo".equals(scheme)) b.category(IntentSpec.CATEGORY_BROWSABLE);
                    specs.add(b.build());
                }
                return new Plan(op, null, specs, null, null, null, false, null, false);
            }
            case "sendto": {
                String uri = str(a, "uri", MAX_URI, true).trim();
                String text = str(a, "text", MAX_TEXT, false);
                String subject = str(a, "subject", 1000, false);
                if (hasControlChars(uri)) throw bad("invalid uri");
                String scheme = schemeOf(uri);
                String rest = scheme == null ? "" : uri.substring(scheme.length() + 1);
                IntentSpec.Builder b;
                if ("smsto".equals(scheme)) {
                    b = IntentSpec.of("android.intent.action.SENDTO").data("smsto:" + sanitizeRecipients(rest))
                        .extra("sms_body", text);
                } else if ("mailto".equals(scheme)) {
                    // 只留地址段:主题 / 正文走 extras,不让 URI 里的 query 夹带别的字段。
                    int q = rest.indexOf('?');
                    String addr = (q >= 0 ? rest.substring(0, q) : rest).trim();
                    if (addr.length() > 320 || addr.matches(".*\\s.*")) throw bad("invalid mailto address");
                    b = IntentSpec.of("android.intent.action.SENDTO").data("mailto:" + addr)
                        .extra("android.intent.extra.SUBJECT", subject).extra("android.intent.extra.TEXT", text);
                } else {
                    throw bad("uri must be smsto: or mailto:");
                }
                return Plan.intents(op, Tier.R2, false, b.flags(IntentSpec.FLAG_ACTIVITY_NEW_TASK).build());
            }
            case "dial": {
                String number = sanitizeNumber(str(a, "number", 100, true));
                if (number.isEmpty() || number.length() > 40) throw bad("number must contain 1-40 of [0-9+*#]");
                // 只用 ACTION_DIAL(填号不拨);'#' 在 URI 里是片段分隔符,必须编码,否则 *#06# 会被截成 *。
                return Plan.intents(op, Tier.R2, false, IntentSpec.of("android.intent.action.DIAL")
                    .data("tel:" + number.replace("#", "%23")).flags(IntentSpec.FLAG_ACTIVITY_NEW_TASK).build());
            }
            case "send": {
                String text = str(a, "text", MAX_TEXT, true);
                if (text.trim().isEmpty()) throw bad("text is empty");
                String subject = str(a, "subject", 1000, false);
                return Plan.intents(op, Tier.R2, false, IntentSpec.of("android.intent.action.SEND").type("text/plain")
                    .extra("android.intent.extra.TEXT", text).extra("android.intent.extra.SUBJECT", subject)
                    .flags(IntentSpec.FLAG_ACTIVITY_NEW_TASK).chooser().build());
            }
            case "insert_event": {
                String title = str(a, "title", 500, true).trim();
                if (title.isEmpty()) throw bad("title is empty");
                When start = parseWhen(str(a, "start", 64, true), zone);
                String endRaw = str(a, "end", 64, false);
                When end = endRaw == null || endRaw.trim().isEmpty() ? null : parseWhen(endRaw, zone);
                if (end != null && end.millis < start.millis) throw bad("end is before start");
                IntentSpec.Builder b = IntentSpec.of("android.intent.action.INSERT")
                    .data("content://com.android.calendar/events")
                    .extra("title", title)
                    .extra("beginTime", start.millis)
                    .extra("endTime", end == null ? null : end.millis)
                    .extra("eventLocation", str(a, "location", 500, false))
                    .extra("description", str(a, "description", 5000, false))
                    .flags(IntentSpec.FLAG_ACTIVITY_NEW_TASK);
                if (start.allDay) b.extra("allDay", Boolean.TRUE);
                return Plan.intents(op, Tier.R2, false, b.build());
            }
            case "alarm": {
                int hour = intArg(a, "hour", 0, 23);
                int minute = intArg(a, "minute", 0, 59);
                ArrayList<Integer> days = null;
                JSONArray d = a.optJSONArray("days");
                if (a.has("days") && !a.isNull("days") && d == null) throw bad("days must be an array");
                if (d != null && d.length() > 0) {
                    // 1=周日 … 7=周六(java.util.Calendar,即 AlarmClock.EXTRA_DAYS 的口径;契约 §4 已钉)。
                    TreeSet<Integer> set = new TreeSet<>();
                    for (int i = 0; i < d.length(); i++) set.add(intValue(d.opt(i), "days", 1, 7));
                    days = new ArrayList<>(set);
                }
                return Plan.intents(op, Tier.R1, true, IntentSpec.of("android.intent.action.SET_ALARM")
                    .extra("android.intent.extra.alarm.HOUR", hour)
                    .extra("android.intent.extra.alarm.MINUTES", minute)
                    .extra("android.intent.extra.alarm.DAYS", days)
                    .extra("android.intent.extra.alarm.MESSAGE", str(a, "label", 200, false))
                    .extra("android.intent.extra.alarm.SKIP_UI", Boolean.TRUE)
                    .flags(IntentSpec.FLAG_ACTIVITY_NEW_TASK).build());
            }
            case "timer": {
                int seconds = intArg(a, "seconds", 1, 86_400);
                return Plan.intents(op, Tier.R1, true, IntentSpec.of("android.intent.action.SET_TIMER")
                    .extra("android.intent.extra.alarm.LENGTH", seconds)
                    .extra("android.intent.extra.alarm.MESSAGE", str(a, "label", 200, false))
                    .extra("android.intent.extra.alarm.SKIP_UI", Boolean.TRUE)
                    .flags(IntentSpec.FLAG_ACTIVITY_NEW_TASK).build());
            }
            case "settings": {
                String page = str(a, "page", 32, true);
                List<IntentSpec> specs = settingsPage(page, ownPkg);
                if (specs == null) throw bad("unknown settings page: " + page);
                return new Plan(op, Tier.R1, specs, null, null, null, false, null, false);
            }
            case "media":
                return Plan.direct(op, oneOf(a, "key", "play_pause", "next", "previous"), false, null);
            case "volume":
                return Plan.direct(op, oneOf(a, "dir", "up", "down", "mute"), false, null);
            case "torch": {
                Object on = a.opt("on");
                if (!(on instanceof Boolean)) throw bad("on must be a boolean");
                return Plan.direct(op, null, (Boolean) on, null);
            }
            case "clip": {
                String text = str(a, "text", MAX_TEXT, true);
                if (text.isEmpty()) throw bad("text is empty");
                return Plan.direct(op, null, false, text);
            }
            default:
                throw new Reject("unsupported", "Unsupported op: " + op);
        }
    }

    /** settings 的闭集页 → 按序尝试的 Intent(靠后的是老系统 / OEM 的兜底)。未知页 → null。 */
    static List<IntentSpec> settingsPage(String page, String ownPkg) {
        List<String> actions;
        String data = null;
        String appExtra = null;
        switch (page) {
            case "wifi": actions = Collections.singletonList("android.settings.WIFI_SETTINGS"); break;
            case "bluetooth": actions = Collections.singletonList("android.settings.BLUETOOTH_SETTINGS"); break;
            case "display": actions = Collections.singletonList("android.settings.DISPLAY_SETTINGS"); break;
            case "sound": actions = Collections.singletonList("android.settings.SOUND_SETTINGS"); break;
            case "battery": actions = Arrays.asList("android.intent.action.POWER_USAGE_SUMMARY", "android.settings.BATTERY_SAVER_SETTINGS"); break;
            case "location": actions = Collections.singletonList("android.settings.LOCATION_SOURCE_SETTINGS"); break;
            // 系统通知总页:13+ 有公开的 ALL_APPS_NOTIFICATION_SETTINGS;老系统用 AOSP 设置导出的 NOTIFICATION_SETTINGS;
            // 都不在就退到本 App 的通知页。
            case "notifications":
                actions = Arrays.asList("android.settings.ALL_APPS_NOTIFICATION_SETTINGS", "android.settings.NOTIFICATION_SETTINGS",
                    "android.settings.APP_NOTIFICATION_SETTINGS");
                appExtra = ownPkg;
                break;
            // 本 App 的应用信息页(权限、通知、电池优化的入口)。
            case "app_details": actions = Collections.singletonList("android.settings.APPLICATION_DETAILS_SETTINGS"); data = "package:" + ownPkg; break;
            case "date": actions = Collections.singletonList("android.settings.DATE_SETTINGS"); break;
            case "language": actions = Collections.singletonList("android.settings.LOCALE_SETTINGS"); break;
            case "accessibility": actions = Collections.singletonList("android.settings.ACCESSIBILITY_SETTINGS"); break;
            case "main": actions = Collections.singletonList("android.settings.SETTINGS"); break;
            default: return null;
        }
        List<IntentSpec> out = new ArrayList<>();
        for (String action : actions) {
            IntentSpec.Builder b = IntentSpec.of(action).data(data).flags(IntentSpec.FLAG_ACTIVITY_NEW_TASK);
            if ("android.settings.APP_NOTIFICATION_SETTINGS".equals(action)) b.extra("android.provider.extra.APP_PACKAGE", appExtra);
            out.add(b.build());
        }
        return out;
    }

    // ───────────────────────────── 3 · 分级与确认框 ─────────────────────────────

    /** URI 的 scheme(小写);不是绝对 URI → null。 */
    static String schemeOf(String uri) {
        if (uri == null) return null;
        Matcher m = SCHEME.matcher(uri);
        return m.find() ? m.group(1).toLowerCase(Locale.ROOT) : null;
    }

    static boolean isAllowlistedHandler(String pkg) {
        return pkg != null && (BROWSERS.contains(pkg) || MAPS.contains(pkg));
    }

    /**
     * view 的分级:http/https/geo 且**所有**可能接手的包都在浏览器 / 地图白名单 → R1;其余 → R3。
     * handlerPkgs = resolveActivity 的包(有默认处理者时只有一个;落到系统选择器时是全部候选)。
     */
    static Tier tierForView(String scheme, List<String> handlerPkgs) {
        if (handlerPkgs == null || handlerPkgs.isEmpty()) return Tier.R3;
        if (MAP_SCHEMES.contains(scheme)) {
            for (String p : handlerPkgs) if (!MAPS.contains(p)) return Tier.R3;
            return Tier.R1;
        }
        if (!WEB_SCHEMES.contains(scheme)) return Tier.R3;
        for (String p : handlerPkgs) if (!isAllowlistedHandler(p)) return Tier.R3;
        return Tier.R1;
    }

    /**
     * 确认框里的 {target}:`scheme://host`(无 host 时 `scheme:`)。host 剥掉 userinfo 与端口 ——
     * `https://bank.com@evil.com` 显示成 evil.com,与 android.net.Uri#getHost 同口径,不让 userinfo 冒充目标。
     */
    static String targetOf(String uri) {
        String scheme = schemeOf(uri);
        if (scheme == null) return "";
        String rest = uri.substring(scheme.length() + 1);
        if (!rest.startsWith("//")) return clean(scheme + ":", 80);
        String auth = rest.substring(2);
        int end = auth.length();
        for (char c : new char[] {'/', '?', '#'}) {
            int i = auth.indexOf(c);
            if (i >= 0 && i < end) end = i;
        }
        auth = auth.substring(0, end);
        int at = auth.lastIndexOf('@');
        if (at >= 0) auth = auth.substring(at + 1);
        if (auth.startsWith("[")) {
            int close = auth.indexOf(']');
            if (close > 0) auth = auth.substring(0, close + 1);
        } else {
            int colon = auth.indexOf(':');
            if (colon >= 0) auth = auth.substring(0, colon);
        }
        auth = auth.toLowerCase(Locale.ROOT);
        return clean(auth.isEmpty() ? scheme + ":" : scheme + "://" + auth, 80);
    }

    /** configure.strings 的必需键(契约 §6)。 */
    static final List<String> STRING_KEYS = Collections.unmodifiableList(Arrays.asList(
        "enableTitle", "enableBody", "enableConfirm", "cancel", "confirmTitle", "confirmBody", "confirmAllow", "confirmDeny"));

    /**
     * 校验 configure 下发的文案:八个键齐全、非空、≤2000 字;confirmBody 必须同时含 {app} 与 {target}
     * (事实由原生填,翻译过的外壳藏不住事实)。不合格 → 返回原因(英文,进 reject),合格 → null。
     */
    static String checkStrings(Map<String, String> s) {
        for (String k : STRING_KEYS) {
            String v = s.get(k);
            if (v == null || v.trim().isEmpty()) return "missing string: " + k;
            if (v.length() > 2000) return "string too long: " + k;
        }
        String body = s.get("confirmBody");
        if (!body.contains("{app}") || !body.contains("{target}")) return "confirmBody must contain {app} and {target}";
        return null;
    }

    /** 把原生核实过的事实填进模板;值先剥控制字符与 bidi 覆写(防 App 名用 RLO 之类倒转显示)。 */
    static String fill(String template, String app, String target) {
        return template.replace("{app}", clean(app, 60)).replace("{target}", clean(target, 80));
    }

    static String clean(String s, int max) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(Math.min(s.length(), max));
        for (int i = 0; i < s.length() && b.length() < max; i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c == 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
                || c == 0x200e || c == 0x200f || c == 0x061c) continue;
            b.append(c);
        }
        return b.toString().trim();
    }

    // ───────────────────────────── 4 · 号码与 App 名 ─────────────────────────────

    /** 拨号:只留 [0-9+*#](契约 §4)。 */
    static String sanitizeNumber(String s) {
        return s == null ? "" : s.replaceAll("[^0-9+*#]", "");
    }

    /** 短信收件人:只留数字、+ 与分隔符 , ;(可为空 = 不预填收件人)。 */
    static String sanitizeRecipients(String s) {
        if (s == null) return "";
        if (s.startsWith("//")) s = s.substring(2);
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        return s.replaceAll("[^0-9+,;]", "");
    }

    /**
     * 按名字找 App。apps 每项 = {label, pkg}。依次:包名精确 → 显示名精确(忽略大小写与空白)→ 显示名包含。
     * 同一个包多个启动入口只算一次。返回的列表:空 = not_found;一项 = 启动它;多项 = ambiguous。
     */
    static List<String[]> matchApps(String query, List<String[]> apps) {
        String q = norm(query);
        if (q.isEmpty()) return Collections.emptyList();
        for (String[] a : apps) {
            if (a[1].equalsIgnoreCase(query.trim())) return Collections.singletonList(a);
        }
        Map<String, String[]> exact = new LinkedHashMap<>();
        Map<String, String[]> partial = new LinkedHashMap<>();
        for (String[] a : apps) {
            String l = norm(a[0]);
            if (l.isEmpty()) continue;
            if (l.equals(q)) exact.putIfAbsent(a[1], a);
            else if (l.contains(q)) partial.putIfAbsent(a[1], a);
        }
        return new ArrayList<>((exact.isEmpty() ? partial : exact).values());
    }

    /** ambiguous 的 text:≤8 行 `label (pkg)`。 */
    static String describeCandidates(List<String[]> matches) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < matches.size() && i < MAX_AMBIGUOUS; i++) {
            if (b.length() > 0) b.append('\n');
            b.append(clean(matches.get(i)[0], 60)).append(" (").append(matches.get(i)[1]).append(')');
        }
        if (matches.size() > MAX_AMBIGUOUS) b.append("\n(+").append(matches.size() - MAX_AMBIGUOUS).append(" more)");
        return b.toString();
    }

    private static String norm(String s) {
        return s == null ? "" : s.replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
    }

    // ───────────────────────────── 5 · apiBase ─────────────────────────────

    /**
     * forsion-native.json 里的 apiBase:https 任意主机;http 只认本机回环 / 模拟器宿主(debug 台架),
     * 与 debug 的 network_security_config 同一口径。不合格 → null(原生什么都不发)。
     */
    static String checkApiBase(String s) {
        if (s == null) return null;
        s = s.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (!s.matches("^https?://[^\\s/?#@]+(/[^\\s?#]*)?$")) return null;
        if (s.startsWith("http://")) {
            String host = targetOf(s).substring("http://".length());
            if (!host.equals("localhost") && !host.equals("127.0.0.1") && !host.equals("10.0.2.2")) return null;
        }
        return s;
    }

    // ───────────────────────────── 6 · 期限、去重与主线程 ─────────────────────────────

    /** 本地期限比引擎的 execMs 早收这么多:留给 result 在路上的时间,别让「做了」撞上引擎的超时判定。 */
    static final long DEADLINE_MARGIN_MS = 1_500;

    /**
     * 本地期限 = 收到 claim 200 的时刻 + execMs − 余量(契约 §3.2)。
     * ⚠️ 锚点必须是**成功那次**响应的到达时刻:重复 claim 回的 execMs 是引擎按自己时钟算的**剩余**时长,
     *    再从第一次发出算起就把已过去的时间扣了两遍(丢响应重试的那条路永远执行不了)。
     * ⚠️ 只钳上界、不钳下界:剩余可以合法地小于 5s(5–120s 是引擎配置值的范围),抬到 5s 会把本地期限推过引擎的。
     */
    static long localDeadline(long receivedAt, long execMs) {
        return receivedAt + Math.max(0, Math.min(120_000, execMs)) - DEADLINE_MARGIN_MS;
    }

    /** 副作用前最后一道闸的判定。 */
    enum Gate { GO, EXPIRED, NEEDS_FOREGROUND }

    /**
     * 副作用前的最后一道闸:commit 返回之后、主线程里 startActivity / 写剪贴板之前、直接系统调用之前,各现查一次。
     * 期限优先 —— 过了本地期限一律 EXPIRED(不执行、不回执,由引擎按超时兑现);期限内才看前台(needsForeground 且
     * 不在前台 → NEEDS_FOREGROUND)。
     * ⚠️ 只在更早的地方查过一次不算数:commit 是阻塞 HTTP、主线程可能排队近 10s、确认之后用户可能按了 Home ——
     *    查完到真正执行之间的任何一段都可能越过期限 / 离开前台。foreground 必须是在主线程上现读的值。
     */
    static Gate gate(long now, long deadline, boolean needsForeground, boolean foreground) {
        if (now > deadline) return Gate.EXPIRED;
        if (needsForeground && !foreground) return Gate.NEEDS_FOREGROUND;
        return Gate.GO;
    }

    /**
     * 见过的 ackId(契约 §3.1 的本机 LRU,按插入序淘汰最老的)。add = 原子地「查 + 占位」:
     * 校验通过的那一刻就占位,并发转交同一条指令时只有一次返回 true —— 重复的在 claim 发出之前就被挡掉。
     * ⚠️ claim 已经是多线程并发的,查与占位必须在同一把锁里;拆成 contains + put 两步就会两条都放行。
     */
    static final class SeenAcks {
        private final Map<String, Boolean> seen;

        SeenAcks(final int capacity) {
            seen = new LinkedHashMap<String, Boolean>(64, 0.75f, false) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) {
                    return size() > capacity;
                }
            };
        }

        synchronized boolean add(String ackId) {
            if (seen.containsKey(ackId)) return false;
            seen.put(ackId, Boolean.TRUE);
            return true;
        }
    }

    /**
     * 把 fn 交给 post(生产里是主线程 Handler)执行,最多等 timeoutMs。
     * 超时:还没开跑 → 作废(之后轮到它也是空操作,保证不会在回执「失败」之后迟到执行)并抛 TimeoutException;
     * 已经开跑 → 等它跑完拿真实结果 —— 副作用已经发生时绝不报失败。
     * ⚠️ 不能用 FutureTask.cancel(false) 判「开没开跑」:任务跑到一半它照样返回 true(状态在 set 前一直是 NEW),
     *    fn 继续跑完、结果被丢,调用方却以为撤掉了。所以「开跑」与「作废」抢同一个 CAS,谁先谁算。
     */
    static <T> T callBounded(Executor post, Callable<T> fn, long timeoutMs) throws Exception {
        AtomicBoolean claimed = new AtomicBoolean(false);
        FutureTask<T> f = new FutureTask<>(() -> claimed.compareAndSet(false, true) ? fn.call() : null);
        post.execute(f);
        try {
            try {
                return f.get(timeoutMs, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                if (claimed.compareAndSet(false, true)) throw e;
                return f.get();
            }
        } catch (ExecutionException e) {
            Throwable c = e.getCause();
            if (c instanceof Exception) throw (Exception) c;
            throw e;
        }
    }

    // ───────────────────────────── 参数工具 ─────────────────────────────

    private static Reject bad(String message) {
        return new Reject("invalid_args", message);
    }

    /** 字符串参数:缺省 / null → null(required 时抛);非字符串或超长 → invalid_args。 */
    private static String str(JSONObject a, String key, int max, boolean required) throws Reject {
        Object v = a.opt(key);
        if (v == null || v == JSONObject.NULL) {
            if (required) throw bad(key + " is required");
            return null;
        }
        if (!(v instanceof String)) throw bad(key + " must be a string");
        String s = (String) v;
        if (s.length() > max) throw bad(key + " is longer than " + max + " characters");
        return s;
    }

    private static int intArg(JSONObject a, String key, int min, int max) throws Reject {
        if (!a.has(key) || a.isNull(key)) throw bad(key + " is required");
        return intValue(a.opt(key), key, min, max);
    }

    private static int intValue(Object v, String key, int min, int max) throws Reject {
        long n;
        if (v instanceof Integer || v instanceof Long) n = ((Number) v).longValue();
        else if (v instanceof Double && ((Double) v) == Math.rint((Double) v)) n = ((Double) v).longValue();
        else throw bad(key + " must be an integer");
        if (n < min || n > max) throw bad(key + " must be " + min + "-" + max);
        return (int) n;
    }

    private static String oneOf(JSONObject a, String key, String... allowed) throws Reject {
        String v = str(a, key, 32, true);
        for (String x : allowed) if (x.equals(v)) return v;
        throw bad(key + " must be one of " + String.join("|", allowed));
    }

    private static boolean hasControlChars(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c == 0x7f) return true;
        }
        return false;
    }

    /** insert_event 的时刻。 */
    static final class When {
        final long millis;
        final boolean allDay;

        When(long millis, boolean allDay) {
            this.millis = millis;
            this.allDay = allDay;
        }
    }

    /** ISO 8601:带偏移 / 带时区 id / 本地时刻(按设备时区)/ 纯日期(全天)。 */
    static When parseWhen(String s, ZoneId zone) throws Reject {
        String t = s.trim();
        // `+0800` → `+08:00`:引擎的 ISO 校验放行不带冒号的偏移,而 Android 8–12 的 java.time(OpenJDK 8 系)不认。
        if (t.indexOf('T') > 0) t = t.replaceFirst("([+-]\\d{2})(\\d{2})$", "$1:$2");
        long ms;
        boolean allDay = false;
        try {
            ms = OffsetDateTime.parse(t).toInstant().toEpochMilli();
        } catch (DateTimeParseException e1) {
            try {
                ms = ZonedDateTime.parse(t).toInstant().toEpochMilli();
            } catch (DateTimeParseException e2) {
                try {
                    ms = LocalDateTime.parse(t).atZone(zone).toInstant().toEpochMilli();
                } catch (DateTimeParseException e3) {
                    try {
                        ms = LocalDate.parse(t).atStartOfDay(zone).toInstant().toEpochMilli();
                        allDay = true;
                    } catch (DateTimeParseException e4) {
                        throw bad("time must be ISO 8601, e.g. 2026-09-25T14:30 or 2026-09-25T14:30+08:00");
                    }
                }
            }
        }
        // 1970 – 2200:挡掉明显的解析事故(年份写错一位之类)。
        if (ms < 0 || ms > 7_258_118_400_000L) throw bad("time is out of range");
        return new When(ms, allDay);
    }

    @SafeVarargs
    private static <T> Set<T> set(T... xs) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(xs)));
    }
}
