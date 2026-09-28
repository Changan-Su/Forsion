package com.forsion.tangu;

/**
 * 身份面 / 中继的失败(P1-K8)。code 是给 JS 的稳定串:
 *   not_signed_in · no_api_base · network · server_<status> · storage —— ensureRegistered 的 reject code(K8 §3.3);
 *   caller_unsupported —— 服务器 / 构建不支持(老 server 没有调用方凭据路由);
 *   caller_unavailable —— 明确拿不到调用方身份(自愈后仍 403/404、10 分钟重登节流、没登录、存不下、本机刚被移除)。
 * message 只写阶段与状态码,**绝不带 token / secret / 响应体**(会进 logcat 与 JS)。
 *
 * 中继边界的归类({@link #relayCode}):短暂失败(断网、5xx、429)→ `network`,渲染层当离线暂停重试;
 * 401 → `auth_expired`,JS 合成 401 让渲染层走「复检账号 / 重新登录」;只有明确的拒绝才是终局的 `caller_unavailable`。
 * (评审 P1:原先一律折成 caller_unavailable,K6 的健康状态机把它当终局 → 一次断网永久杀掉目标与 run 流。)
 */
final class UnitError extends Exception {
    static final String NETWORK = "network";
    static final String AUTH_EXPIRED = "auth_expired";
    static final String CALLER_UNAVAILABLE = "caller_unavailable";
    static final String CALLER_UNSUPPORTED = "caller_unsupported";

    final String code;

    UnitError(String code, String message) {
        super(message);
        this.code = code;
    }

    static UnitError server(String phase, int status) {
        return new UnitError("server_" + status, phase + " → " + status);
    }

    /** 短暂失败:等网络 / 服务器恢复就会好(断网、网关 5xx、限流)。 */
    boolean isTransient() {
        if (NETWORK.equals(code) || "server_429".equals(code)) return true;
        return code != null && code.length() == 10 && code.startsWith("server_5");
    }

    /** forsion_token 被服务器拒了(过期 / 吊销):不是这台手机的身份问题,是账号登录态。 */
    boolean isAuthExpired() {
        return AUTH_EXPIRED.equals(code) || "server_401".equals(code);
    }

    /** 中继要交给 JS 的错误码:network / auth_expired / caller_unsupported / caller_unavailable 四选一。 */
    String relayCode() {
        if (isTransient()) return NETWORK;
        if (isAuthExpired()) return AUTH_EXPIRED;
        if (CALLER_UNSUPPORTED.equals(code)) return CALLER_UNSUPPORTED;
        return CALLER_UNAVAILABLE;
    }

    /** 同一个失败,换成中继口径的 code(message 保留阶段信息)。 */
    UnitError forRelay() {
        String rc = relayCode();
        return rc.equals(code) ? this : new UnitError(rc, getMessage());
    }
}
