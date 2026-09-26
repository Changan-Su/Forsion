package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 手机操控 T1 的纯逻辑单测(JVM,无设备):校验、分级、号码清洗、Intent 规划、确认框模板、期限闸、去重。
 * 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §3.1、§4、§6。
 * 跑法:cd mobile/android && ./gradlew testDebugUnitTest
 */
public class PhoneVerbsTest {
    private static final String OWN = "com.forsion.tangu";
    private static final ZoneId SH = ZoneId.of("Asia/Shanghai");
    private static final String RUN = "3f2c7a1e-0b4d-4c5e-9a8b-1234567890ab";
    private static final String ACK = "cc_mfx1_7_AbCdEfGhIjKl";

    // ───────── 校验(§3.1) ─────────

    private static String body(String mutate) throws Exception {
        JSONObject o = new JSONObject();
        o.put("v", 1).put("runId", RUN).put("sessionId", "s1").put("ackId", ACK).put("ns", "phone")
            .put("op", "volume").put("args", new JSONObject().put("dir", "up")).put("iat", 1790000000000L)
            .put("target", new JSONObject().put("kind", "origin"));
        switch (mutate) {
            case "v2": o.put("v", 2); break;
            case "vString": o.put("v", "1"); break;
            case "run": o.put("runId", "other"); break;
            case "ack": o.put("ackId", "cc_other"); break;
            case "ns": o.put("ns", "desk"); break;
            case "op": o.put("op", "shell"); break;
            case "noArgs": o.remove("args"); break;
            case "argsArray": o.put("args", new JSONArray()); break;
            case "device": o.put("target", new JSONObject().put("kind", "device")); break;
            case "noTarget": o.remove("target"); break;
            default: break;
        }
        return o.toString();
    }

    @Test
    public void parseCommand_acceptsWellFormedBody() throws Exception {
        String b = body("");
        PhoneVerbs.Command c = PhoneVerbs.parseCommand(RUN, ACK, b);
        assertNotNull(c);
        assertEquals("volume", c.op);
        assertEquals("up", c.args.getString("dir"));
        assertEquals("body is kept verbatim for the digest", b, c.body);
        PhoneVerbs.Command noArgs = PhoneVerbs.parseCommand(RUN, ACK, body("noArgs"));
        assertNotNull(noArgs);
        assertEquals(0, noArgs.args.length());
    }

    @Test
    public void parseCommand_rejectsEveryContractViolation() throws Exception {
        for (String m : new String[] {"v2", "vString", "run", "ack", "ns", "op", "argsArray", "device", "noTarget"}) {
            assertNull(m, PhoneVerbs.parseCommand(RUN, ACK, body(m)));
        }
        assertNull("malformed JSON", PhoneVerbs.parseCommand(RUN, ACK, "{not json"));
        assertNull("ackId without cc_ prefix", PhoneVerbs.parseCommand(RUN, "ui_1", body("")));
        assertNull("runId with a slash", PhoneVerbs.parseCommand("a/b", ACK, body("")));
        assertNull("null body", PhoneVerbs.parseCommand(RUN, ACK, null));
        StringBuilder huge = new StringBuilder();
        while (huge.length() <= PhoneVerbs.MAX_BODY) huge.append("xxxxxxxxxx");
        assertNull("oversized body", PhoneVerbs.parseCommand(RUN, ACK, huge.toString()));
    }

    @Test
    public void sha256Hex_isUtf8LowercaseHex() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", PhoneVerbs.sha256Hex("abc"));
        assertEquals("a567bdaa11367f260f0708391f4d10766b5962f565d9e432f17981a3584fe1e2", PhoneVerbs.sha256Hex("中"));
    }

    // ───────── 号码 ─────────

    @Test
    public void sanitizeNumber_keepsOnlyDialChars() {
        assertEquals("+8613800000000", PhoneVerbs.sanitizeNumber("+86 138-0000-0000;rm"));
        assertEquals("*#06#", PhoneVerbs.sanitizeNumber("*#06#"));
        assertEquals("", PhoneVerbs.sanitizeNumber("call me"));
        assertEquals("", PhoneVerbs.sanitizeNumber(null));
    }

    @Test
    public void dial_isActionDialWithEncodedHash() throws Exception {
        PhoneVerbs.Plan p = plan("dial", "{\"number\":\"+86 138-0000-0000;rm\"}");
        assertEquals(PhoneVerbs.Tier.R2, p.tier);
        IntentSpec s = only(p);
        assertEquals("android.intent.action.DIAL", s.action);
        assertEquals("tel:+8613800000000", s.data);
        assertEquals("tel:*%2306%23", only(plan("dial", "{\"number\":\"*#06#\"}")).data);
        assertReject("invalid_args", "dial", "{\"number\":\"call mom\"}");
        assertReject("invalid_args", "dial", "{\"number\":12345}");
    }

    // ───────── view 分级 ─────────

    @Test
    public void view_refusesDangerousSchemesCaseInsensitively() {
        for (String u : new String[] {"intent://evil#Intent;scheme=http;end", "JavaScript:alert(1)", " file:///sdcard/a.apk",
            "content://media/external/1", "data:text/html,<b>x</b>", "android-app://com.evil/https/x",
            // 本 App 自己的 scheme:登录回跳会吃下别人的 token(登录 CSRF)
            "tangu://auth-callback?token=ATTACKER", "TANGU://auth-callback?token=ATTACKER"}) {
            assertReject("refused", "view", "{\"candidates\":[" + JSONObject.quote(u) + "]}");
        }
        // 一个坏的连累整条:不「跳过坏的、试好的」
        assertReject("refused", "view", "{\"candidates\":[\"https://example.com\",\"intent://x\"]}");
    }

    @Test
    public void view_rejectsMalformedCandidates() {
        assertReject("invalid_args", "view", "{\"candidates\":[]}");
        assertReject("invalid_args", "view", "{\"candidates\":[\"example.com/no-scheme\"]}");
        assertReject("invalid_args", "view", "{\"candidates\":[\"https://a\\nb\"]}");
        assertReject("invalid_args", "view", "{\"candidates\":[1]}");
        assertReject("invalid_args", "view", "{\"candidates\":[\"https://a\",\"https://b\",\"https://c\",\"https://d\",\"https://e\",\"https://f\",\"https://g\"]}");
        assertReject("invalid_args", "view", "{}");
    }

    @Test
    public void view_buildsBrowsableViewIntentsExceptGeo() throws Exception {
        PhoneVerbs.Plan p = plan("view", "{\"candidates\":[\"amapuri://route/plan/?dname=x\",\"https://uri.amap.com/navigation?to=x\",\"geo:0,0?q=Beijing South\"]}");
        assertNull("view tier is decided per candidate at run time", p.tier);
        assertTrue(p.needsForeground());
        assertEquals(3, p.intents.size());
        for (IntentSpec s : p.intents) {
            assertEquals("android.intent.action.VIEW", s.action);
            assertEquals(IntentSpec.FLAG_ACTIVITY_NEW_TASK, s.flags & IntentSpec.FLAG_ACTIVITY_NEW_TASK);
        }
        assertEquals(IntentSpec.CATEGORY_BROWSABLE, p.intents.get(0).category);
        assertEquals(IntentSpec.CATEGORY_BROWSABLE, p.intents.get(1).category);
        assertNull(p.intents.get(2).category);
    }

    @Test
    public void tierForView_onlyAllowlistedBrowsersAndMapsSkipConfirmation() {
        assertEquals(PhoneVerbs.Tier.R1, PhoneVerbs.tierForView("https", list("com.android.chrome")));
        assertEquals(PhoneVerbs.Tier.R1, PhoneVerbs.tierForView("http", list("org.mozilla.firefox")));
        assertEquals(PhoneVerbs.Tier.R1, PhoneVerbs.tierForView("https", list("com.autonavi.minimap")));
        assertEquals(PhoneVerbs.Tier.R1, PhoneVerbs.tierForView("geo", list("com.google.android.apps.maps", "com.baidu.BaiduMap")));
        // https 被某个 App 的 App Links 接走 → 按目标包 R3
        assertEquals(PhoneVerbs.Tier.R3, PhoneVerbs.tierForView("https", list("com.tencent.mm")));
        // 选择器里混进非白名单包 → R3
        assertEquals(PhoneVerbs.Tier.R3, PhoneVerbs.tierForView("https", list("com.android.chrome", "com.evil.app")));
        // 地图自家 scheme 落到地图白名单 = 免确认;落到别的包(同名 scheme 被抢注)或浏览器 = 照旧确认
        assertEquals(PhoneVerbs.Tier.R1, PhoneVerbs.tierForView("amapuri", list("com.autonavi.minimap")));
        assertEquals(PhoneVerbs.Tier.R1, PhoneVerbs.tierForView("baidumap", list("com.baidu.BaiduMap")));
        assertEquals(PhoneVerbs.Tier.R3, PhoneVerbs.tierForView("amapuri", list("com.evil.app")));
        assertEquals(PhoneVerbs.Tier.R3, PhoneVerbs.tierForView("qqmap", list("com.android.chrome")));
        // 其他 App scheme 一律 R3
        assertEquals(PhoneVerbs.Tier.R3, PhoneVerbs.tierForView("weixin", list("com.tencent.mm")));
        assertEquals(PhoneVerbs.Tier.R3, PhoneVerbs.tierForView("https", Collections.<String>emptyList()));
    }

    @Test
    public void targetOf_showsSchemeAndRealHost() {
        assertEquals("https://evil.com", PhoneVerbs.targetOf("https://bank.com@evil.com:8443/pay?x=1"));
        assertEquals("https://example.com", PhoneVerbs.targetOf("HTTPS://Example.COM/a"));
        assertEquals("weixin://dl", PhoneVerbs.targetOf("weixin://dl/business/?t=abc"));
        assertEquals("alipays://platformapi", PhoneVerbs.targetOf("alipays://platformapi/startapp?appId=1"));
        assertEquals("geo:", PhoneVerbs.targetOf("geo:0,0?q=x"));
        assertEquals("https://[::1]", PhoneVerbs.targetOf("https://[::1]:8080/"));
    }

    // ───────── 确认框模板(§4、§6) ─────────

    private static Map<String, String> strings() {
        Map<String, String> s = new HashMap<>();
        for (String k : PhoneVerbs.STRING_KEYS) s.put(k, "x");
        s.put("confirmBody", "Tangu wants to open {app} ({target}).");
        s.put("leaseBody", "For {minutes} minutes Tangu can act."); // T2 键必含 {minutes}(§6)
        return s;
    }

    @Test
    public void checkStrings_requiresAllKeysAndBothPlaceholders() {
        assertNull(PhoneVerbs.checkStrings(strings()));
        Map<String, String> s = strings();
        s.put("confirmBody", "Tangu wants to open {app}.");
        assertNotNull("missing {target}", PhoneVerbs.checkStrings(s));
        s = strings();
        s.put("confirmBody", "Tangu wants to open this link.");
        assertNotNull("missing both", PhoneVerbs.checkStrings(s));
        s = strings();
        s.remove("confirmDeny");
        assertNotNull("missing key", PhoneVerbs.checkStrings(s));
        s = strings();
        s.put("cancel", "  ");
        assertNotNull("blank value", PhoneVerbs.checkStrings(s));
        // T2:leaseBody 缺 {minutes} 必须被拒(时长由原生填,§6)
        s = strings();
        s.put("leaseBody", "For ten minutes Tangu can act.");
        assertNotNull("missing {minutes}", PhoneVerbs.checkStrings(s));
    }

    @Test
    public void fill_insertsNativeFactsWithoutBidiTricks() {
        assertEquals("Open WeChat (weixin://dl)?", PhoneVerbs.fill("Open {app} ({target})?", "WeChat", "weixin://dl"));
        assertEquals("Open Chromemoc.live (x:)?", PhoneVerbs.fill("Open {app} ({target})?", "Chrome‮moc.live", "x:"));
        assertEquals("Open Evil (x:)?", PhoneVerbs.fill("Open {app} ({target})?", "Ev\nil", "x:"));
    }

    // ───────── 其余 op 的规划 ─────────

    @Test
    public void alarm_usesSkipUiAndCalendarDays() throws Exception {
        PhoneVerbs.Plan p = plan("alarm", "{\"hour\":7,\"minute\":5,\"days\":[2,6,2],\"label\":\"Gym\"}");
        assertEquals(PhoneVerbs.Tier.R1, p.tier);
        assertTrue("OEMs may ignore SKIP_UI", p.unverified);
        IntentSpec s = only(p);
        assertEquals("android.intent.action.SET_ALARM", s.action);
        assertEquals(7, s.extras.get("android.intent.extra.alarm.HOUR"));
        assertEquals(5, s.extras.get("android.intent.extra.alarm.MINUTES"));
        assertEquals(new ArrayList<>(Arrays.asList(2, 6)), s.extras.get("android.intent.extra.alarm.DAYS"));
        assertEquals("Gym", s.extras.get("android.intent.extra.alarm.MESSAGE"));
        assertEquals(Boolean.TRUE, s.extras.get("android.intent.extra.alarm.SKIP_UI"));
        assertFalse(only(plan("alarm", "{\"hour\":0,\"minute\":0}")).extras.containsKey("android.intent.extra.alarm.DAYS"));
        assertReject("invalid_args", "alarm", "{\"hour\":24,\"minute\":0}");
        assertReject("invalid_args", "alarm", "{\"hour\":\"7\",\"minute\":0}");
        assertReject("invalid_args", "alarm", "{\"hour\":7.5,\"minute\":0}");
        assertReject("invalid_args", "alarm", "{\"hour\":7}");
        assertReject("invalid_args", "alarm", "{\"hour\":7,\"minute\":0,\"days\":[0]}");
        assertReject("invalid_args", "alarm", "{\"hour\":7,\"minute\":0,\"days\":\"mon\"}");
    }

    @Test
    public void timer_bounds() throws Exception {
        assertEquals(90, only(plan("timer", "{\"seconds\":90}")).extras.get("android.intent.extra.alarm.LENGTH"));
        assertReject("invalid_args", "timer", "{\"seconds\":0}");
        assertReject("invalid_args", "timer", "{\"seconds\":86401}");
    }

    @Test
    public void settings_closedSetOfPages() throws Exception {
        assertEquals("android.settings.WIFI_SETTINGS", only(plan("settings", "{\"page\":\"wifi\"}")).action);
        IntentSpec details = only(plan("settings", "{\"page\":\"app_details\"}"));
        assertEquals("android.settings.APPLICATION_DETAILS_SETTINGS", details.action);
        assertEquals("package:" + OWN, details.data);
        List<IntentSpec> n = plan("settings", "{\"page\":\"notifications\"}").intents;
        assertEquals(3, n.size());
        assertEquals(OWN, n.get(2).extras.get("android.provider.extra.APP_PACKAGE"));
        for (String page : new String[] {"wifi", "bluetooth", "display", "sound", "battery", "location", "notifications",
            "app_details", "date", "language", "accessibility", "main"}) {
            assertFalse(page, plan("settings", "{\"page\":\"" + page + "\"}").intents.isEmpty());
        }
        assertReject("invalid_args", "settings", "{\"page\":\"developer\"}");
    }

    @Test
    public void sendto_onlySmsAndMailDrafts() throws Exception {
        IntentSpec sms = only(plan("sendto", "{\"uri\":\"smsto:+86 138;rm\",\"text\":\"hi\"}"));
        assertEquals("android.intent.action.SENDTO", sms.action);
        assertEquals("smsto:+86138;", sms.data);
        assertEquals("hi", sms.extras.get("sms_body"));
        IntentSpec mail = only(plan("sendto", "{\"uri\":\"mailto:a@b.com?bcc=x@evil.com\",\"subject\":\"S\",\"text\":\"T\"}"));
        assertEquals("mailto:a@b.com", mail.data);
        assertEquals("S", mail.extras.get("android.intent.extra.SUBJECT"));
        assertEquals("T", mail.extras.get("android.intent.extra.TEXT"));
        assertEquals(PhoneVerbs.Tier.R2, plan("sendto", "{\"uri\":\"smsto:\"}").tier);
        assertReject("invalid_args", "sendto", "{\"uri\":\"tel:123\"}");
        assertReject("invalid_args", "sendto", "{\"uri\":\"https://x\"}");
    }

    @Test
    public void send_isPlainTextChooser() throws Exception {
        IntentSpec s = only(plan("send", "{\"text\":\"hello\",\"subject\":\"S\"}"));
        assertEquals("android.intent.action.SEND", s.action);
        assertEquals("text/plain", s.type);
        assertTrue(s.chooser);
        assertEquals("hello", s.extras.get("android.intent.extra.TEXT"));
        assertReject("invalid_args", "send", "{\"text\":\"  \"}");
    }

    @Test
    public void insertEvent_parsesIso8601() throws Exception {
        IntentSpec s = only(plan("insert_event", "{\"title\":\"Dinner\",\"start\":\"2026-09-25T14:30+08:00\",\"end\":\"2026-09-25T15:30:00+08:00\",\"location\":\"Home\"}"));
        assertEquals("android.intent.action.INSERT", s.action);
        assertEquals("content://com.android.calendar/events", s.data);
        assertEquals(1790317800000L, s.extras.get("beginTime"));
        assertEquals(1790317800000L + 3_600_000L, s.extras.get("endTime"));
        assertEquals("Home", s.extras.get("eventLocation"));
        // 引擎放行的其他写法:不带冒号的偏移、Z、毫秒
        assertEquals(1790317800000L, only(plan("insert_event", "{\"title\":\"x\",\"start\":\"2026-09-25T14:30+0800\"}")).extras.get("beginTime"));
        assertEquals(1790317800000L, only(plan("insert_event", "{\"title\":\"x\",\"start\":\"2026-09-25T06:30:00.000Z\"}")).extras.get("beginTime"));
        // 无时区 → 设备时区;纯日期 → 全天
        assertEquals(1790317800000L, only(plan("insert_event", "{\"title\":\"x\",\"start\":\"2026-09-25T14:30\"}")).extras.get("beginTime"));
        IntentSpec allDay = only(plan("insert_event", "{\"title\":\"x\",\"start\":\"2026-09-25\"}"));
        assertEquals(1790265600000L, allDay.extras.get("beginTime"));
        assertEquals(Boolean.TRUE, allDay.extras.get("allDay"));
        assertReject("invalid_args", "insert_event", "{\"title\":\"x\",\"start\":\"tomorrow 3pm\"}");
        assertReject("invalid_args", "insert_event", "{\"title\":\"x\",\"start\":\"2026-09-25T15:00\",\"end\":\"2026-09-25T14:00\"}");
        assertReject("invalid_args", "insert_event", "{\"start\":\"2026-09-25T15:00\"}");
    }

    @Test
    public void directOps_validateClosedSets() throws Exception {
        assertEquals("next", plan("media", "{\"key\":\"next\"}").choice);
        assertEquals("mute", plan("volume", "{\"dir\":\"mute\"}").choice);
        assertTrue(plan("torch", "{\"on\":true}").on);
        assertEquals("copy me", plan("clip", "{\"text\":\"copy me\"}").text);
        assertFalse("works while backgrounded", plan("volume", "{\"dir\":\"up\"}").needsForeground());
        assertReject("invalid_args", "media", "{\"key\":\"stop\"}");
        assertReject("invalid_args", "volume", "{\"dir\":\"max\"}");
        assertReject("invalid_args", "torch", "{\"on\":\"yes\"}");
        assertReject("invalid_args", "clip", "{\"text\":\"\"}");
        assertReject("unsupported", "reboot", "{}");
    }

    @Test
    public void launch_needsValidPkgOrName() throws Exception {
        assertEquals("com.tencent.mm", plan("launch", "{\"pkg\":\"com.tencent.mm\"}").pkg);
        assertEquals("WeChat", plan("launch", "{\"name\":\" WeChat \"}").name);
        assertReject("invalid_args", "launch", "{\"pkg\":\"not a package\"}");
        assertReject("invalid_args", "launch", "{}");
    }

    @Test
    public void matchApps_exactBeatsPartialAndAmbiguityIsReported() {
        List<String[]> apps = Arrays.asList(
            new String[] {"微信", "com.tencent.mm"},
            new String[] {"微信读书", "com.tencent.weread"},
            new String[] {"Google Maps", "com.google.android.apps.maps"},
            new String[] {"Maps.me", "com.mapswithme.maps.pro"},
            new String[] {"微信", "com.tencent.mm"});
        List<String[]> m = PhoneVerbs.matchApps("微信", apps);
        assertEquals(1, m.size());
        assertEquals("com.tencent.mm", m.get(0)[1]);
        assertEquals("com.google.android.apps.maps", PhoneVerbs.matchApps("google maps", apps).get(0)[1]);
        assertEquals(2, PhoneVerbs.matchApps("maps", apps).size());
        assertEquals("com.tencent.weread", PhoneVerbs.matchApps("com.tencent.weread", apps).get(0)[1]);
        assertTrue(PhoneVerbs.matchApps("Alipay", apps).isEmpty());
        List<String[]> many = new ArrayList<>();
        for (int i = 0; i < 10; i++) many.add(new String[] {"Note " + i, "com.n" + i + ".app"});
        String text = PhoneVerbs.describeCandidates(PhoneVerbs.matchApps("note", many));
        assertEquals(9, text.split("\n").length);
        assertTrue(text.startsWith("Note 0 (com.n0.app)"));
        assertTrue(text.endsWith("(+2 more)"));
    }

    @Test
    public void checkApiBase_httpsOrLocalCleartextOnly() {
        assertEquals("https://api.forsion.net/api", PhoneVerbs.checkApiBase("https://api.forsion.net/api/"));
        assertEquals("http://localhost:8787/api", PhoneVerbs.checkApiBase("http://localhost:8787/api"));
        assertEquals("http://10.0.2.2:3001/api", PhoneVerbs.checkApiBase("http://10.0.2.2:3001/api"));
        assertNull(PhoneVerbs.checkApiBase("http://evil.example/api"));
        assertNull(PhoneVerbs.checkApiBase("https://user@evil.example/api"));
        assertNull(PhoneVerbs.checkApiBase("javascript:alert(1)"));
        assertNull(PhoneVerbs.checkApiBase(null));
    }

    // ───────── 期限与主线程(§3.2) ─────────

    @Test
    public void localDeadline_anchorsAtReceiptAndKeepsShortRemaining() {
        // 首次 claim:整段 execMs
        assertEquals(100_000 + 20_000 - PhoneVerbs.DEADLINE_MARGIN_MS, PhoneVerbs.localDeadline(100_000, 20_000));
        // 丢响应后重试:引擎回剩余 3s —— 不许抬到 5s(那会越过引擎的期限)
        assertEquals(100_000 + 3_000 - PhoneVerbs.DEADLINE_MARGIN_MS, PhoneVerbs.localDeadline(100_000, 3_000));
        // 剩余 0 / 负数:期限落在锚点之前 = 不执行
        assertTrue(PhoneVerbs.localDeadline(100_000, 0) < 100_000);
        assertTrue(PhoneVerbs.localDeadline(100_000, -5) < 100_000);
        // 上界仍钳在 120s
        assertEquals(100_000 + 120_000 - PhoneVerbs.DEADLINE_MARGIN_MS, PhoneVerbs.localDeadline(100_000, 999_999));
    }

    @Test
    public void gate_deadlineFirstThenForeground() {
        long deadline = PhoneVerbs.localDeadline(100_000, 20_000);
        // 期限内、在前台 → 放行;不需要前台的(剪贴板 / 系统调用)不看前台
        assertEquals(PhoneVerbs.Gate.GO, PhoneVerbs.gate(deadline, deadline, true, true));
        assertEquals(PhoneVerbs.Gate.GO, PhoneVerbs.gate(deadline - 1, deadline, false, false));
        // 期限内但不在前台(确认之后按了 Home)→ needs_foreground
        assertEquals(PhoneVerbs.Gate.NEEDS_FOREGROUND, PhoneVerbs.gate(deadline - 1, deadline, true, false));
        // 过了期限(commit 慢回来 / 主线程排队):一律 EXPIRED —— 哪怕同时不在前台,也不回 needs_foreground
        assertEquals(PhoneVerbs.Gate.EXPIRED, PhoneVerbs.gate(deadline + 1, deadline, true, true));
        assertEquals(PhoneVerbs.Gate.EXPIRED, PhoneVerbs.gate(deadline + 1, deadline, true, false));
        assertEquals(PhoneVerbs.Gate.EXPIRED, PhoneVerbs.gate(deadline + 1, deadline, false, true));
        // 剩余 0 的重领:锚点那一刻就已过期
        assertEquals(PhoneVerbs.Gate.EXPIRED, PhoneVerbs.gate(100_000, PhoneVerbs.localDeadline(100_000, 0), false, true));
    }

    @Test
    public void seenAcks_rejectsRepeatsAndEvictsOldestPastCapacity() {
        PhoneVerbs.SeenAcks s = new PhoneVerbs.SeenAcks(3);
        assertTrue(s.add("cc_a"));
        assertFalse("a replay is dropped before claim", s.add("cc_a"));
        assertTrue(s.add("cc_b"));
        assertTrue(s.add("cc_c"));
        // 重复查询不刷新顺序(插入序):cc_a 仍是最老的
        assertFalse(s.add("cc_a"));
        assertTrue(s.add("cc_d")); // 挤掉 cc_a
        assertTrue("evicted ids are forgotten", s.add("cc_a"));
        assertFalse(s.add("cc_c"));
        assertFalse(s.add("cc_d"));
    }

    @Test
    public void seenAcks_concurrentReplaysOnlyOneWins() throws Exception {
        // claim 已经多线程:同一条指令被并发转交 N 次,只能有一次通过(查 + 占位必须同一把锁)
        for (int round = 0; round < 50; round++) {
            PhoneVerbs.SeenAcks s = new PhoneVerbs.SeenAcks(256);
            int n = 16;
            CountDownLatch go = new CountDownLatch(1);
            CountDownLatch done = new CountDownLatch(n);
            AtomicInteger wins = new AtomicInteger();
            for (int t = 0; t < n; t++) {
                new Thread(() -> {
                    try {
                        go.await();
                        if (s.add("cc_same")) wins.incrementAndGet();
                    } catch (InterruptedException ignored) {
                        // 不会发生
                    } finally {
                        done.countDown();
                    }
                }).start();
            }
            go.countDown();
            assertTrue(done.await(5, TimeUnit.SECONDS));
            assertEquals("round " + round, 1, wins.get());
        }
    }

    @Test
    public void callBounded_timedOutTaskNeverRunsLate() throws Exception {
        List<Runnable> queued = new ArrayList<>();
        AtomicBoolean ran = new AtomicBoolean(false);
        try {
            PhoneVerbs.callBounded(queued::add, () -> { ran.set(true); return true; }, 50);
            fail("a task the main thread never picked up must time out");
        } catch (TimeoutException expected) {
            // 回执会写 error
        }
        // 主线程卡完了,终于轮到它:已撤掉 → 空操作,不能在「没做成」之后迟到执行
        assertEquals(1, queued.size());
        queued.get(0).run();
        assertFalse(ran.get());
    }

    @Test
    public void callBounded_startedTaskReportsItsRealResult() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        // 超时那一刻任务已经在跑(副作用已发生)→ 等它跑完拿真实结果,不报失败。
        // execute 等到任务真的开跑才返回,确定性地落在「超时时已开跑」这一支。
        String r = PhoneVerbs.callBounded(task -> {
            new Thread(task).start();
            try {
                started.await();
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
        }, () -> {
            started.countDown();
            Thread.sleep(300);
            return "done";
        }, 50);
        assertEquals("done", r);
    }

    @Test
    public void callBounded_unwrapsTaskExceptions() {
        try {
            PhoneVerbs.callBounded(Runnable::run, () -> { throw new IllegalStateException("boom"); }, 1000);
            fail("expected the task's own exception");
        } catch (IllegalStateException expected) {
            assertEquals("boom", expected.getMessage());
        } catch (Exception e) {
            fail("unexpected " + e);
        }
    }

    /** §9.2 后台委托(09-26 评审):早筛曾对全部 ACTIVITY_OPS 一律回 needs_foreground,委托成了死代码。 */
    @Test
    public void backgroundDelegationGate() {
        // 伴随包就绪:后台的 launch / view 放行(交给伴随包启动)
        assertFalse(PhoneVerbs.mustBeForeground("launch", false, true));
        assertFalse(PhoneVerbs.mustBeForeground("view", false, true));
        // 伴随包不就绪:老行为
        assertTrue(PhoneVerbs.mustBeForeground("launch", false, false));
        assertTrue(PhoneVerbs.mustBeForeground("view", false, false));
        // startFirst 类从不委托
        for (String op : new String[] {"settings", "dial", "sendto", "send", "insert_event", "alarm", "timer"}) {
            assertTrue(op, PhoneVerbs.mustBeForeground(op, false, true));
        }
        // 前台、或不启动 Activity 的 op:不拦
        assertFalse(PhoneVerbs.mustBeForeground("launch", true, false));
        assertFalse(PhoneVerbs.mustBeForeground("volume", false, false));
        assertFalse(PhoneVerbs.mustBeForeground("observe", false, false));
    }

    // ───────── 工具 ─────────

    private static PhoneVerbs.Plan plan(String op, String args) throws Exception {
        return PhoneVerbs.plan(op, new JSONObject(args), OWN, SH);
    }

    // ───────────── T2 租约:账号键 + 欠着的 cancelAll(09-26 二轮评审 P1 #5)─────────────

    @Test
    public void leaseKey_isStableHexAndNeverTheToken() {
        String t1 = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InVfMSJ9.sig1";
        String k1 = PhoneVerbs.leaseKey(t1);
        assertNotNull(k1);
        assertTrue(k1.matches("^[0-9a-f]{32}$")); // 伴随包 HandsVerbs.acct 只收这个格式
        assertEquals(k1, PhoneVerbs.leaseKey(t1));
        assertFalse(k1.equals(PhoneVerbs.leaseKey(t1 + "x")));   // 换号 / 换 token → 换键 → 伴随包重新弹同意
        assertFalse(k1.contains("eyJ"));
        assertFalse(PhoneVerbs.sha256Hex(t1).startsWith(k1));    // 域分离:不是裸 sha256(token)
        assertNull(PhoneVerbs.leaseKey(null));
        assertNull(PhoneVerbs.leaseKey(""));
    }

    @Test
    public void pendingCancel_owedWhileUnboundIsSentBeforeAnythingElse() {
        PhoneVerbs.PendingCancel pc = new PhoneVerbs.PendingCancel();
        AtomicInteger sent = new AtomicInteger();
        assertTrue(pc.settle(() -> { sent.incrementAndGet(); return true; })); // 不欠:不发
        assertEquals(0, sent.get());
        pc.owe();                                  // 换号时没绑着:原来直接 return,这发撤销就丢了
        assertTrue(pc.owed());
        assertFalse(pc.settle(() -> false));       // 绑上了但发失败:仍欠着,调用方不许转交指令
        assertTrue(pc.owed());
        assertTrue(pc.settle(() -> { sent.incrementAndGet(); return true; }));
        assertEquals(1, sent.get());
        assertFalse(pc.owed());
        assertTrue(pc.settle(() -> { sent.incrementAndGet(); return true; })); // 还清后不再重发
        assertEquals(1, sent.get());
    }

    private static IntentSpec only(PhoneVerbs.Plan p) {
        assertEquals(1, p.intents.size());
        return p.intents.get(0);
    }

    private static void assertReject(String code, String op, String args) {
        try {
            PhoneVerbs.Plan p = plan(op, args);
            fail(op + " " + args + " should be rejected with " + code + ", got " + p.intents);
        } catch (PhoneVerbs.Reject r) {
            assertEquals(op + " " + args + ": " + r.getMessage(), code, r.code);
        } catch (Exception e) {
            fail(op + " " + args + ": unexpected " + e);
        }
    }

    private static List<String> list(String... pkgs) {
        return Arrays.asList(pkgs);
    }
}
