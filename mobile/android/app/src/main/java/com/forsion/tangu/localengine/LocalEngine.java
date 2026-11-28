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
import java.util.concurrent.atomic.AtomicLong;

/**
 * The "This phone" local engine: environment install state + one engine process. Process-wide singleton; the plugin,
 * the relay and the foreground service all talk to it.
 *
 * Starting: only an explicit start (the page picked this phone) or a write request starts the engine; GET / HEAD use a
 * running engine or wait for a start already under way, never start one (not after Stop, not after a crash). Health =
 * the port the engine reported binding answers /health and an authed call that only this start's token can pass. A
 * start that exits before it is healthy is a crash whatever the exit code (a glibc double free exited 0 in the
 * probes); one automatic retry, then "failed".
 *
 * Accounts: engine data is per Forsion account (LocalEnginePaths.accountKey). Signed out = no start; another account
 * signing in stops the engine of the previous one, and the relay only hands out the engine of the signed-in account.
 *
 * Maintenance: while an install / update / reset swaps trees or a remove deletes them, nothing can start the engine.
 *
 * Stopping: the notification's Stop, the page, or idle — no active run (engine /health activeRuns), no relayed request
 * in flight, and no non-GET request for 10 minutes; rechecked under the lifecycle lock right before stopping.
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
    /**
     * Every snapshot (a call's reply or a change event) takes the next number while it is captured under snapLock, so
     * a higher number always means a later capture. The page drops a snapshot older than one it already has: a reply
     * (pause() answers with the state from before the download thread noticed) can reach it after the change event
     * that superseded it, and would otherwise put the row back to "downloading" for good. Listeners are called
     * outside the lock; delivery order does not matter because of the numbers. Nothing under snapLock takes another
     * lock (installerFor() is taken before it: resume() emits while holding this).
     */
    private final AtomicLong seq = new AtomicLong();
    private final Object snapLock = new Object();
    /** Held for a whole start / stop / swap entry. */
    private final Object startLock = new Object();
    /** Short: guards proc / procAccount together with the in-flight count (acquire registers atomically; idle stop checks atomically). */
    private final Object regLock = new Object();
    private final AtomicInteger inFlight = new AtomicInteger();
    /** true while trees are swapped or deleted: starts are refused. */
    private volatile boolean maintenance;

    // install state
    private volatile String phase = "idle";      // idle | downloading | paused | unpacking | checking | failed
    /** The operation a pause / failure interrupted (install | reset | update): resume / retry repeats it. */
    private volatile String op;
    private volatile String failCode;
    private volatile String layer;
    private volatile long done, total;
    private volatile LocalEngineInstaller installer;
    private volatile LocalEngineInstaller.Manifest manifest;
    private volatile String manifestOverride;

    // engine state
    private volatile LocalEngineProcess proc;
    /** The account whose data proc runs on (set together with proc under regLock). */
    private volatile String procAccount;
    private volatile String engineState = "stopped"; // stopped | starting | running | failed
    private volatile String engineFail;
    private volatile long lastActive;
    private ConnectivityManager.NetworkCallback netCb;
    private final android.content.SharedPreferences.OnSharedPreferenceChangeListener tokenListener = (prefs, key) -> {
        if (key == null || com.forsion.tangu.NativeConfigAccess.isTokenKey(key)) timer.execute(this::onAccountChange);
    };

    private LocalEngine(Context c) {
        ctx = c;
        paths = new LocalEnginePaths(c);
        debuggable = (c.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        installerFor().recover(); // renames only; before anything reads installed() or starts the engine
        new File(paths.base, "home/.forsion-cloud-token").delete(); // early test builds kept the account token in a flat home
        work.execute(() -> {
            installerFor().emptyTrash();
            LocalEnginePaths.deleteTree(paths.selftest); // a self-test the app died in the middle of
        });
        com.forsion.tangu.NativeConfigAccess.onTokenChange(c, tokenListener);
        timer.scheduleWithFixedDelay(this::idleCheck, 60, 60, TimeUnit.SECONDS);
    }

    /** The signed-in account (directory key), or null when signed out. */
    String currentAccount() { return LocalEnginePaths.accountKey(com.forsion.tangu.NativeConfigAccess.token(ctx)); }

    /**
     * Sign-out or another account: the running engine belongs to the previous one. Same account (token refresh): pass
     * the new token on. Decided under the lifecycle lock against the process that is current then (a start under way
     * rechecks the account itself before publishing its process).
     */
    private void onAccountChange() {
        synchronized (startLock) {
            String running = procAccount;
            if (proc == null || running == null) return;
            if (running.equals(currentAccount())) writeCloudToken(running);
            else stopLocked("account");
        }
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
        LocalEngineInstaller ins = installerFor();
        synchronized (snapLock) {
            return snapshot(ins, seq.incrementAndGet());
        }
    }

    private JSONObject snapshot(LocalEngineInstaller ins, long q) {
        JSONObject o = new JSONObject();
        try {
            o.put("seq", q);
            o.put("available", available());
            o.put("configured", !manifestUrl().isEmpty());
            JSONObject inst = ins.installed();
            o.put("installed", inst != null);
            if (inst != null) {
                o.put("baseVersion", inst.getJSONObject("base").optString("version"));
                o.put("engineVersion", inst.getJSONObject("engine").optString("version"));
            }
            o.put("phase", phase);
            if (op != null) o.put("op", op);
            o.put("signedIn", currentAccount() != null);
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
                o.put("resumeBytes", ins.downloadedBytes(m));
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

    /** Disk use of the environment, the signed-in account's engine home and workspace (walks the trees: call off the main thread). */
    public JSONObject usage() {
        JSONObject o = new JSONObject();
        try {
            String acct = currentAccount();
            o.put("environment", LocalEnginePaths.treeBytes(paths.rootfs));
            o.put("home", acct == null ? 0 : LocalEnginePaths.treeBytes(paths.home(acct)));
            o.put("workspace", acct == null ? 0 : LocalEnginePaths.treeBytes(paths.workspace(acct)));
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

    /**
     * Continues the operation a pause or failure interrupted (a paused reset stays a reset). Claimed at once: a second
     * tap while it is queued or running is ignored instead of turning into another operation.
     */
    public synchronized void resume() {
        if (!"paused".equals(phase) && !"failed".equals(phase)) return;
        String o = op != null ? op : (installerFor().installed() == null ? "install" : "update");
        op = o;
        phase = "downloading";
        emit();
        work.execute(() -> runInstall(o));
    }

    private void runInstall(String kind) {
        LocalEngineInstaller ins = installerFor();
        op = kind;
        failCode = null;
        try {
            if (!available()) throw new LocalEngineInstaller.Failure("unsupported", null);
            setPhase("downloading");
            if (manifest == null) check();
            LocalEngineInstaller.Manifest m = manifest;
            JSONObject inst = ins.installed();
            LocalEngineInstaller.Listener l = (ph, ly, d, t) -> {
                phase = ph; layer = ly; done = d; total = t;
                emit();
            };
            // the engine keeps running while downloading / unpacking; it stops only for the swap
            LocalEngineInstaller.Swap swap = new LocalEngineInstaller.Swap() {
                @Override public void enter() { enterMaintenance(kind); }

                @Override public String validate() { return selfTest(); }
            };
            if (kind.equals("update") && inst != null) ins.updateEngine(m, inst, l, swap);
            else ins.installFresh(m, l, swap);
            layer = null;
            op = null;
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
        } finally {
            maintenance = false;
            emit();
        }
        ins.emptyTrash();
    }

    /** Stops the engine and refuses starts until the current install / remove is done (cleared in its finally). */
    private void enterMaintenance(String why) {
        synchronized (startLock) {
            maintenance = true;
            stopLocked(why);
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
            try {
                enterMaintenance("remove");
                installerFor().removeEnvironment();
                failCode = null;
                layer = null;
                op = null;
                done = total = 0;
            } finally {
                maintenance = false;
            }
            setPhase("idle");
        });
    }

    private void setPhase(String p) {
        phase = p;
        emit();
    }

    /**
     * Upper bound for the whole self-test: every attempt's start, health wait and auth probes share it (threaded
     * through as one deadline); only the stop of the last attempt (at most ~6 s) comes on top.
     */
    static final int SELFTEST_MS = 150_000;

    /**
     * The tree now at rootfs, run the way a real start runs it: the engine is started for real (PRoot + loader + glibc
     * Node + SQLite + the engine's own boot), --port 0, port from its ready line, /health, then an authed call that
     * only this start's local token passes (200) and the same call with a wrong token (401) — then stopped. null = fine.
     *
     * Its data is a throwaway tree (LocalEnginePaths.selftest), never an account's home: no account token, no
     * conversations, deleted afterwards whatever happened. Bounded by SELFTEST_MS. A crash before healthy gets the
     * same one retry as a normal start (the emulator's glibc double free would otherwise refuse good layers); a
     * timeout does not (an engine that never reports its port fails here, before it can be committed).
     * Runs on the install thread while maintenance blocks starts, so no account engine runs alongside it. Under the
     * foreground service like a real start: without it Doze cuts loopback a couple of minutes after the screen goes
     * off, and a good layer would be refused.
     */
    private String selfTest() {
        long deadline = System.currentTimeMillis() + SELFTEST_MS;
        String why = "timeout";
        String tail = "";
        LocalEngineService.start(ctx);
        try {
            for (int attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) break;
                LocalEnginePaths.deleteTree(paths.selftest);
                LocalEngineProcess np = LocalEngineProcess.spawn(paths, paths.selftestBinds(), engineEnv());
                try {
                    why = np.awaitHealthy((int) Math.min(LocalEngineProcess.HEALTH_TIMEOUT_MS, left));
                    if (why == null && !ownsPort(np, remaining(deadline, OWNS_PORT_MS))) why = "auth";
                    if (why == null && np.status(AUTHED_PATH, "x" + np.token, remaining(deadline, OWNS_PORT_MS)) != 401) why = "auth_open";
                } finally {
                    np.stop();
                }
                if (why == null) {
                    Log.i(TAG, "self-test passed on attempt " + attempt + " in " + (System.currentTimeMillis() - np.startedAt) + "ms");
                    return null;
                }
                tail = tailOf(np);
                Log.w(TAG, "self-test attempt " + attempt + " failed: " + why + " tail=" + tail);
                if (!"exited".equals(why)) break;
            }
            return tail.isEmpty() ? why : why + " | " + tail;
        } catch (Exception e) {
            return e.getClass().getSimpleName();
        } finally {
            LocalEnginePaths.deleteTree(paths.selftest);
            LocalEngineService.stop(ctx); // maintenance blocks starts: no account engine needs it now
        }
    }

    /** What is left of the deadline, capped at cap; at least 1 ms (a probe then fails at once instead of waiting). */
    private static int remaining(long deadline, int cap) {
        return (int) Math.max(1, Math.min(cap, deadline - System.currentTimeMillis()));
    }

    // ---------- engine ----------

    public boolean running() {
        LocalEngineProcess p = proc;
        return p != null && p.alive() && "running".equals(engineState);
    }

    /**
     * For the relay: the running engine of the signed-in account with one request registered as in flight (the
     * caller ends it with requestEnded()), or null. Only writes may start the engine; GET / HEAD use a running one
     * or wait for a start already under way.
     */
    LocalEngineProcess acquire(boolean write) {
        if (currentAccount() == null) return null;
        LocalEngineProcess p = register(write);
        if (p != null) return p;
        if (write) {
            try { ensureRunning(); } catch (Exception e) { return null; }
        } else {
            if (!"starting".equals(engineState)) return null;
            synchronized (startLock) { /* wait for the start under way */ }
        }
        return register(write);
    }

    /** Hands out the current process only if it runs for the account signed in right now (read at this moment, not earlier). */
    private LocalEngineProcess register(boolean write) {
        String acct = currentAccount();
        if (acct == null) return null;
        synchronized (regLock) {
            LocalEngineProcess p = proc;
            if (p == null || !p.alive() || !"running".equals(engineState) || !acct.equals(procAccount)) return null;
            inFlight.incrementAndGet();
            if (write) lastActive = System.currentTimeMillis();
            return p;
        }
    }

    /** For the relay: token of the engine (port into port[0]) with the request registered, or null. See acquire. */
    public String acquireEndpoint(boolean write, int[] port) {
        LocalEngineProcess p = acquire(write);
        if (p == null) return null;
        String acct = procAccount;
        if (acct != null) writeCloudToken(acct); // a refreshed token reaches the engine's token file without a restart
        port[0] = p.port;
        return p.token;
    }

    /** Pairs with a non-null acquireEndpoint. Only write requests and runs count as activity: ending a GET poll must not keep the engine up. */
    public void requestEnded() { inFlight.decrementAndGet(); }

    /** Starts the engine for the signed-in account if needed and waits until it is healthy. Blocking (relay / plugin threads). */
    public LocalEngineProcess ensureRunning() throws Exception {
        synchronized (startLock) {
            String acct = currentAccount();
            LocalEngineProcess p = proc;
            if (p != null && p.alive() && "running".equals(engineState) && acct != null && acct.equals(procAccount)) {
                lastActive = System.currentTimeMillis();
                return p;
            }
            if (!available()) throw new IllegalStateException("unsupported");
            if (maintenance) throw new IllegalStateException("maintenance");
            if (acct == null) throw new IllegalStateException("signed_out");
            if (installerFor().installed() == null) throw new IllegalStateException("not_installed");
            if (p != null) stopLocked("account"); // the previous account's engine
            engineFail = null;
            engineState = "starting";
            emit();
            try {
                paths.prepareRootfs();
                writeCloudToken(acct);
                sweepOrphans();
                LocalEngineService.start(ctx);
                String why = "unknown";
                for (int attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
                    LocalEngineProcess np = LocalEngineProcess.spawn(paths, paths.engineBinds(acct), engineEnv());
                    why = np.awaitHealthy(LocalEngineProcess.HEALTH_TIMEOUT_MS);
                    if (why == null && !ownsPort(np)) why = "foreign";
                    if (why == null) {
                        synchronized (regLock) {
                            proc = np;
                            procAccount = acct;
                            engineState = "running";
                            lastActive = System.currentTimeMillis();
                        }
                        watch(np);
                        watchNetwork(true);
                        if (!acct.equals(currentAccount())) { // the account changed while it was starting
                            stopLocked("account");
                            throw new IllegalStateException("account_changed");
                        }
                        emit();
                        Log.i(TAG, "engine ready on attempt " + attempt + " in " + (System.currentTimeMillis() - np.startedAt) + "ms");
                        return np;
                    }
                    Log.w(TAG, "engine start attempt " + attempt + " failed: " + why + " tail=" + tailOf(np));
                    np.stop();
                }
                engineFail = why;
            } catch (IllegalStateException e) {
                if ("account_changed".equals(e.getMessage())) throw e; // stopped, not failed
                engineFail = e.getClass().getSimpleName();
            } catch (Exception e) {
                engineFail = e.getClass().getSimpleName();
            }
            engineState = "failed";
            LocalEngineService.stop(ctx);
            emit();
            throw new IllegalStateException("start_failed:" + engineFail);
        }
    }

    public void stopEngine(String why) {
        synchronized (startLock) {
            stopLocked(why);
        }
    }

    /** Caller holds startLock. */
    private void stopLocked(String why) {
        LocalEngineProcess p;
        synchronized (regLock) {
            p = proc;
            proc = null;
            procAccount = null;
        }
        finishStop(p, why);
    }

    /** Caller holds startLock and has already detached p (proc / procAccount cleared under regLock). */
    private void finishStop(LocalEngineProcess p, String why) {
        if (p != null) {
            Log.i(TAG, "stopping engine (" + why + ")");
            p.stop();
        }
        if (!"failed".equals(engineState)) engineState = "stopped";
        watchNetwork(false);
        LocalEngineService.stop(ctx);
        emit();
    }

    private Map<String, String> engineEnv() {
        Map<String, String> env = new HashMap<>();
        String api = com.forsion.tangu.NativeConfigAccess.apiBase(ctx);
        if (api != null && api.endsWith("/api")) env.put("TANGU_CLOUD_URL", api.substring(0, api.length() - 4));
        env.put("TANGU_TOKEN_FILE", LocalEnginePaths.GUEST_TOKEN_FILE);
        String ver = BuildConfig.VERSION_NAME == null ? "" : BuildConfig.VERSION_NAME;
        if (ver.matches("[A-Za-z0-9._-]{1,32}")) env.put("TANGU_HOST_CLIENT", "mobile/" + ver);
        return env;
    }

    /**
     * The account token the engine uses for models / cloud features (never as its local credential: TANGU_PHONE).
     * Written only while that account is the signed-in one; otherwise emptied (and the engine is stopped elsewhere).
     */
    private final Object tokenLock = new Object();

    void writeCloudToken(String account) {
        synchronized (tokenLock) { writeCloudTokenLocked(account); }
    }

    private void writeCloudTokenLocked(String account) {
        String tok = com.forsion.tangu.NativeConfigAccess.token(ctx);
        if (!account.equals(LocalEnginePaths.accountKey(tok))) tok = null;
        File dir = paths.secretDir(account);
        File f = new File(dir, "cloud-token");
        try {
            dir.mkdirs();
            Os.chmod(dir.getPath(), 0700);
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
    private boolean ownsPort(LocalEngineProcess p) { return ownsPort(p, OWNS_PORT_MS); }

    /** Raw socket, no redirects followed (a 302 to the open /health is not an authed 200), bounded by timeoutMs overall. */
    private static boolean ownsPort(LocalEngineProcess p, int timeoutMs) {
        int st = p.status(AUTHED_PATH, p.token, timeoutMs);
        if (st != 200) Log.w(TAG, "ownsPort: status " + st);
        return st == 200;
    }

    private static final String AUTHED_PATH = "/agent/sessions?limit=1";
    private static final int OWNS_PORT_MS = 13_000;

    private void watch(LocalEngineProcess p) {
        Thread t = new Thread(() -> {
            try { p.waitFor(); } catch (InterruptedException ignored) {}
            synchronized (startLock) {
                if (proc == p) {
                    // exited on its own (crash, killed by the system): the running turn shows as interrupted, like a
                    // desktop restart. Passive reads do not bring it back; the next write or an explicit start does.
                    Log.w(TAG, "engine exited unexpectedly; tail=" + tailOf(p));
                    synchronized (regLock) {
                        proc = null;
                        procAccount = null;
                    }
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
            synchronized (startLock) {
                // recheck and detach in one step: a request may have arrived during the probe, or Stop / Start replaced
                // the process; once detached here, register() can no longer hand it out
                synchronized (regLock) {
                    if (proc != p || inFlight.get() > 0 || System.currentTimeMillis() - lastActive < IDLE_MS) return;
                    proc = null;
                    procAccount = null;
                }
                finishStop(p, "idle");
            }
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
        String acct = currentAccount();
        ProcessBuilder pb = new ProcessBuilder(paths.prootArgv("/root/workspace", acct == null ? null : paths.engineBinds(acct), java.util.Arrays.asList("/bin/bash", "-lc", cmd)));
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
