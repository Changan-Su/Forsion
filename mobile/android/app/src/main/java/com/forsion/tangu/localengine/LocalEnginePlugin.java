package com.forsion.tangu.localengine;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "This phone" for the page (JS: mobile/src/localEngine.ts → window.tangu.localEngine).
 *
 * | method                  | result                                                                        |
 * |-------------------------|-------------------------------------------------------------------------------|
 * | state()                 | {available, configured, installed, phase, engine, versions, sizes, …}         |
 * | check()                 | state() after reading the manifest (download / unpacked sizes, update)        |
 * | install({reset?})       | starts download + unpack in the background; progress via "state" events       |
 * | update()                | replaces only the engine layer                                                |
 * | pause()                 | stops the download; resume() continues from the partial file                  |
 * | resume()                | repeats the operation a pause / failure interrupted (install, reset or update) |
 * | remove()                | deletes the environment (conversations and the workspace stay)                |
 * | start() / stop()        | engine up (waits for health; rejects signed_out / maintenance / …) / down    |
 * | usage()                 | bytes: environment, home, workspace, downloads                                |
 * | configure({strings})    | notification texts in the page's language                                     |
 * | metered()               | {metered} — the confirmation warns before downloading on mobile data          |
 *
 * The engine's port and local token never cross into the page: requests go through ForsionUnit.request with the
 * reserved phone id, and the relay adds the token natively. Debuggable builds also take setManifest / setLink2symlink
 * / shell (test benches only; release refuses them).
 */
@CapacitorPlugin(name = "ForsionLocalEngine")
public class LocalEnginePlugin extends Plugin {
    private LocalEngine engine;
    private final LocalEngine.Listener listener = (s) -> notifyListeners("state", toJs(s));
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r, "local-engine-plugin"); t.setDaemon(true); return t; });

    @Override
    public void load() {
        engine = LocalEngine.get(getContext());
        engine.addListener(listener);
    }

    @Override
    protected void handleOnDestroy() {
        if (engine != null) engine.removeListener(listener);
    }

    private static JSObject toJs(JSONObject o) {
        try { return JSObject.fromJSONObject(o); } catch (Exception e) { return new JSObject(); }
    }

    @PluginMethod
    public void state(PluginCall call) { call.resolve(toJs(engine.state())); }

    @PluginMethod
    public void check(PluginCall call) {
        pool.execute(() -> {
            try {
                call.resolve(toJs(engine.check()));
            } catch (LocalEngineInstaller.Failure f) {
                call.reject(f.code, f.code);
            } catch (Exception e) {
                call.reject(e.getClass().getSimpleName(), "network");
            }
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        engine.install(Boolean.TRUE.equals(call.getBoolean("reset", false)));
        call.resolve(toJs(engine.state()));
    }

    @PluginMethod
    public void update(PluginCall call) {
        engine.update();
        call.resolve(toJs(engine.state()));
    }

    @PluginMethod
    public void resume(PluginCall call) {
        engine.resume();
        call.resolve(toJs(engine.state()));
    }

    @PluginMethod
    public void pause(PluginCall call) {
        engine.pause();
        call.resolve(toJs(engine.state()));
    }

    @PluginMethod
    public void remove(PluginCall call) {
        engine.remove();
        call.resolve(new JSObject().put("ok", true));
    }

    @PluginMethod
    public void start(PluginCall call) {
        pool.execute(() -> {
            try {
                engine.ensureRunning();
                call.resolve(toJs(engine.state()));
            } catch (Exception e) {
                String m = e.getMessage() == null ? "start_failed" : e.getMessage();
                call.reject(m, m.startsWith("start_failed") ? "start_failed" : m);
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        pool.execute(() -> {
            engine.stopEngine("page");
            call.resolve(toJs(engine.state()));
        });
    }

    @PluginMethod
    public void usage(PluginCall call) {
        pool.execute(() -> call.resolve(toJs(engine.usage())));
    }

    @PluginMethod
    public void metered(PluginCall call) {
        boolean m = false;
        try {
            android.net.ConnectivityManager cm = getContext().getSystemService(android.net.ConnectivityManager.class);
            m = cm != null && cm.isActiveNetworkMetered();
        } catch (RuntimeException ignored) {}
        call.resolve(new JSObject().put("metered", m));
    }

    @PluginMethod
    public void configure(PluginCall call) {
        JSObject s = call.getObject("strings", new JSObject());
        if (s != null) LocalEngineService.saveStrings(getContext(), s.optString("channel", null), s.optString("title", null), s.optString("text", null), s.optString("stop", null));
        call.resolve(new JSObject().put("ok", true));
    }

    // ---------- debuggable builds only ----------

    @PluginMethod
    public void setManifest(PluginCall call) {
        boolean ok = engine.setManifestOverride(call.getString("url", ""));
        if (ok) call.resolve(toJs(engine.state()));
        else call.reject("release builds take the manifest from the build only", "forbidden");
    }

    @PluginMethod
    public void setLink2symlink(PluginCall call) {
        if (engine.setLink2symlink(Boolean.TRUE.equals(call.getBoolean("on", true)))) call.resolve(new JSObject().put("ok", true));
        else call.reject("debug only", "forbidden");
    }

    @PluginMethod
    public void shell(PluginCall call) {
        String cmd = call.getString("cmd", "");
        int timeout = call.getInt("timeout", 120);
        pool.execute(() -> {
            try {
                call.resolve(new JSObject().put("out", engine.debugShell(cmd, timeout)));
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "forbidden");
            }
        });
    }
}
