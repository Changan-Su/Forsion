package com.forsion.tangu;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Locale;

/**
 * 手机操控的回程:`POST {apiBase}/agent/runs/:runId/inquiries/:ackId`(契约 §3.2),phase = claim / commit / result。
 *
 * - claim 与 result 遇网络错 / 5xx 各重试一次;commit 不重试(失败 = 不执行,宁可让引擎报「不确定」)。
 * - 410 / 404 / 其他 4xx 即终局:什么都不做,也不再发。
 * - token 每次现读(NativeConfig.token),日志只记 phase 与状态码,不写载荷、不写 token。
 * 全部是阻塞调用,只在 PhoneControlPlugin 自己的线程池上跑(每条指令一个实例,实例不跨线程共享)。
 */
final class PhoneClaim {
    private static final String TAG = "PhoneControl";
    private static final int CONNECT_MS = 10_000;
    private static final int READ_MS = 15_000;

    private static final SecureRandom RNG = new SecureRandom();

    private final Context ctx;
    private final String url;
    private final String ackId;
    /**
     * 本次 exec 的 claimant(契约 §3.2):每个 PhoneClaim 实例(= 每次 exec)一枚,claim 与它唯一一次重试共用。
     * 引擎的重领只认首次 claim 的 claimant —— 不带就失去丢响应后的重领资格;同账号另一台手机拿不到同一枚 nonce。
     * 不落盘、不进日志。
     */
    private final String claimant;

    /** claim 成功拿到的凭据。receivedAt = 成功那次 200 响应解析完的 elapsedRealtime(本地期限的锚点)。 */
    static final class Claimed {
        final String nonce;
        final long execMs;
        final long receivedAt;

        Claimed(String nonce, long execMs, long receivedAt) {
            this.nonce = nonce;
            this.execMs = execMs;
            this.receivedAt = receivedAt;
        }
    }

    PhoneClaim(Context ctx, String apiBase, String runId, String ackId) {
        this.ctx = ctx.getApplicationContext();
        this.ackId = ackId;
        this.url = apiBase + "/agent/runs/" + enc(runId) + "/inquiries/" + enc(ackId);
        byte[] b = new byte[16];
        RNG.nextBytes(b);
        StringBuilder hex = new StringBuilder(32);
        for (byte x : b) hex.append(String.format(Locale.ROOT, "%02x", x));
        this.claimant = hex.toString();
    }

    /**
     * 领指令。null = 没领到(410 / 404 / 网络):调用方什么都不做。
     * execMs 原样带回(钳制在 PhoneVerbs.localDeadline):重复 claim 回的是**剩余**时长,可以合法地小于 5s。
     * 锚点取响应到达时刻而非发出时刻 —— 重试时第一次发出到现在的时间已经从剩余里扣过了(契约 §3.2)。
     */
    Claimed claim(String digest) {
        JSONObject body = json("phase", "claim", "digest", digest);
        try {
            body.put("claimant", claimant);
        } catch (Exception ignored) {
            // put(String, String) 只在 key 为 null 时抛
        }
        JSONObject r = post(body, "claim", true);
        if (r == null) return null;
        long receivedAt = SystemClock.elapsedRealtime();
        String nonce = r.optString("nonce", "");
        if (nonce.isEmpty()) return null;
        return new Claimed(nonce, r.optLong("execMs", 20_000), receivedAt);
    }

    /** 用户点了确认之后、执行之前:引擎仍在等(没被 Stop / 没超时)才放行。 */
    boolean commit(String nonce) {
        return post(json("phase", "commit", "nonce", nonce), "commit", false) != null;
    }

    /** 回执。fields = {ok, code?, error?, text?, app?, handoff?, verified?}。 */
    void result(String nonce, JSONObject fields) {
        try {
            fields.put("phase", "result");
            fields.put("nonce", nonce);
        } catch (Exception e) {
            return;
        }
        post(fields, "result", true);
    }

    private JSONObject post(JSONObject body, String phase, boolean retry) {
        for (int attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
            String token = NativeConfig.token(ctx);
            if (token == null) {
                Log.w(TAG, "[phone] " + phase + " skipped: not signed in (" + ackId + ")");
                return null;
            }
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(CONNECT_MS);
                c.setReadTimeout(READ_MS);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setInstanceFollowRedirects(false); // 带 token 的请求不跟跳转
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                c.setRequestProperty("Accept", "application/json");
                c.setRequestProperty("Authorization", "Bearer " + token);
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(bytes);
                }
                int code = c.getResponseCode();
                Log.i(TAG, "[phone] " + phase + " → " + code + " (" + ackId + ")");
                if (code == 200) {
                    JSONObject r = new JSONObject(read(c.getInputStream()));
                    return r.optBoolean("ok", false) ? r : null;
                }
                if (code < 500) return null; // 410 终局;404 / 401 等同样不重试
            } catch (IOException e) {
                Log.w(TAG, "[phone] " + phase + " network error: " + e.getClass().getSimpleName() + " (" + ackId + ")");
            } catch (Exception e) {
                Log.w(TAG, "[phone] " + phase + " failed: " + e.getClass().getSimpleName() + " (" + ackId + ")");
                return null;
            } finally {
                if (c != null) c.disconnect();
            }
        }
        return null;
    }

    /**
     * 急停(手机操控 T2,契约 §9.5):药丸「停止」被点 → 伴随包 onStop → 主包用**自持 token** 直接
     * `POST {apiBase}/agent/runs/:runId/abort`。不依赖 JS 活着;失败只记日志(用户已经点了停止,尽力而为)。
     */
    static void abort(Context ctx, String apiBase, String runId) {
        String token = NativeConfig.token(ctx.getApplicationContext());
        if (token == null) {
            Log.w(TAG, "[phone] abort skipped: not signed in");
            return;
        }
        String url = apiBase + "/agent/runs/" + enc(runId) + "/abort";
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setRequestProperty("Authorization", "Bearer " + token);
            byte[] bytes = "{}".getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(bytes);
            }
            Log.i(TAG, "[phone] abort → " + c.getResponseCode() + " (" + runId + ")");
        } catch (Exception e) {
            Log.w(TAG, "[phone] abort failed: " + e.getClass().getSimpleName());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = s.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                if (out.size() > 64 * 1024) throw new IOException("response too large");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static JSONObject json(String k1, String v1, String k2, String v2) {
        JSONObject o = new JSONObject();
        try {
            o.put(k1, v1);
            o.put(k2, v2);
        } catch (Exception ignored) {
            // put(String, String) 只在 key 为 null 时抛
        }
        return o;
    }
}
