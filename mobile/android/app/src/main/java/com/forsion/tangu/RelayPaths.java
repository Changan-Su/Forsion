package com.forsion.tangu;

import java.util.regex.Pattern;

/**
 * 原生中继的路径闸(P1-K8,INTEGRATION R-06)—— 纯函数,JVM 单测(RelayPathsTest)。
 *
 * 中继只往 `{apiBase}/units/{unitId}/proxy{path}` 发,且只放这几种 path(`/proxy` 之后):
 *   /engine · /engine/… · /engine?… · /unit/remote-access · /unit/remote-access/request
 * `/unit/mcp*` 永不经中继(方案 §6.2-7)。unitId 必须是小写 uuid。
 *
 * ⚠️ 与 JS 侧 mobile/src/relayPaths.ts 的 checkRelayPath 逐条对应,两侧共用用例表
 *    app/src/test/resources/relay-paths.json。改一边必须改另一边。
 *
 * 另有 apiBase 闸(checkApiBase):forsion-native.json 里的地址只认 https;http 只认本机回环 / 模拟器宿主(debug 台架)。
 */
final class RelayPaths {
    private RelayPaths() {}

    static final int MAX_PATH = 8192;
    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    /** RFC 3986 pchar ∪ `/` `?`;不含 `#`、`\`、空白、控制符、非 ASCII。 */
    private static final Pattern ALLOWED = Pattern.compile("^[A-Za-z0-9._~!$&'()*+,;=:@/%?-]*$");
    private static final Pattern BAD_PERCENT = Pattern.compile("%(?![0-9A-Fa-f]{2})");
    /** 路径段里不许的编码:斜杠、反斜杠、控制符。 */
    private static final Pattern BAD_ENCODED = Pattern.compile("(?i)%(2f|5c|0[0-9a-f]|1[0-9a-f]|7f)");

    static boolean isUnitId(String unitId) {
        return unitId != null && UUID.matcher(unitId).matches();
    }

    /** 整条闸:unitId 小写 uuid + path 合法。 */
    static boolean check(String unitId, String path) {
        return isUnitId(unitId) && checkPath(path);
    }

    static boolean checkPath(String path) {
        if (path == null || !path.startsWith("/") || path.length() > MAX_PATH) return false;
        if (!ALLOWED.matcher(path).matches()) return false;
        if (BAD_PERCENT.matcher(path).find()) return false;
        int q = path.indexOf('?');
        String pathPart = q < 0 ? path : path.substring(0, q);
        boolean hasQuery = q >= 0;
        if (BAD_ENCODED.matcher(pathPart).find()) return false;
        boolean engine = pathPart.equals("/engine") || pathPart.startsWith("/engine/");
        boolean remote = pathPart.equals("/unit/remote-access") || pathPart.equals("/unit/remote-access/request");
        if (!engine && !remote) return false;
        if (remote && hasQuery) return false;
        String[] segs = pathPart.substring(1).split("/", -1);
        for (int i = 0; i < segs.length; i++) {
            String seg = segs[i];
            if (seg.isEmpty() && i != segs.length - 1) return false;
            String dots = seg.replaceAll("(?i)%2e", ".");
            if (dots.equals(".") || dots.equals("..")) return false;
        }
        return true;
    }

    /**
     * forsion-native.json 里的 apiBase:https 任意主机;http 只认 localhost / 127.0.0.1 / 10.0.2.2(debug 台架,
     * 与 src/debug 的 network_security_config 同一口径)。不合格 → null(原生什么都不发)。
     * 同 origin/feat/phone-control-t2 的 PhoneVerbs.checkApiBase(T1 先合则删这一份,改调它)。
     */
    static String checkApiBase(String s) {
        if (s == null) return null;
        s = s.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (!s.matches("^https?://[^\\s/?#@]+(/[^\\s?#]*)?$")) return null;
        if (s.startsWith("http://")) {
            String rest = s.substring("http://".length());
            int slash = rest.indexOf('/');
            String hostPort = slash < 0 ? rest : rest.substring(0, slash);
            int colon = hostPort.lastIndexOf(':');
            String host = colon < 0 ? hostPort : hostPort.substring(0, colon);
            if (!host.equals("localhost") && !host.equals("127.0.0.1") && !host.equals("10.0.2.2")) return null;
        }
        return s;
    }
}
