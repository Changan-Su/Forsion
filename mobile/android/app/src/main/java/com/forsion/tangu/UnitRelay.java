package com.forsion.tangu;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ProtocolException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;

/**
 * 原生 HTTP 中继(P1-K8,规格 K8 §3.3;裁决 INTEGRATION R-04 / R-06)。不依赖 android.*,JVM 单测(UnitRelayTest,真 HTTP)。
 *
 * 执行规则:
 *  1. 目的地只由原生拼:`apiBase + "/units/" + unitId + "/proxy" + path`;RelayPaths.check 不过 → bad_path,一个请求都不发。
 *  2. 头从零重建:Authorization = forsion_token(原生现读,JS 递来的丢弃)、X-Forsion-Caller = 调用方票、
 *     外加 JS 的 content-type / accept 两个;其余一律丢(C1:来源 / 身份头不许自报)。
 *  3. 发请求前先换到票;换不到 → caller_unavailable / caller_unsupported,**不发匿名请求**(失败关闭,S4)。
 *  4. body 只收字符串,UTF-8 ≤ 10MB(hub 隧道上限)→ 否则 too_large。
 *  5. 403 且 code ∈ {UNIT_CALLER_INVALID, UNIT_CALLER_EXPIRED}、且还没向 JS 交过 head → 强制换票重发**一次**;再失败原样交给 JS(R-04)。
 *  6. 连接 15s;accept 含 text/event-stream 时读超时 0(取消由 JS 驱动),否则 120s。不跟随重定向。
 *  7. 并发 ≤ 16(超出 → relay_busy);响应累计 > 256MB → too_large 并断开。每次 read 到的字节立即交出去(SSE 不攒包)。
 *  8. 日志只记 id、方法、状态码、时长;不记 path / query / body / 任何头。
 */
final class UnitRelay {
    /** 逐条交给 JS 的出口(UnitPlugin 把它接到 keepAlive 回调上)。close() 恰好调一次,在一切结束之后(含被取消)。 */
    interface Sink {
        void head(int status, Map<String, String> headers);

        void chunk(byte[] buf, int off, int len);

        void end();

        void error(String code, String message);

        void close();
    }

    interface Tokens {
        String get(boolean force) throws UnitError;

        void invalidate();
    }

    interface Auth {
        /** forsion_token,每次现读;null = 已登出。 */
        String forsionToken();
    }

    static final class Req {
        final String id;
        final String unitId;
        final String path;
        final String method;
        final Map<String, String> headers;
        final String body;

        Req(String id, String unitId, String path, String method, Map<String, String> headers, String body) {
            this.id = id;
            this.unitId = unitId;
            this.path = path;
            this.method = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
            this.headers = headers == null ? Collections.emptyMap() : headers;
            this.body = body;
        }
    }

    static final int MAX_CONCURRENT = 16;
    static final int MAX_BODY_BYTES = 10 * 1024 * 1024;
    static final long MAX_RESPONSE_BYTES = 256L * 1024 * 1024;
    static final int CONNECT_MS = 15_000;
    static final int READ_MS = 120_000;
    static final int ERROR_PEEK = 64 * 1024;
    private static final int BUF = 16 * 1024;
    private static final Set<String> METHODS = new HashSet<>(java.util.Arrays.asList("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"));
    private static final String[] PASS_REQUEST = {"content-type", "accept"};
    private static final String[] PASS_RESPONSE = {"content-type", "content-disposition", "cache-control"};

    private static final class Active {
        volatile boolean cancelled;
        volatile HttpURLConnection conn;
    }

    private final String apiBase;
    private final Auth auth;
    private final Tokens tokens;
    private final UnitRegistrar.Log log;
    private final Semaphore slots = new Semaphore(MAX_CONCURRENT);
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "forsion-unit-relay");
        t.setDaemon(true);
        return t;
    });
    private final Map<String, Active> active = new ConcurrentHashMap<>();

    /** apiBase 为 null(forsion-native.json 缺席 / 不合规)时每个请求都回 caller_unsupported。 */
    UnitRelay(String apiBase, Auth auth, Tokens tokens, UnitRegistrar.Log log) {
        this.apiBase = apiBase;
        this.auth = auth;
        this.tokens = tokens;
        this.log = log;
    }

    /** 起一个请求(立即返回;结果全走 sink)。 */
    void start(Req r, Sink sink) {
        if (r.id == null || r.id.isEmpty() || active.containsKey(r.id)) {
            sink.error("bad_path", "bad request id");
            sink.close();
            return;
        }
        if (!slots.tryAcquire()) {
            sink.error("relay_busy", "too many relayed requests");
            sink.close();
            return;
        }
        Active a = new Active();
        active.put(r.id, a);
        try {
            pool.execute(() -> {
                try {
                    run(r, sink, a);
                } finally {
                    active.remove(r.id);
                    slots.release();
                    sink.close();
                }
            });
        } catch (RuntimeException e) {
            active.remove(r.id);
            slots.release();
            sink.error("relay_busy", "relay pool rejected the request");
            sink.close();
        }
    }

    /** JS 中止 / reader.cancel():断开连接,之后这个请求不再往 sink 送任何东西(close 照调)。 */
    void cancel(String id) {
        Active a = active.get(id);
        if (a == null) return;
        a.cancelled = true;
        HttpURLConnection c = a.conn;
        if (c != null) {
            try {
                c.disconnect();
            } catch (RuntimeException ignored) {
                // 断开时的竞态异常无所谓
            }
        }
    }

    int inFlight() {
        return active.size();
    }

    private void run(Req r, Sink sink, Active a) {
        long t0 = System.nanoTime();
        int status = -1;
        try {
            if (!RelayPaths.check(r.unitId, r.path) || !METHODS.contains(r.method)) {
                sink.error("bad_path", "outside the relay grammar");
                return;
            }
            byte[] body = r.body == null ? null : r.body.getBytes(StandardCharsets.UTF_8);
            if (body != null && (r.method.equals("GET") || r.method.equals("HEAD"))) {
                sink.error("bad_path", "GET/HEAD cannot carry a body");
                return;
            }
            if (body != null && body.length > MAX_BODY_BYTES) {
                sink.error("too_large", "request body over 10MB");
                return;
            }
            if (apiBase == null) {
                sink.error("caller_unsupported", "no usable apiBase in this build");
                return;
            }
            String url = apiBase + "/units/" + r.unitId + "/proxy" + r.path;
            String accept = header(r.headers, "accept");
            boolean stream = accept != null && accept.toLowerCase(Locale.ROOT).contains("text/event-stream");
            for (int attempt = 0; attempt < 2; attempt++) {
                if (a.cancelled) return;
                String ticket;
                try {
                    ticket = tokens.get(attempt > 0);
                } catch (UnitError e) {
                    sink.error("caller_unsupported".equals(e.code) ? "caller_unsupported" : "caller_unavailable", e.getMessage());
                    return;
                }
                String bearer = auth.forsionToken();
                if (bearer == null) {
                    sink.error("caller_unavailable", "not signed in");
                    return;
                }
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                a.conn = c;
                if (a.cancelled) {
                    c.disconnect();
                    return;
                }
                try {
                    c.setConnectTimeout(CONNECT_MS);
                    c.setReadTimeout(stream ? 0 : READ_MS);
                    c.setInstanceFollowRedirects(false);
                    c.setUseCaches(false);
                    try {
                        c.setRequestMethod(r.method);
                    } catch (ProtocolException e) {
                        sink.error("bad_path", "method not supported by this platform");
                        return;
                    }
                    c.setRequestProperty("Authorization", "Bearer " + bearer);
                    c.setRequestProperty("X-Forsion-Caller", ticket);
                    for (String k : PASS_REQUEST) {
                        String v = header(r.headers, k);
                        if (v != null && !v.isEmpty() && v.indexOf('\n') < 0 && v.indexOf('\r') < 0) c.setRequestProperty(k, v);
                    }
                    if (body != null) {
                        c.setDoOutput(true);
                        c.setFixedLengthStreamingMode(body.length);
                        try (OutputStream os = c.getOutputStream()) {
                            os.write(body);
                        }
                    }
                    status = c.getResponseCode();
                    if (a.cancelled) return;
                    if (status == 403 && attempt == 0) {
                        byte[] peek = readUpTo(c.getErrorStream(), ERROR_PEEK);
                        String code = codeOf(peek);
                        if ("UNIT_CALLER_INVALID".equals(code) || "UNIT_CALLER_EXPIRED".equals(code)) {
                            tokens.invalidate();
                            continue; // 还没交过 head:换票重发一次
                        }
                        sink.head(status, responseHeaders(c));
                        if (peek.length > 0) sink.chunk(peek, 0, peek.length);
                        sink.end();
                        return;
                    }
                    sink.head(status, responseHeaders(c));
                    if (r.method.equals("HEAD") || status == 204 || status == 205 || status == 304) {
                        sink.end();
                        return;
                    }
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    if (in == null) {
                        sink.end();
                        return;
                    }
                    long total = 0;
                    byte[] buf = new byte[BUF];
                    try (InputStream s = in) {
                        for (int n; (n = s.read(buf)) >= 0; ) {
                            if (a.cancelled) return;
                            if (n == 0) continue;
                            total += n;
                            if (total > MAX_RESPONSE_BYTES) {
                                sink.error("too_large", "response over 256MB");
                                return;
                            }
                            sink.chunk(buf, 0, n);
                        }
                    }
                    if (!a.cancelled) sink.end();
                    return;
                } finally {
                    c.disconnect();
                }
            }
            // 两次都拿到坏票 403:第二次那个 403 在循环里原样交出去了,走不到这里。
        } catch (IOException e) {
            if (!a.cancelled) sink.error("network", e.getClass().getSimpleName());
        } catch (RuntimeException e) {
            if (!a.cancelled) sink.error("network", e.getClass().getSimpleName());
        } finally {
            long ms = (System.nanoTime() - t0) / 1_000_000;
            log.w("[relay] " + r.id + " " + r.method + " → " + (a.cancelled ? "cancelled" : String.valueOf(status)) + " in " + ms + "ms");
        }
    }

    private static String header(Map<String, String> h, String name) {
        for (Map.Entry<String, String> e : h.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }

    private static Map<String, String> responseHeaders(HttpURLConnection c) {
        Map<String, String> out = new LinkedHashMap<>();
        Map<String, List<String>> all = c.getHeaderFields();
        for (String want : PASS_RESPONSE) {
            for (Map.Entry<String, List<String>> e : all.entrySet()) {
                if (e.getKey() != null && e.getKey().equalsIgnoreCase(want) && e.getValue() != null && !e.getValue().isEmpty()) {
                    out.put(want, e.getValue().get(0));
                }
            }
        }
        return out;
    }

    private static byte[] readUpTo(InputStream in, int cap) throws IOException {
        if (in == null) return new byte[0];
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; out.size() < cap && (n = s.read(buf, 0, Math.min(buf.length, cap - out.size()))) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static String codeOf(byte[] body) {
        try {
            String c = new JSONObject(new String(body, StandardCharsets.UTF_8)).optString("code", "");
            return c.isEmpty() ? null : c;
        } catch (Exception e) {
            return null;
        }
    }
}
