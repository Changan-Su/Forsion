package com.forsion.tangu;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Map;

/**
 * 调用方票(caller token)的内存缓存与换发(P1-K8;契约以 K1 为准,INTEGRATION R-02 / R-03)。纯逻辑,JVM 单测 CallerTokensTest。
 *
 * 换票:POST {apiBase}/units/{本机 id}/caller-token,头 Authorization + X-Unit-Caller-Secret,无 body
 *       → 200 {unitId, token, expiresAt(epoch 秒,TTL 600)};404 UNIT_NOT_FOUND;403 UNIT_CALLER_SECRET_MISMATCH(从不 401)。
 * - 票不绑目标设备 → 缓存键固定 `*`(R-02);但**按账号 + 本机 id 绑**:换号后绝不拿 A 的票去发 B 的请求(S7)。
 * - 到期前 60s 视为过期、单飞刷新。剩余有效期按**服务器时钟**算(expiresAt − 响应 Date 头),锚在 elapsedRealtime 上:
 *   手机时钟快了十几分钟也不会每个请求都重新换票(那会撞 /caller-token 的 IP 限流)。
 * - 自愈:403 UNIT_CALLER_SECRET_MISMATCH → 轮换 caller secret 一次再换;404 UNIT_NOT_FOUND → 重新登记(10 分钟一次)再换;
 *   404 且**无 code**(老 server 没这条路由,回的可能是 HTML)→ caller_unsupported。
 * - 失败归类(UnitError.relayCode,评审 P1):断网 / 5xx / 429 → network(渲染层当离线,恢复后重试);401 → auth_expired
 *   (forsion_token 失效,渲染层复检账号 / 重新登录);只有明确的拒绝(自愈后仍 403/404、重登节流、没登录、存不下、本机刚被移除)
 *   才是 caller_unavailable —— K6 的健康状态机把它当终局,一次断网不能落到这里。
 * - 票与 secret 永不出这个类以外的原生边界:UnitRelay 拿去写头,不回 JS、不进日志。
 */
final class CallerTokens {
    static final String CACHE_KEY = "*";
    static final long REFRESH_MARGIN_MS = 60_000L;
    /** 缓存上限:K1 的 TTL 是 600s,服务器回更长也不信(防时钟 / 解析错把一张票缓存成永久)。 */
    static final long MAX_TTL_MS = 600_000L;

    private final UnitRegistrar registrar;
    private final UnitHttp http;
    private final UnitRegistrar.Clock clock;
    private final UnitRegistrar.Log log;

    private String cachedFor;
    private String token;
    private long refreshAt;

    CallerTokens(UnitRegistrar registrar, UnitHttp http, UnitRegistrar.Clock clock, UnitRegistrar.Log log) {
        this.registrar = registrar;
        this.http = http;
        this.clock = clock;
        this.log = log;
    }

    /** 取一张可用的票;force = 丢掉缓存重换(中继收到 403 UNIT_CALLER_INVALID / EXPIRED 时,R-04)。 */
    synchronized String get(boolean force) throws UnitError {
        UnitRegistrar.Account a;
        UnitRegistrar.Ensured e;
        try {
            a = registrar.account();
            e = registrar.ensureLazy();
        } catch (UnitError err) {
            throw err.forRelay();
        }
        String key = a.entryKey + "|" + e.identity.unitId + "|" + CACHE_KEY;
        if (!force && token != null && key.equals(cachedFor) && clock.elapsedMs() < refreshAt) return token;
        invalidate();
        return mint(a, e.identity, false);
    }

    synchronized void invalidate() {
        token = null;
        cachedFor = null;
        refreshAt = 0;
    }

    private String mint(UnitRegistrar.Account a, UnitIdentity id, boolean healed) throws UnitError {
        Map<String, String> h = UnitRegistrar.auth(a);
        h.put("X-Unit-Caller-Secret", id.callerSecret);
        UnitHttp.Resp r;
        long sentAt = clock.elapsedMs();
        try {
            r = http.send("POST", a.apiBase + "/units/" + UnitRegistrar.enc(id.unitId) + "/caller-token", h, null);
        } catch (IOException err) {
            log.w("[unit] caller-token network error: " + err.getClass().getSimpleName());
            throw new UnitError(UnitError.NETWORK, "caller-token: network error");
        }
        String code = r.code();
        if (r.status == 200) {
            JSONObject o = r.json();
            String t = o == null ? "" : o.optString("token", "");
            long expSec = o == null ? 0 : o.optLong("expiresAt", 0);
            if (t.isEmpty() || expSec <= 0) throw new UnitError(UnitError.CALLER_UNAVAILABLE, "caller-token: bad response");
            long serverNow = r.dateMs > 0 ? r.dateMs : clock.wallMs();
            long ttl = Math.max(0, Math.min(MAX_TTL_MS, expSec * 1000L - serverNow));
            // 锚在发出时刻(保守):响应在路上耗的时间从有效期里扣掉。
            refreshAt = sentAt + ttl - REFRESH_MARGIN_MS;
            token = t;
            cachedFor = a.entryKey + "|" + id.unitId + "|" + CACHE_KEY;
            return t;
        }
        log.w("[unit] caller-token → " + r.status + (code != null ? " " + code : ""));
        if (!healed && r.status == 403 && "UNIT_CALLER_SECRET_MISMATCH".equals(code)) {
            return mint(a, heal(() -> registrar.rotateCallerSecret(a, id)), true);
        }
        if (!healed && r.status == 404 && "UNIT_NOT_FOUND".equals(code)) {
            return mint(a, heal(() -> registrar.reRegister(a, id, false)), true);
        }
        if (r.status == 404 && code == null) throw new UnitError(UnitError.CALLER_UNSUPPORTED, "caller-token route missing");
        // 401 → auth_expired;5xx / 429 → network;其余(自愈后仍 403 / 404、400 UNIT_KIND_INVALID…)→ caller_unavailable。
        throw UnitError.server("caller-token", r.status).forRelay();
    }

    private interface Heal {
        UnitIdentity run() throws UnitError;
    }

    /**
     * 自愈失败按同一口径归类:轮换 / 重新登记途中断网或 5xx 仍是 network(等网络回来再试,不是终局);
     * 被 10 分钟节流、本机刚被移除、再 403 → caller_unavailable。不管哪种,中继都失败关闭(不发匿名请求)。
     */
    private static UnitIdentity heal(Heal h) throws UnitError {
        try {
            return h.run();
        } catch (UnitError e) {
            throw e.forRelay();
        }
    }
}
