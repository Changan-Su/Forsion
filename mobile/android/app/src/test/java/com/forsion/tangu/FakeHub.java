package com.forsion.tangu;

import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 假 unit-hub(只含身份面):按 server microserver/unit-hub/routes/user.ts(K1 分支)的口径回 register / caller-secret /
 * caller-token / DELETE。只存 hash(同 server),所以「本机凭据对不对」真的由比对决定,不是脚本化的回包。
 */
final class FakeHub implements UnitHttp {
    static final String API = "https://api.forsion.net/api";

    static final class Call {
        final String method;
        final String url;
        final Map<String, String> headers;
        final String body;

        Call(String method, String url, Map<String, String> headers, String body) {
            this.method = method;
            this.url = url;
            this.headers = new HashMap<>(headers);
            this.body = body;
        }

        String path() {
            return url.substring(API.length());
        }
    }

    static final class Row {
        String userId;
        String secretHash;
        String callerHash;
        String kind;
    }

    final List<Call> calls = new ArrayList<>();
    final Map<String, Row> rows = new HashMap<>();
    /** 服务器时钟(毫秒);Date 头与 expiresAt 都按它算。 */
    long serverNowMs = 1_790_000_000_000L;
    boolean sendDate = true;
    /** 老 server:没有 caller-token 路由,Express 回 HTML 404(探测与换票都撞上)。 */
    boolean oldServer;
    /** 下一次 caller-secret 回这个状态(0 = 正常)。 */
    int failCallerSecret;
    /** 每次换票都回这个状态(0 = 正常)。 */
    int mintStatus;
    /** 每次 register 都回这个状态(0 = 正常)。 */
    int registerStatus;
    int minted;
    IOException networkDown;
    /** true:任何请求都 401(forsion_token 过期 / 被吊销)。 */
    boolean rejectAuth;
    /** 只对 path 匹配这个正则的请求断网(null = 不限)。 */
    String networkDownPath;
    /** 非 null:register 进来先 countDown registerEntered,再等这个闸(模拟慢网上的登记)。 */
    volatile java.util.concurrent.CountDownLatch registerGate;
    final java.util.concurrent.CountDownLatch registerEntered = new java.util.concurrent.CountDownLatch(1);

    private static final Pattern P_SECRET = Pattern.compile("^/units/([^/]+)/caller-secret$");
    private static final Pattern P_TOKEN = Pattern.compile("^/units/([^/]+)/caller-token$");
    private static final Pattern P_ROW = Pattern.compile("^/units/([^/]+)$");

    static String sha(String s) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (byte x : h) b.append(String.format(Locale.ROOT, "%02x", x));
            return b.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    int count(String method, String pathRegex) {
        int n = 0;
        for (Call c : calls) if (c.method.equals(method) && c.path().matches(pathRegex)) n++;
        return n;
    }

    private Resp json(int status, String body) {
        return new Resp(status, body, sendDate ? serverNowMs : 0);
    }

    private Resp err(int status, String code) {
        return json(status, "{\"detail\":\"x\",\"code\":\"" + code + "\"}");
    }

    private String userOf(Map<String, String> h) {
        String a = h.get("Authorization");
        if (a == null || !a.startsWith("Bearer ")) return null;
        return UnitIdentity.userIdFromJwt(a.substring(7));
    }

    /** 探测:POST /units/00000000-…/caller-token(登记前确认 server 有调用方凭据路由)。 */
    int probes() {
        return count("POST", "/units/" + UnitRegistrar.PROBE_UNIT_ID + "/caller-token");
    }

    /** 真换票(不含探测)。 */
    int mints() {
        return count("POST", "/units/(?!" + UnitRegistrar.PROBE_UNIT_ID + ")[^/]+/caller-token");
    }

    Call last(String method, String pathRegex) {
        Call hit = null;
        for (Call c : calls) if (c.method.equals(method) && c.path().matches(pathRegex)) hit = c;
        return hit;
    }

    @Override
    public synchronized Resp send(String method, String url, Map<String, String> headers, String body) throws IOException {
        calls.add(new Call(method, url, headers, body));
        if (!url.startsWith(API)) throw new AssertionError("请求发到了 apiBase 之外: " + url);
        String path = url.substring(API.length());
        if (networkDown != null && (networkDownPath == null || path.matches(networkDownPath))) throw networkDown;
        String user = rejectAuth ? null : userOf(headers);
        if (user == null) return json(401, "{\"detail\":\"Invalid or expired token\"}");
        if (method.equals("POST") && path.equals("/units/register")) {
            java.util.concurrent.CountDownLatch gate = registerGate;
            if (gate != null) {
                registerEntered.countDown();
                try {
                    gate.await(20, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            if (registerStatus != 0) return json(registerStatus, "{\"detail\":\"boom\"}");
            JSONObject b;
            try {
                b = new JSONObject(body);
            } catch (Exception e) {
                return err(400, "BAD");
            }
            String id = UUID.randomUUID().toString();
            String secret = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "");
            Row r = new Row();
            r.userId = user;
            r.secretHash = sha(secret);
            r.kind = b.optString("kind", "desktop");
            rows.put(id, r);
            return json(200, "{\"unitId\":\"" + id + "\",\"secret\":\"" + secret + "\"}");
        }
        Matcher m;
        if (method.equals("POST") && (m = P_SECRET.matcher(path)).matches()) {
            Row r = rows.get(m.group(1));
            if (r == null || !r.userId.equals(user)) return err(404, "UNIT_NOT_FOUND");
            String given = headers.get("X-Unit-Secret");
            if (given == null || !sha(given).equals(r.secretHash)) return err(403, "UNIT_SECRET_MISMATCH");
            if (failCallerSecret != 0) {
                int s = failCallerSecret;
                failCallerSecret = 0;
                return json(s, "{\"detail\":\"boom\"}");
            }
            String cs = UUID.randomUUID().toString().replace("-", "");
            r.callerHash = sha(cs);
            return json(200, "{\"unitId\":\"" + m.group(1) + "\",\"callerSecret\":\"" + cs + "\"}");
        }
        if (method.equals("POST") && (m = P_TOKEN.matcher(path)).matches()) {
            if (oldServer) return new Resp(404, "<!DOCTYPE html><pre>Cannot POST</pre>", 0);
            Row r = rows.get(m.group(1));
            if (r == null || !r.userId.equals(user)) return err(404, "UNIT_NOT_FOUND");
            String given = headers.get("X-Unit-Caller-Secret");
            if (given == null || r.callerHash == null || !sha(given).equals(r.callerHash)) return err(403, "UNIT_CALLER_SECRET_MISMATCH");
            if (mintStatus != 0) return json(mintStatus, "{\"detail\":\"boom\"}");
            minted++;
            long exp = serverNowMs / 1000 + 600;
            return json(200, "{\"unitId\":\"" + m.group(1) + "\",\"token\":\"fuc1.t" + minted + "\",\"expiresAt\":" + exp + "}");
        }
        if (method.equals("DELETE") && (m = P_ROW.matcher(path)).matches()) {
            Row r = rows.get(m.group(1));
            if (r == null || !r.userId.equals(user)) return err(404, "UNIT_NOT_FOUND");
            rows.remove(m.group(1));
            return json(200, "{\"ok\":true}");
        }
        return new Resp(404, "<html>not found</html>", 0);
    }

    /** 内存存储;corrupt(key) 让下一次读抛(模拟备份恢复到新机后解不开)。 */
    static final class MemStore implements UnitStore {
        final Map<String, String> map = new HashMap<>();
        String corrupt;
        boolean failPut;

        @Override
        public String get(String key) throws Exception {
            if (key.equals(corrupt)) throw new javax.crypto.AEADBadTagException("tag mismatch");
            return map.get(key);
        }

        @Override
        public void put(String key, String plaintext) throws Exception {
            if (failPut) throw new IllegalStateException("disk full");
            map.put(key, plaintext);
        }

        @Override
        public void remove(String key) {
            map.remove(key);
            if (key.equals(corrupt)) corrupt = null;
        }
    }

    static final class TestClock implements UnitRegistrar.Clock {
        long elapsed = 1_000_000L;
        long wall = 1_790_000_000_000L;

        @Override
        public long elapsedMs() {
            return elapsed;
        }

        @Override
        public long wallMs() {
            return wall;
        }

        void advance(long ms) {
            elapsed += ms;
            wall += ms;
        }
    }

    static final class Env implements UnitRegistrar.Env {
        String apiBase = API;
        String token = UnitIdentityTest.jwt("{\"userId\":\"u1\"}");
        String name = "Pixel 9";

        @Override
        public String apiBase() {
            return apiBase;
        }

        @Override
        public String forsionToken() {
            return token;
        }

        @Override
        public String deviceName() {
            return name;
        }
    }

    static final UnitRegistrar.Log LOG = (msg) -> { /* 静默 */ };
}
