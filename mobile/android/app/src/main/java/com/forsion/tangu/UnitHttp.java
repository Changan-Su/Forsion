package com.forsion.tangu;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 身份面(登记 / 轮换 / 换票 / 删除)的小请求口(P1-K8)。接口化是为了 JVM 单测注入假 hub(RegistrarFlowTest / CallerTokensTest)。
 * 实现 {@link UrlConnection}:连接 10s / 读 15s、不跟随重定向(带 token 的请求不跟跳转,同 PhoneClaim 口径)、响应体封顶 64KB、
 * 不碰进程全局 cookie 罐(NoCookieJar:Capacitor 把 WebView 的罐装成了全局 CookieHandler)。
 */
interface UnitHttp {
    /** 一次请求的结果。status = 0 不会出现:网络错直接抛 IOException。 */
    final class Resp {
        final int status;
        final String body;
        /** 响应 `Date` 头(毫秒,服务器时钟);缺席 = 0。换票据它算剩余有效期,不受手机时钟偏差影响。 */
        final long dateMs;

        Resp(int status, String body, long dateMs) {
            this.status = status;
            this.body = body == null ? "" : body;
            this.dateMs = dateMs;
        }

        /** 响应 JSON 里的 code(不是 JSON / 没有 code → null:老 server 的 404 可能是 HTML)。 */
        String code() {
            try {
                String c = new JSONObject(body).optString("code", "");
                return c.isEmpty() ? null : c;
            } catch (Exception e) {
                return null;
            }
        }

        JSONObject json() {
            try {
                return new JSONObject(body);
            } catch (Exception e) {
                return null;
            }
        }
    }

    Resp send(String method, String url, Map<String, String> headers, String body) throws IOException;

    final class UrlConnection implements UnitHttp {
        private static final int CONNECT_MS = 10_000;
        private static final int READ_MS = 15_000;
        private static final int MAX_BODY = 64 * 1024;

        @Override
        public Resp send(String method, String url, Map<String, String> headers, String body) throws IOException {
            boolean prevNoCookies = NoCookieJar.enter();
            try {
                return sendNoCookies(method, url, headers, body);
            } finally {
                NoCookieJar.exit(prevNoCookies);
            }
        }

        private Resp sendNoCookies(String method, String url, Map<String, String> headers, String body) throws IOException {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            try {
                c.setConnectTimeout(CONNECT_MS);
                c.setReadTimeout(READ_MS);
                c.setInstanceFollowRedirects(false);
                c.setUseCaches(false);
                c.setRequestMethod(method);
                for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
                boolean hasBody = body != null || method.equals("POST") || method.equals("PUT") || method.equals("PATCH");
                if (hasBody) {
                    byte[] bytes = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(bytes);
                    }
                }
                int status = c.getResponseCode();
                long date = c.getHeaderFieldDate("Date", 0);
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                return new Resp(status, in == null ? "" : read(in), date);
            } finally {
                c.disconnect();
            }
        }

        private static String read(InputStream in) throws IOException {
            try (InputStream s = in) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                for (int n; (n = s.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_BODY) throw new IOException("response too large");
                }
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        }
    }
}
