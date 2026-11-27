package com.forsion.tangu.localengine;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.LinkProperties;
import android.os.Build;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;

import com.forsion.tangu.BuildConfig;

import org.json.JSONObject;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The "This phone" local engine: environment install state + one engine process. Process-wide singleton; the plugin,
 * the relay and the foreground service all talk to it.
 *
 * Starting: only when this phone is the chosen place to run (the page calls start(), and requests to the local engine
 * start it). Health = /health 200 and an authed call that only this start's token can pass, so a stale engine left on
 * the port cannot pass for ours. A start that exits before it is healthy is a crash whatever the exit code (a glibc
 * double free exited 0 in the probes); one automatic retry, then "failed".
 *
 * Stopping: the notification's Stop, the page, or idle — no active run (engine /health activeRuns), no relayed request
 * in flight, and no non-GET request for 10 minutes. Passive GET polls neither start a stopped engine nor keep it alive.
 */
public final class LocalEngine {
    private static final String TAG = "LocalEngine";
    static final long IDLE_MS = 10 * 60_000L;
    private static final int MAX_START_ATTEMPTS = 2;

    public interface Listener { void onChange(JSONObject state); }

    private static volatile LocalEngine instance;

    public static LocalEngine get(Context c) {
        LocalEngine e = instance;
        if (e != null) return e;
        synchronized (LocalEngine.class) {
            if (instance == null) instance = new LocalEngine(c.getApplicationContext());
            return instance;
        }
    }

    final Context ctx;
    final LocalEnginePaths paths;
    private final boolean debuggable;
    private final ExecutorService work = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r, "local-engine-install"); t.setDaemon(true); return t; });
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "local-engine-idle"); t.setDaemon(true); return t; });
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private final Object startLock = new Object();
    private final AtomicInteger inFlight = new AtomicInteger();

    // install state
    private volatile String phase = "idle";      // idle | downloading | paused | unpacking | checking | failed
    private volatile String failCode;
    private volatile String layer;
    private volatile long done, total;
    private volatile LocalEngineInstaller installer;
    private volatile LocalEngineInstaller.Manifest manifest;
    private volatile String manifestOverride;

    // engine state
    private volatile LocalEngineProcess proc;
    private volatile String engineState = "stopped"; // stopped | starting | running | failed
    private volatile String engineFail;
    private volatile long lastActive;
    /** Set by an explicit start / a write request; cleared by idle-stop and Stop: GET polls may only start a wanted engine. */
    private volatile boolean wanted;
    private ConnectivityManager.NetworkCallback netCb;

    private LocalEngine(Context c) {
        ctx = c;
        paths = new LocalEnginePaths(c);
        debuggable = (c.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        timer.scheduleWithFixedDelay(this::idleCheck, 60, 60, TimeUnit.SECONDS);
    }

    public boolean available() { return paths.launcherBundled(); }

    public void addListener(Listener l) { listeners.add(l); }

    public void removeListener(Listener l) { listeners.remove(l); }

    private void emit() {
        JSONObject s = state();
        for (Listener l : listeners) {
            try { l.onChange(s); } catch (RuntimeException ignored) {}
        }
    }

    // ---------- state for the page ----------

    public JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            o.put("available", available());
            o.put("configured", !manifestUrl().isEmpty());
            JSONObject inst = installerFor().installed();
            o.put("installed", inst != null);
            if (inst != null) {
                o.put("baseVersion", inst.getJSONObject("base").optString("version"));
                o.put("engineVersion", inst.getJSONObject("engine").optString("version"));
            }
            o.put("phase", phase);
            if (failCode != null) o.put("error", failCode);
            if (layer != null) o.put("layer", layer);
            o.put("done", done);
            o.put("total", total);
            LocalEngineInstaller.Manifest m = manifest;
            if (m != null) {
                o.put("downloadBytes", m.base.size + m.engine.size);
                o.put("unpackedBytes", m.base.unpackedSize + m.engine.unpackedSize);
                o.put("engineDownloadBytes", m.engine.size);
                o.put("availableEngineVersion", m.engine.version);
                o.put("availableBaseVersion", m.base.version);
                o.put("resumeBytes", installerFor().downloadedBytes(m));
                if (inst != null) {
                    boolean engineOld = !m.engine.sha256.equals(inst.getJSONObject("engine").optString("sha256"));
                    o.put("updateAvailable", engineOld);
                }
            }
            o.put("engine", engineState);
            if (engineFail != null) o.put("engineError", engineFail);
        } catch (Exception e) {
            Log.w(TAG, "state " + e);
        }
        return o;
    }

    /** Disk use of the environment, the engine's home and the workspace (walks the trees: call off the main thread). */
    public JSONObject usage() {
        JSONObject o = new JSONObject();
        try {
            o.put("environment", LocalEnginePaths.treeBytes(paths.rootfs));
            o.put("home", LocalEnginePaths.treeBytes(paths.home));
            o.put("workspace", LocalEnginePaths.treeBytes(paths.workspace));
            o.put("downloads", LocalEnginePaths.treeBytes(paths.downloads));
        } catch (Exception ignored) {}
        return o;
    }

    String manifestUrl() {
        String o = manifestOverride;
        if (o != null && !o.isEmpty()) return o;
        return BuildConfig.LOCAL_ENGINE_MANIFEST == null ? "" : BuildConfig.LOCAL_ENGINE_MANIFEST;
    }

    /** The manifest decides what code runs: the page may only point elsewhere in debuggable builds (test servers). */
    public boolean setManifestOverride(String url) {
        if (!debuggable) return false;
        manifestOverride = url;
        manifest = null;
        return true;
    }

    private synchronized LocalEngineInstaller installerFor() {
        if (installer == null) installer = new LocalEngineInstaller(paths, debuggable);
        return installer;
    }

    // ---------- install / update / remove ----------

    /** Reads the manifest (sizes for the confirmation). Blocking. */
    public JSONObject check() throws Exception {
        String url = manifestUrl();
        if (url.isEmpty()) throw new LocalEngineInstaller.Failure("not_configured", null);
        manifest = installerFor().fetchManifest(url);
        return state();
    }

    /** Download + unpack (fresh install or resume). Runs in the background; progress via listeners. */
    public void install(boolean reset) {
        work.execute(() -> runInstall(reset ? "reset" : "install"));
    }

    public void update() {
        work.execute(() -> runInstall("update"));
    }

    private void runInstall(String kind) {
        LocalEngineInstaller ins = installerFor();
        failCode = null;
        try {
            if (!available()) throw new LocalEngineInstaller.Failure("unsupported", null);
            setPhase("downloading");
            if (manifest == null) check();
            LocalEngineInstaller.Manifest m = manifest;
            JSONObject inst = ins.installed();
            if (kind.equals("reset") || inst != null) stopEngine("install");
            LocalEngineInstaller.Listener l = (ph, ly, d, t) -> {
                phase = ph; layer = ly; done = d; total = t;
                emit();
            };
            if (kind.equals("update") && inst != null) ins.updateEngine(m, inst, l);
            else ins.installFresh(m, l);
            setPhase("checking");
            String why = selfTest();
            if (why != null) throw new LocalEngineInstaller.Failure("selftest", why);
            layer = null;
            setPhase("idle");
        } catch (LocalEngineInstaller.Cancelled c) {
            setPhase("paused");
        } catch (LocalEngineInstaller.Failure f) {
            Log.w(TAG, kind + " failed: " + f.getMessage());
            failCode = f.code;
            setPhase("failed");
        } catch (Exception e) {
            Log.w(TAG, kind + " failed", e);
            failCode = e instanceof java.io.IOException ? "network" : "unknown";
            setPhase("failed");
        }
    }

    public void pause() {
        LocalEngineInstaller i = installer;
        if (i != null) i.cancel();
    }

    /** Deletes the environment. Conversations (home) and the workspace stay. */
    public void remove() {
        pause();
        work.execute(() -> {
            stopEngine("remove");
            installerFor().removeEnvironment();
            failCode = null;
            layer = null;
            done = total = 0;
            setPhase("idle");
        });
    }

    private void setPhase(String p) {
        phase = p;
        emit();
    }

    /** PRoot + loader + glibc Node + the native SQLite module, in a throwaway process. null = fine. */
    private String selfTest() {
        try {
            ProcessBuilder pb = new ProcessBuilder(paths.prootArgv("/opt/tangu", null, java.util.Arrays.asList(
                    "/opt/node/bin/node", "-e", "const D=require('/opt/tangu/node_modules/better-sqlite3');new D(':memory:').prepare('select 1').get();console.log('selftest-ok')")));
            pb.environment().clear();
            pb.environment().putAll(paths.prootEnv());
            pb.redirectErrorStream(true);
            pb.directory(paths.base);
            Process p = pb.start();
            byte[] out = new byte[4096];
            int n = 0;
            try (java.io.InputStream in = p.getInputStream()) {
                for (int r; n < out.length && (r = in.read(out, n, out.length - n)) > 0; ) n += r;
            }
            if (!p.waitFor(60, TimeUnit.SECONDS)) { p.destroyForcibly(); return "timeout"; }
            String s = new String(out, 0, n, java.nio.charset.StandardCharsets.UTF_8);
            return s.contains("selftest-ok") ? null : s.trim();
        } catch (Exception e) {
            return e.getClass().getSimpleName();
        }
    }

    // ---------- engine ----------

    public boolean running() {
        LocalEngineProcess p = proc;
        return p != null && p.alive() && "running".equals(engineState);
    }

    /** For the relay: the running engine, starting it when allowed. null = not available (fail fast). */
    LocalEngineProcess acquire(boolean write) {
        LocalEngineProcess p = proc;
        if (p != null && p.alive() && "running".equals(engineState)) {
            if (write) { lastActive = System.currentTimeMillis(); wanted = true; }
            return p;
        }
        if (!write && !wanted) return null;
        try {
            return ensureRunning();
        } catch (Exception e) {
            return null;
        }
    }

    /** For the relay: token of the running engine (port into port[0]), or null. See acquire. */
    public String acquireEndpoint(boolean write, int[] port) {
        LocalEngineProcess p = acquire(write);
        if (p == null) return null;
        writeCloudToken(); // account changes reach the engine's token file without a restart
        port[0] = p.port;
        return p.token;
    }

    public void requestStarted() { inFlight.incrementAndGet(); }

    /** Only write requests and runs count as activity (acquire / idleCheck): ending a GET poll must not keep the engine up. */
    public void requestEnded() { inFlight.decrementAndGet(); }

    /** Starts the engine if needed and waits until it is healthy. Blocking (relay / plugin threads). */
    public LocalEngineProcess ensureRunning() throws Exception {
        synchronized (startLock) {
            LocalEngineProcess p = proc;
            if (p != null && p.alive() && "running".equals(engineState)) { lastActive = System.currentTimeMillis(); return p; }
            if (!available()) throw new IllegalStateException("unsupported");
            if (installerFor().installed() == null) throw new IllegalStateException("not_installed");
            wanted = true;
            engineFail = null;
            engineState = "starting";
            emit();
            paths.prepareRootfs();
            writeCloudToken();
            sweepOrphans();
            LocalEngineService.start(ctx);
            String why = "unknown";
            for (int attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
                LocalEngineProcess np = LocalEngineProcess.spawn(paths, engineEnv());
                why = np.awaitHealthy(LocalEngineProcess.HEALTH_TIMEOUT_MS);
                if (why == null && !ownsPort(np)) why = "foreign";
                if (why == null) {
                    proc = np;
                    engineState = "running";
                    lastActive = System.currentTimeMillis();
                    watch(np);
                    watchNetwork(true);
                    emit();
                    Log.i(TAG, "engine ready on attempt " + attempt + " in " + (System.currentTimeMillis() - np.startedAt) + "ms");
                    return np;
                }
                Log.w(TAG, "engine start attempt " + attempt + " failed: " + why + " tail=" + tailOf(np));
                np.stop();
            }
            engineState = "failed";
            engineFail = why;
            LocalEngineService.stop(ctx);
            emit();
            throw new IllegalStateException("start_failed:" + why);
        }
    }

    public void stopEngine(String why) {
        synchronized (startLock) {
            wanted = false;
            LocalEngineProcess p = proc;
            proc = null;
            if (p != null) {
                Log.i(TAG, "stopping engine (" + why + ")");
                p.stop();
            }
            if (!"failed".equals(engineState)) engineState = "stopped";
            watchNetwork(false);
            LocalEngineService.stop(ctx);
            emit();
        }
    }

    private Map<String, String> engineEnv() {
        Map<String, String> env = new HashMap<>();
        String api = com.forsion.tangu.NativeConfigAccess.apiBase(ctx);
        if (api != null && api.endsWith("/api")) env.put("TANGU_CLOUD_URL", api.substring(0, api.length() - 4));
        env.put("TANGU_TOKEN_FILE", "/root/.tangu/.forsion-cloud-token");
        String ver = BuildConfig.VERSION_NAME == null ? "" : BuildConfig.VERSION_NAME;
        if (ver.matches("[A-Za-z0-9._-]{1,32}")) env.put("TANGU_HOST_CLIENT", "mobile/" + ver);
        return env;
    }

    /** The account token the engine uses for models / cloud features (never as its local credential: TANGU_PHONE). */
    void writeCloudToken() {
        String tok = com.forsion.tangu.NativeConfigAccess.token(ctx);
        File f = new File(paths.home, ".forsion-cloud-token");
        try {
            paths.home.mkdirs();
            String cur = LocalEnginePaths.readSmall(f.getPath());
            String want = tok == null ? "" : tok;
            if (!want.equals(cur == null ? "" : cur.trim())) {
                LocalEnginePaths.writeText(f, want);
                Os.chmod(f.getPath(), 0600);
            }
        } catch (Exception e) {
            Log.w(TAG, "cloud token file: " + e.getClass().getSimpleName());
        }
    }

    /** Only this start's token passes /agent/sessions: proves the port is ours, not a leftover engine. */
    private boolean ownsPort(LocalEngineProcess p) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + p.port + "/agent/sessions?limit=1").openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(10_000);
            c.setRequestProperty("Authorization", "Bearer " + p.token);
            int st = c.getResponseCode();
            c.disconnect();
            return st == 200;
        } catch (Exception e) {
            Log.w(TAG, "ownsPort: " + e.getClass().getSimpleName());
            return false;
        }
    }

    private void watch(LocalEngineProcess p) {
        Thread t = new Thread(() -> {
            try { p.waitFor(); } catch (InterruptedException ignored) {}
            synchronized (startLock) {
                if (proc == p) {
                    // exited on its own (crash, killed by the system): the running turn shows as interrupted, like a desktop restart
                    Log.w(TAG, "engine exited unexpectedly; tail=" + tailOf(p));
                    proc = null;
                    engineState = "stopped";
                    engineFail = "exited";
                    watchNetwork(false);
                    LocalEngineService.stop(ctx);
                    emit();
                }
            }
        }, "local-engine-watch");
        t.setDaemon(true);
        t.start();
    }

    private static String tailOf(LocalEngineProcess p) {
        List<String> t = p.tail();
        int from = Math.max(0, t.size() - 8);
        return String.join(" | ", t.subList(from, t.size()));
    }

    /** PRoot processes of ours that no LocalEngineProcess owns (the app process died and came back): two engines on one state.db would corrupt it. */
    private void sweepOrphans() {
        String launcher = paths.lib(LocalEnginePaths.LAUNCHER);
        int me = android.os.Process.myPid();
        LocalEngineProcess cur = proc;
        String[] ids = new File("/proc").list();
        if (ids == null) return;
        for (String id : ids) {
            if (id.isEmpty() || !Character.isDigit(id.charAt(0))) continue;
            int pid;
            try { pid = Integer.parseInt(id); } catch (NumberFormatException e) { continue; }
            if (pid == me) continue;
            String cmd = LocalEnginePaths.readSmall("/proc/" + id + "/cmdline");
            if (cmd == null || !cmd.startsWith(launcher + "\0")) continue;
            if (cur != null && cur.alive()) continue; // ours and alive: not an orphan
            Log.w(TAG, "killing orphaned launcher pid=" + pid);
            for (int k : LocalEngineProcess.childrenOf(pid)) {
                try { Os.kill(k, OsConstants.SIGTERM); } catch (Exception ignored) {}
            }
            try { Thread.sleep(1500); } catch (InterruptedException ignored) {}
            try { Os.kill(pid, OsConstants.SIGKILL); } catch (Exception ignored) {}
        }
    }

    private void idleCheck() {
        try {
            LocalEngineProcess p = proc;
            if (p == null || !"running".equals(engineState)) return;
            if (inFlight.get() > 0) return;
            if (System.currentTimeMillis() - lastActive < IDLE_MS) return;
            int active = activeRuns(p);
            if (active != 0) { // a run is going (or we could not tell): keep it, look again next minute
                if (active > 0) lastActive = System.currentTimeMillis();
                return;
            }
            stopEngine("idle");
        } catch (RuntimeException e) {
            Log.w(TAG, "idle check " + e);
        }
    }

    /** activeRuns from /health (phone mode); -1 when unknown. */
    private int activeRuns(LocalEngineProcess p) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + p.port + "/health").openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(5000);
            int st = c.getResponseCode();
            if (st != 200) return -1;
            byte[] b = new byte[4096];
            int n = 0;
            try (java.io.InputStream in = c.getInputStream()) {
                for (int r; n < b.length && (r = in.read(b, n, b.length - n)) > 0; ) n += r;
            }
            JSONObject o = new JSONObject(new String(b, 0, n, java.nio.charset.StandardCharsets.UTF_8));
            return o.has("activeRuns") ? o.optInt("activeRuns", -1) : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    /** resolv.conf follows the phone's network while the engine runs. */
    private void watchNetwork(boolean on) {
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        try {
            if (on && netCb == null) {
                netCb = new ConnectivityManager.NetworkCallback() {
                    @Override public void onLinkPropertiesChanged(Network network, LinkProperties lp) { paths.writeResolvConf(); }
                    @Override public void onAvailable(Network network) { paths.writeResolvConf(); }
                };
                cm.registerDefaultNetworkCallback(netCb);
            } else if (!on && netCb != null) {
                cm.unregisterNetworkCallback(netCb);
                netCb = null;
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "network callback " + e);
        }
    }

    /** --link2symlink default (see LocalEnginePaths); debuggable builds may flip it for the l2s comparison. */
    public boolean setLink2symlink(boolean on) {
        if (!debuggable) return false;
        LocalEnginePaths.link2symlink = on;
        return true;
    }

    /** Runs one shell command inside the environment (debuggable builds only: the l2s comparison and test benches). */
    public String debugShell(String cmd, int timeoutSec) throws Exception {
        if (!debuggable) throw new IllegalStateException("debug only");
        paths.prepareRootfs();
        ProcessBuilder pb = new ProcessBuilder(paths.prootArgv("/root/workspace", paths.engineBinds(), java.util.Arrays.asList("/bin/bash", "-lc", cmd)));
        pb.environment().clear();
        pb.environment().putAll(paths.prootEnv());
        pb.redirectErrorStream(true);
        pb.directory(paths.base);
        Process p = pb.start();
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        Thread rd = new Thread(() -> {
            try (java.io.InputStream in = p.getInputStream()) {
                byte[] b = new byte[8192];
                for (int r; (r = in.read(b)) > 0; ) { synchronized (out) { if (out.size() < (256 << 10)) out.write(b, 0, r); } }
            } catch (Exception ignored) {}
        });
        rd.start();
        boolean finished = p.waitFor(timeoutSec, TimeUnit.SECONDS);
        if (!finished) {
            for (int k : LocalEngineProcess.childrenOf(LocalEngineProcess.pidOf(p))) try { Os.kill(k, OsConstants.SIGKILL); } catch (Exception ignored) {}
            p.destroyForcibly();
        }
        rd.join(3000);
        synchronized (out) {
            return (finished ? "exit=" + p.exitValue() : "TIMEOUT") + "\n" + out.toString("UTF-8");
        }
    }

    static String abiList() { return String.join(",", Build.SUPPORTED_ABIS); }

    static List<String> empty() { return new ArrayList<>(); }
}
