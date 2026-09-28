package com.forsion.tangu;

import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 手机作为 Unit 的原生半身(P1-K8,规格 K8 §3.3):身份(登记 / 换票 / 自愈)+ 远端引擎请求的 HTTP 中继。
 * JS 侧:mobile/src/unitNative.ts(registerPlugin('ForsionUnit'))→ mobileShim(window.fetch 前置 + window.tangu.unit*)。
 *
 * | 方法               | 返回                                                  |
 * |--------------------|-------------------------------------------------------|
 * | config()           | {apiBase}(构建期烤死的地址,非机密;mobileShim 启动断言用)   |
 * | status()           | {registered, unitId?, name?}(只读本地,无网络)           |
 * | ensureRegistered() | {unitId, name, created};reject code 见 UnitError       |
 * | forget({remote})   | {ok}                                                  |
 * | request(opts, cb)  | RETURN_CALLBACK + keepAlive:多次回调 head / chunk / end / error |
 * | cancel({id})       | {ok}                                                  |
 *
 * ⚠️ 设备密钥、调用方凭据、调用方票**永不**出现在任何 resolve / reject / 日志里(S1)。
 */
@CapacitorPlugin(name = "ForsionUnit")
public class UnitPlugin extends Plugin {
    private static final String TAG = "ForsionUnit";

    private UnitRegistrar registrar;
    private CallerTokens tokens;
    private UnitRelay relay;
    private final ExecutorService identityPool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "forsion-unit-identity");
        t.setDaemon(true);
        return t;
    });

    @Override
    public void load() {
        final Context ctx = getContext().getApplicationContext();
        UnitRegistrar.Log log = (msg) -> Log.i(TAG, msg);
        UnitRegistrar.Clock clock = new UnitRegistrar.Clock() {
            @Override
            public long elapsedMs() {
                return SystemClock.elapsedRealtime();
            }

            @Override
            public long wallMs() {
                return System.currentTimeMillis();
            }
        };
        UnitRegistrar.Env env = new UnitRegistrar.Env() {
            @Override
            public String apiBase() {
                return NativeConfig.apiBase(ctx);
            }

            @Override
            public String forsionToken() {
                return NativeConfig.token(ctx);
            }

            @Override
            public String deviceName() {
                String n = null;
                try {
                    n = Settings.Global.getString(ctx.getContentResolver(), Settings.Global.DEVICE_NAME);
                } catch (Exception ignored) {
                    // 部分 ROM 不给读
                }
                if (n == null || n.trim().isEmpty()) n = Build.MANUFACTURER + " " + Build.MODEL;
                return n;
            }
        };
        UnitHttp http = new UnitHttp.UrlConnection();
        registrar = new UnitRegistrar(env, http, new PrefsUnitStore(ctx), clock, log);
        tokens = new CallerTokens(registrar, http, clock, log);
        relay = new UnitRelay(NativeConfig.apiBase(ctx), () -> NativeConfig.token(ctx), new UnitRelay.Tokens() {
            @Override
            public String get(boolean force) throws UnitError {
                return tokens.get(force);
            }

            @Override
            public void invalidate() {
                tokens.invalidate();
            }
        }, log);
    }

    @PluginMethod
    public void config(PluginCall call) {
        JSObject o = new JSObject();
        String base = NativeConfig.apiBase(getContext());
        o.put("apiBase", base == null ? JSONObject.NULL : base);
        call.resolve(o);
    }

    @PluginMethod
    public void status(PluginCall call) {
        UnitIdentity id = registrar.current();
        JSObject o = new JSObject();
        o.put("registered", id != null);
        o.put("unitId", id == null ? JSONObject.NULL : id.unitId);
        o.put("name", id == null ? JSONObject.NULL : id.name);
        call.resolve(o);
    }

    @PluginMethod
    public void ensureRegistered(PluginCall call) {
        identityPool.execute(() -> {
            try {
                UnitRegistrar.Ensured e = registrar.ensure();
                JSObject o = new JSObject();
                o.put("unitId", e.identity.unitId);
                o.put("name", e.identity.name);
                o.put("created", e.created);
                call.resolve(o);
            } catch (UnitError err) {
                call.reject(err.getMessage(), err.code);
            } catch (RuntimeException err) {
                call.reject(err.getClass().getSimpleName(), "network");
            }
        });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        final boolean remote = Boolean.TRUE.equals(call.getBoolean("remote", false));
        identityPool.execute(() -> {
            registrar.forget(remote);
            tokens.invalidate();
            JSObject o = new JSObject();
            o.put("ok", true);
            call.resolve(o);
        });
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void request(final PluginCall call) {
        call.setKeepAlive(true);
        Map<String, String> headers = new HashMap<>();
        JSObject h = call.getObject("headers", new JSObject());
        if (h != null) {
            for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                String k = it.next();
                headers.put(k, h.optString(k, ""));
            }
        }
        String body = call.getData().has("body") && !call.getData().isNull("body") ? call.getString("body") : null;
        UnitRelay.Req req = new UnitRelay.Req(call.getString("id"), call.getString("unitId"), call.getString("path"), call.getString("method"), headers, body);
        relay.start(req, new CallSink(call));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id != null) relay.cancel(id);
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
    }

    /**
     * 把中继事件接到 keepAlive 回调上。最后一条消息前 setKeepAlive(false)(JS 端据 save:false 丢掉回调),
     * 之后经 bridge.execute 释放 —— 排在 Bridge 自己那次 saveCall 之后,不会漏删。
     */
    private final class CallSink implements UnitRelay.Sink {
        private final PluginCall call;
        private final AtomicBoolean done = new AtomicBoolean(false);

        CallSink(PluginCall call) {
            this.call = call;
        }

        private void send(JSObject o, boolean last) {
            if (last) {
                if (!done.compareAndSet(false, true)) return;
                call.setKeepAlive(false);
            } else if (done.get()) {
                return;
            }
            call.resolve(o);
        }

        @Override
        public void head(int status, Map<String, String> headers) {
            JSObject o = new JSObject();
            o.put("type", "head");
            o.put("status", status);
            JSObject hs = new JSObject();
            for (Map.Entry<String, String> e : headers.entrySet()) hs.put(e.getKey(), e.getValue());
            o.put("headers", hs);
            send(o, false);
        }

        @Override
        public void chunk(byte[] buf, int off, int len) {
            byte[] slice = new byte[len];
            System.arraycopy(buf, off, slice, 0, len);
            JSObject o = new JSObject();
            o.put("type", "chunk");
            o.put("b64", Base64.getEncoder().encodeToString(slice));
            send(o, false);
        }

        @Override
        public void end() {
            JSObject o = new JSObject();
            o.put("type", "end");
            send(o, true);
        }

        @Override
        public void error(String code, String message) {
            JSObject o = new JSObject();
            o.put("type", "error");
            o.put("code", code);
            if (message != null) o.put("message", message);
            send(o, true);
        }

        @Override
        public void close() {
            if (!done.get()) error("network", "cancelled"); // 被取消:JS 早已收尾,这条只为让它丢掉回调
            getBridge().execute(() -> getBridge().releaseCall(call));
        }
    }
}
