package com.forsion.tangu;

import org.json.JSONObject;

import java.io.IOException;
import java.net.URLEncoder;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 把本机登记为 Unit(kind='phone')并保管它的两把凭据(P1-K8,规格 K8 §3.2;server 契约 = unit-hub 的 routes/user.ts,K1)。
 * 纯逻辑:网络、存储、环境、时钟都注入(JVM 单测 RegistrarFlowTest / CallerTokensTest)。所有公开方法同步(单飞)。
 *
 * 登记(懒:首次选电脑 / 首个中继请求时才做,不在登录时做 —— 不给不用这功能的人的名册添行):
 *   1. POST {apiBase}/units/register            Authorization          body {name, platform:'android', kind:'phone'} → {unitId, secret}
 *   2. POST {apiBase}/units/{id}/caller-secret  Authorization + X-Unit-Secret                                       → {callerSecret}
 *      失败则尽力 DELETE /units/{id} 回收半截行,不存半截条目;
 *   3. Keystore 包裹落盘。
 *
 * 自愈(INTEGRATION R-03,以 K8 为准):
 *   - 换票 403 UNIT_CALLER_SECRET_MISMATCH → 用设备密钥轮换一次 caller secret(保住 unit id:各电脑对这台手机的信任都挂在 id 上);
 *   - 只有换票 404 UNIT_NOT_FOUND(本机那行被人在名册里删了)或轮换时 403 UNIT_SECRET_MISMATCH / 404 才重新登记,
 *     且 10 分钟内最多一次(防刷行)。
 */
final class UnitRegistrar {
    interface Env {
        /** 构建期烤死的 API 基址(NativeConfig.apiBase);null = 不可用。 */
        String apiBase();

        /** forsion_token,每次现读(NativeConfig.token);登出后在途操作自然失败。 */
        String forsionToken();

        /** 设备显示名(只作显示,不作信任)。 */
        String deviceName();
    }

    interface Clock {
        long elapsedMs();

        long wallMs();
    }

    interface Log {
        void w(String msg);
    }

    /** 当前账号:apiBase + token + 条目键。 */
    static final class Account {
        final String apiBase;
        final String token;
        final String entryKey;

        Account(String apiBase, String token, String entryKey) {
            this.apiBase = apiBase;
            this.token = token;
            this.entryKey = entryKey;
        }
    }

    static final class Ensured {
        final UnitIdentity identity;
        final boolean created;

        Ensured(UnitIdentity identity, boolean created) {
            this.identity = identity;
            this.created = created;
        }
    }

    static final long REREGISTER_MIN_MS = 10 * 60_000L;
    static final int NAME_MAX = 120;

    private final Env env;
    private final UnitHttp http;
    private final UnitStore store;
    private final Clock clock;
    private final Log log;
    private boolean reRegistered;
    private long lastReRegisterAt;

    UnitRegistrar(Env env, UnitHttp http, UnitStore store, Clock clock, Log log) {
        this.env = env;
        this.http = http;
        this.store = store;
        this.clock = clock;
        this.log = log;
    }

    /** 当前账号;没登录 / token 不是 JWT → not_signed_in;没有 apiBase → no_api_base。 */
    synchronized Account account() throws UnitError {
        String apiBase = RelayPaths.checkApiBase(env.apiBase());
        if (apiBase == null) throw new UnitError("no_api_base", "no usable apiBase");
        String token = env.forsionToken();
        String userId = UnitIdentity.userIdFromJwt(token);
        if (token == null || userId == null) throw new UnitError("not_signed_in", "not signed in");
        return new Account(apiBase, token, UnitIdentity.entryKey(apiBase, userId));
    }

    /** 只读本地(无网络):当前账号的条目;没登录 / 没登记 / 解不开 → null。 */
    synchronized UnitIdentity current() {
        try {
            return load(account());
        } catch (UnitError e) {
            return null;
        }
    }

    synchronized Ensured ensure() throws UnitError {
        Account a = account();
        UnitIdentity id = load(a);
        if (id != null) return new Ensured(id, false);
        return new Ensured(register(a), true);
    }

    /** 删本地条目;remote 时尽力 DELETE /units/:id(失败只记日志)。 */
    synchronized void forget(boolean remote) {
        Account a;
        try {
            a = account();
        } catch (UnitError e) {
            return;
        }
        UnitIdentity id = load(a);
        store.remove(a.entryKey);
        if (remote && id != null) deleteRow(a, id.unitId);
    }

    /**
     * 换票遇 UNIT_CALLER_SECRET_MISMATCH:用设备密钥轮换一次 caller secret 并落盘。
     * 轮换 403 UNIT_SECRET_MISMATCH(本地设备密钥坏了)→ 删掉那行重新登记;404 UNIT_NOT_FOUND → 重新登记;其余 → caller_unavailable。
     */
    synchronized UnitIdentity rotateCallerSecret(Account a, UnitIdentity id) throws UnitError {
        Map<String, String> h = auth(a);
        h.put("X-Unit-Secret", id.deviceSecret);
        UnitHttp.Resp r = call("POST", a.apiBase + "/units/" + enc(id.unitId) + "/caller-secret", h, null, "rotate");
        if (r.status == 200) {
            JSONObject o = r.json();
            String next = o == null ? "" : o.optString("callerSecret", "");
            if (next.isEmpty()) throw new UnitError("caller_unavailable", "rotate: bad response");
            UnitIdentity rotated = id.withCallerSecret(next);
            persist(a, rotated);
            return rotated;
        }
        String code = r.code();
        if (r.status == 403 && "UNIT_SECRET_MISMATCH".equals(code)) return reRegister(a, id, true);
        if (r.status == 404 && "UNIT_NOT_FOUND".equals(code)) return reRegister(a, id, false);
        throw new UnitError("caller_unavailable", "rotate → " + r.status);
    }

    /** 重新登记(10 分钟内最多一次)。deleteStale:那行还在但本机凭据对不上 → 顺手删掉,别在名册里留一台永远离线的手机。 */
    synchronized UnitIdentity reRegister(Account a, UnitIdentity stale, boolean deleteStale) throws UnitError {
        long now = clock.elapsedMs();
        if (reRegistered && now - lastReRegisterAt < REREGISTER_MIN_MS) {
            throw new UnitError("caller_unavailable", "re-registration throttled");
        }
        reRegistered = true;
        lastReRegisterAt = now;
        log.w("[unit] re-registering this phone");
        store.remove(a.entryKey);
        if (deleteStale && stale != null) deleteRow(a, stale.unitId);
        return register(a);
    }

    // ── 内部 ──

    private UnitIdentity load(Account a) {
        String plain;
        try {
            plain = store.get(a.entryKey);
        } catch (Exception e) {
            // 解不开:备份恢复到新机 / OEM 丢钥 / 被挪到别的账号键 → 视为未登记,删掉等下次按需重新登记。
            log.w("[unit] identity entry unreadable (" + e.getClass().getSimpleName() + "); dropping it");
            store.remove(a.entryKey);
            return null;
        }
        if (plain == null) return null;
        UnitIdentity id = UnitIdentity.fromJson(plain);
        if (id == null) {
            log.w("[unit] identity entry malformed; dropping it");
            store.remove(a.entryKey);
        }
        return id;
    }

    private UnitIdentity register(Account a) throws UnitError {
        String name = env.deviceName();
        if (name == null || name.trim().isEmpty()) name = "Android";
        name = name.trim();
        if (name.length() > NAME_MAX) name = name.substring(0, NAME_MAX);
        JSONObject body = new JSONObject();
        try {
            body.put("name", name);
            body.put("platform", "android");
            body.put("kind", "phone");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        Map<String, String> h = auth(a);
        h.put("Content-Type", "application/json; charset=utf-8");
        UnitHttp.Resp r = call("POST", a.apiBase + "/units/register", h, body.toString(), "register");
        if (r.status != 200) throw UnitError.server("register", r.status);
        JSONObject o = r.json();
        String unitId = o == null ? "" : o.optString("unitId", "").toLowerCase(Locale.ROOT);
        String secret = o == null ? "" : o.optString("secret", "");
        if (!RelayPaths.isUnitId(unitId) || secret.isEmpty()) throw UnitError.server("register", 200);

        Map<String, String> h2 = auth(a);
        h2.put("X-Unit-Secret", secret);
        UnitHttp.Resp r2;
        try {
            r2 = call("POST", a.apiBase + "/units/" + enc(unitId) + "/caller-secret", h2, null, "caller-secret");
        } catch (UnitError e) {
            deleteRow(a, unitId);
            throw e;
        }
        JSONObject o2 = r2.status == 200 ? r2.json() : null;
        String callerSecret = o2 == null ? "" : o2.optString("callerSecret", "");
        if (callerSecret.isEmpty()) {
            deleteRow(a, unitId);
            throw UnitError.server("caller-secret", r2.status);
        }
        UnitIdentity id = new UnitIdentity(unitId, secret, callerSecret, name, clock.wallMs());
        try {
            persist(a, id);
        } catch (UnitError e) {
            deleteRow(a, unitId); // 存不下 = 这行永远用不上,别留在名册里
            throw e;
        }
        return id;
    }

    private void persist(Account a, UnitIdentity id) throws UnitError {
        try {
            store.put(a.entryKey, id.toJson());
        } catch (Exception e) {
            throw new UnitError("storage", "cannot persist identity (" + e.getClass().getSimpleName() + ")");
        }
    }

    private void deleteRow(Account a, String unitId) {
        try {
            UnitHttp.Resp r = http.send("DELETE", a.apiBase + "/units/" + enc(unitId), auth(a), null);
            if (r.status != 200 && r.status != 404) log.w("[unit] delete row → " + r.status);
        } catch (IOException e) {
            log.w("[unit] delete row failed: " + e.getClass().getSimpleName());
        }
    }

    private UnitHttp.Resp call(String method, String url, Map<String, String> h, String body, String phase) throws UnitError {
        try {
            return http.send(method, url, h, body);
        } catch (IOException e) {
            log.w("[unit] " + phase + " network error: " + e.getClass().getSimpleName());
            throw new UnitError("network", phase + ": network error");
        }
    }

    static Map<String, String> auth(Account a) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Authorization", "Bearer " + a.token);
        h.put("Accept", "application/json");
        return h;
    }

    static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
