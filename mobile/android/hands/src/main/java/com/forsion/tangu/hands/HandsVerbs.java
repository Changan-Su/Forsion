package com.forsion.tangu.hands;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 伴随包侧的**纯逻辑**半身(手机操控 T2):解析主包 exec 转来的 JSON、校验 op / 参数、校验 configure 文案。
 * 刻意不 import android.*(org.json 在测试里由 testImplementation 提供真实现),于是可 JUnit(HandsVerbsTest)。
 * 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §9.2、§9.5、§6。
 *
 * ⚠️ 伴随包只接受主包 claim 成功后转来的指令,但仍**不信任字段本身**:op / 参数一律在这里再校验一遍(§9.1)。
 */
final class HandsVerbs {
    private HandsVerbs() {}

    static final int PROTO = 1;

    /** 变更类(需策略 + settle + 新 observation)。 */
    static final Set<String> MUTATE_OPS = set("tap", "type", "scroll", "key");
    /** 全部 T2 op。 */
    static final Set<String> OPS = set("observe", "tap", "type", "scroll", "key");
    static final Set<String> SCROLL_DIRS = set("up", "down", "left", "right");
    static final Set<String> KEYS = set("back", "home", "recents", "notifications");

    static final int MAX_TEXT = 20_000; // type 文本上限(引擎侧文本上限更大,这里够用且不塞爆 binder)

    /** configure 下发的 T2 文案键(§6)。伴随包除无障碍 label/description 外没有用户可见字面量。 */
    static final List<String> STRING_KEYS = Collections.unmodifiableList(Arrays.asList(
        "leaseTitle", "leaseBody", "leaseAllow", "leaseDeny", "pillLabel", "pillStop"));

    /** 解析后的 exec 指令。stage 决定走租约还是执行;start 是 T1 launch/view 的后台委托(§9.2)。 */
    static final class Cmd {
        final String stage;   // "lease" | "run" | "start"
        final String op;      // T2 op(start 时为 null)
        final JSONObject args;
        final long deadline;  // SystemClock.elapsedRealtime() 口径,两进程共享
        final String intentUri; // start:主包序列化的 Intent.toUri(URI_INTENT_SCHEME)
        final String pkg;       // start:目标包名(可空)
        final String app;       // start:目标 App 显示名(可空)
        /**
         * 账号键(lease / run):主包按当前登录 token 算的摘要(PhoneVerbs.leaseKey),伴随包永不见 token 本身。
         * 租约认它:换了账号的第一条 T2 op 一定重新弹同意(09-26 评审 P1)。缺失 / 格式不对 → null(lease / run 一律拒)。
         */
        final String acct;

        Cmd(String stage, String op, JSONObject args, long deadline, String intentUri, String pkg, String app, String acct) {
            this.stage = stage;
            this.op = op;
            this.args = args == null ? new JSONObject() : args;
            this.deadline = deadline;
            this.intentUri = intentUri;
            this.pkg = pkg;
            this.app = app;
            this.acct = acct;
        }
    }

    /** 账号键格式:32–64 位小写十六进制(sha256 截断)。 */
    private static final java.util.regex.Pattern ACCT = java.util.regex.Pattern.compile("^[0-9a-f]{32,64}$");

    static String acct(String s) {
        return s != null && ACCT.matcher(s).matches() ? s : null;
    }

    /** 解析失败返回 null(调用方回 error);字段问题不在这里判(交给各 op 执行时回具体码)。 */
    static Cmd parse(String json) {
        if (json == null) return null;
        try {
            JSONObject o = new JSONObject(json);
            String stage = o.optString("stage", "");
            if (!"lease".equals(stage) && !"run".equals(stage) && !"start".equals(stage)) return null;
            String op = o.has("op") && !o.isNull("op") ? o.optString("op", null) : null;
            Object a = o.opt("args");
            JSONObject args = a instanceof JSONObject ? (JSONObject) a : new JSONObject();
            long deadline = o.optLong("deadline", 0L);
            String intentUri = o.has("intent") && !o.isNull("intent") ? o.optString("intent", null) : null;
            String pkg = o.has("pkg") && !o.isNull("pkg") ? o.optString("pkg", null) : null;
            String app = o.has("app") && !o.isNull("app") ? o.optString("app", null) : null;
            String acct = o.has("acct") && !o.isNull("acct") ? acct(o.optString("acct", null)) : null;
            return new Cmd(stage, op, args, deadline, intentUri, pkg, app, acct);
        } catch (JSONException e) {
            return null;
        }
    }

    /**
     * 校验 configure 文案(§6):六个键齐全、非空、≤2000;leaseBody 必须含 {minutes}(时长由原生填,缺占位符拒收)。
     * 合格 → null;否则返回英文原因(仅进日志)。
     */
    static String checkStrings(Map<String, String> s) {
        for (String k : STRING_KEYS) {
            String v = s.get(k);
            if (v == null || v.trim().isEmpty()) return "missing string: " + k;
            if (v.length() > 2000) return "string too long: " + k;
        }
        if (!s.get("leaseBody").contains("{minutes}")) return "leaseBody must contain {minutes}";
        return null;
    }

    static String fillMinutes(String template, int minutes) {
        return template == null ? "" : template.replace("{minutes}", String.valueOf(minutes));
    }

    // ── 参数取值(执行时用;越界 / 类型错返回 null / 默认,由调用方决定回 invalid_args 还是兜底) ──

    /** 句柄索引(1 起);缺省 / 非法 → 0。 */
    static int handle(JSONObject a) {
        Object v = a.opt("node");
        if (v instanceof Integer || v instanceof Long) {
            long n = ((Number) v).longValue();
            return n >= 1 && n <= TreeSerializer.MAX_NODES ? (int) n : -1;
        }
        return 0;
    }

    /** obs 序号;缺省 → -1(表示「按当前 obs」)。 */
    static int obs(JSONObject a) {
        Object v = a.opt("obs");
        if (v instanceof Integer || v instanceof Long) return (int) ((Number) v).longValue();
        return -1;
    }

    static Integer intOrNull(JSONObject a, String key) {
        Object v = a.opt(key);
        if (v instanceof Integer || v instanceof Long) return (int) ((Number) v).longValue();
        return null;
    }

    static boolean boolArg(JSONObject a, String key) {
        return a.optBoolean(key, false);
    }

    static String scrollDir(JSONObject a) {
        String d = a.optString("direction", "");
        return SCROLL_DIRS.contains(d) ? d : null;
    }

    static String key(JSONObject a) {
        String k = a.optString("key", "");
        return KEYS.contains(k) ? k : null;
    }

    static String text(JSONObject a) {
        Object v = a.opt("text");
        if (!(v instanceof String)) return null;
        String s = (String) v;
        return s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) : s;
    }

    @SafeVarargs
    private static <T> Set<T> set(T... xs) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(xs)));
    }

    /** 供 Actions 用:归一化(去空白、小写)。 */
    static String norm(String s) {
        return s == null ? "" : s.trim().toLowerCase(Locale.ROOT);
    }
}
