package com.forsion.tangu;

/**
 * 身份面 / 中继的失败(P1-K8)。code 是给 JS 的稳定串:
 *   not_signed_in · no_api_base · network · server_<status> · storage —— ensureRegistered 的 reject code(K8 §3.3);
 *   caller_unavailable · caller_unsupported —— 换不到调用方票(中继据此失败关闭,合成 503 CALLER_*)。
 * message 只写阶段与状态码,**绝不带 token / secret / 响应体**(会进 logcat 与 JS)。
 */
final class UnitError extends Exception {
    final String code;

    UnitError(String code, String message) {
        super(message);
        this.code = code;
    }

    static UnitError server(String phase, int status) {
        return new UnitError("server_" + status, phase + " → " + status);
    }
}
