package com.forsion.tangu.localengine;

import android.system.Os;
import android.system.OsConstants;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * One run of the Tangu engine inside PRoot: the engine binds an ephemeral loopback port itself (--port 0) and reports
 * it on its machine-readable ready line (TANGU_READY_LINE=1 → "TANGU_READY {json}", tangu-agent
 * standalone/readyLine.ts), read here from its own stdout — no port is picked here and released for the child to
 * take later, so nothing else can grab it in between and receive the token. The human-readable startup lines are
 * never parsed: rewording them cannot break starts. A fresh local token per start
 * (native-only), health check, stop. What the probes taught (probe-apk/REPORT.md):
 *  - PRoot ignores SIGTERM, and Process.destroy() sends SIGTERM: stop by SIGTERM to the guest (node), then SIGKILL PRoot.
 *  - Exit codes lie: after a glibc "double free" the engine exited with 0. Any exit before /health answered counts as a
 *    crash, whatever the code.
 *  - /health over a raw socket: not subject to the network security config, so it works even before the relay can.
 */
final class LocalEngineProcess {
    private static final String TAG = "LocalEngine";
    static final int HEALTH_TIMEOUT_MS = 90_000;
    private static final int LOG_LINES = 200;

    /** 0 until the engine has printed the port it bound. */
    volatile int port;
    final String token;
    final long startedAt;
    private final Process process;
    private final int prootPid;
    private final Deque<String> tail = new ArrayDeque<>();
    private volatile boolean stopping;

    /** Asks the engine for its ready line; READY_PREFIX starts it. Both must match tangu-agent standalone/readyLine.ts (LocalEngineProcessTest checks). */
    static final String READY_ENV = "TANGU_READY_LINE";
    static final String READY_PREFIX = "TANGU_READY ";

    /**
     * The port from the engine's ready line, or 0 when the line is not one: the prefix, then exactly one JSON object
     * and nothing after it (Android's JSONObject(String) would accept trailing text), with an integer port in 1..65535.
     */
    static int parseReadyLine(String line) {
        if (line == null || !line.startsWith(READY_PREFIX)) return 0;
        String payload = line.substring(READY_PREFIX.length());
        if (payload.isEmpty() || payload.charAt(0) != '{') return 0;
        try {
            org.json.JSONTokener t = new org.json.JSONTokener(payload);
            Object o = t.nextValue();
            if (!(o instanceof org.json.JSONObject) || t.more()) return 0;
            Object p = ((org.json.JSONObject) o).opt("port");
            if (!(p instanceof Integer)) return 0; // 1.5, "123", a long: not a port
            int v = (Integer) p;
            return v > 0 && v < 65536 ? v : 0;
        } catch (org.json.JSONException e) {
            return 0;
        }
    }

    /** Bytes kept of one output line; the rest of a longer line is drained and dropped (a layer that never prints a newline cannot exhaust the heap). */
    static final int MAX_LINE_BYTES = 8192;

    private LocalEngineProcess(Process p, String token) {
        this.process = p;
        this.token = token;
        this.startedAt = System.currentTimeMillis();
        this.prootPid = pidOf(p);
        Thread pump = new Thread(this::pump, "local-engine-log");
        pump.setDaemon(true);
        pump.start();
    }

    /** Starts PRoot + node. Does not wait for health; call {@link #awaitHealthy}. */
    static LocalEngineProcess spawn(LocalEnginePaths paths, List<String> binds, Map<String, String> extraEnv) throws IOException {
        String token = newToken();
        Map<String, String> env = paths.prootEnv();
        env.put("TANGU_HOME", "/root/.tangu");
        env.put("TANGU_LOCAL_TOKEN", token);
        env.put("TANGU_SANDBOX", "none");
        env.put("TANGU_PHONE", "1");
        env.put("TANGU_BROWSER_EXTENSION", "0");
        env.put("NODE_ENV", "production");
        if (extraEnv != null) env.putAll(extraEnv);
        env.put(READY_ENV, "1"); // after extraEnv: the port comes from nowhere else
        List<String> argv = paths.prootArgv("/opt/tangu", binds,
                java.util.Arrays.asList("/opt/node/bin/node", "dist/standalone/main.js", "--port", "0", "--host", "127.0.0.1"));
        ProcessBuilder pb = new ProcessBuilder(argv);
        pb.environment().clear();
        pb.environment().putAll(env);
        pb.redirectErrorStream(true);
        pb.directory(paths.base);
        Process p = pb.start();
        Log.i(TAG, "spawned proot pid=" + pidOf(p));
        return new LocalEngineProcess(p, token);
    }

    /**
     * Polls /health until it answers 200 or the process is gone. Returns null when healthy, otherwise why not
     * ("exited" = crashed before ready; "timeout").
     */
    String awaitHealthy(int timeoutMs) {
        long t0 = System.nanoTime();
        while ((System.nanoTime() - t0) / 1_000_000 < timeoutMs) {
            if (!process.isAlive()) return "exited";
            if (port > 0 && health(500) == 200) return null;
            try { Thread.sleep(250); } catch (InterruptedException e) { return "interrupted"; }
        }
        return "timeout";
    }

    boolean alive() { return !stopping && process.isAlive(); }

    /** GET /health over a raw socket; -1 when unreachable. */
    int health(int timeoutMs) { return status(port, "/health", null, timeoutMs); }

    /** GET path on this engine with a bearer token; see {@link #status(int, String, String, int)}. */
    int status(String path, String bearer, int timeoutMs) { return status(port, path, bearer, timeoutMs); }

    /**
     * GET path on 127.0.0.1:port over a raw socket (optionally with a bearer token): the response's status code, or
     * -1. Never follows redirects — a 302 to /health must not pass for an authed 200 — and bounded by timeoutMs
     * overall, however slowly the other side drips its status line. Only the status line is read.
     */
    static int status(int port, String path, String bearer, int timeoutMs) {
        if (port <= 0) return -1;
        long end = System.nanoTime() + Math.max(1, timeoutMs) * 1_000_000L;
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), (int) Math.max(1, Math.min(3000, timeoutMs)));
            OutputStream o = s.getOutputStream();
            o.write(("GET " + path + " HTTP/1.0\r\nHost: 127.0.0.1:" + port + "\r\n"
                    + (bearer == null ? "" : "Authorization: Bearer " + bearer + "\r\n")
                    + "Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            o.flush();
            InputStream in = s.getInputStream();
            byte[] buf = new byte[12]; // "HTTP/1.1 200"
            int n = 0;
            while (n < buf.length) {
                long left = (end - System.nanoTime()) / 1_000_000L;
                if (left <= 0) return -1;
                s.setSoTimeout((int) Math.max(1, Math.min(1000, left)));
                int r;
                try { r = in.read(buf, n, buf.length - n); } catch (SocketTimeoutException slow) { continue; }
                if (r < 0) return -1;
                n += r;
            }
            String line = new String(buf, StandardCharsets.US_ASCII);
            if (!line.startsWith("HTTP/1.")) return -1;
            return Integer.parseInt(line.substring(9, 12));
        } catch (Exception e) {
            return -1;
        }
    }

    /** Waits for the process to end (any reason). */
    void waitFor() throws InterruptedException { process.waitFor(); }

    /** SIGTERM to node (the engine shuts down cleanly), PRoot follows; SIGKILL PRoot after 4 s. */
    void stop() {
        stopping = true;
        List<Integer> kids = childrenOf(prootPid);
        for (int k : kids) {
            try { Os.kill(k, OsConstants.SIGTERM); } catch (Exception e) { Log.w(TAG, "TERM " + k + " " + e); }
        }
        boolean exited = false;
        try { exited = process.waitFor(4, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
        if (!exited && prootPid > 0) {
            try { Os.kill(prootPid, OsConstants.SIGKILL); } catch (Exception e) { Log.w(TAG, "KILL " + prootPid + " " + e); }
            try { process.waitFor(2, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
        }
        Log.i(TAG, "stopped (graceful=" + exited + ")");
    }

    /** Last lines the engine printed (diagnostics for the failure view; never contains the token). */
    synchronized List<String> tail() { return new ArrayList<>(tail); }

    private void pump() {
        try (InputStream in = process.getInputStream()) {
            readLines(in, token, this::onLine);
        } catch (IOException ignored) {
        }
    }

    interface LineSink { void line(String line, boolean cut); }

    /**
     * Splits a stream into lines (\n, a trailing \r dropped) keeping at most MAX_LINE_BYTES of each; the rest of a
     * longer line is read and dropped, and the line is reported as cut (its end shortened by the token's length, so a
     * token split at the cut cannot survive redaction). Lines are redacted (token → ***) before they are handed on.
     */
    static void readLines(InputStream in, String token, LineSink sink) throws IOException {
        java.io.ByteArrayOutputStream line = new java.io.ByteArrayOutputStream();
        boolean cut = false;
        byte[] buf = new byte[4096];
        for (int r; (r = in.read(buf)) >= 0; ) {
            for (int i = 0; i < r; i++) {
                byte b = buf[i];
                if (b == '\n') {
                    emit(line, cut, token, sink);
                    line.reset();
                    cut = false;
                } else if (line.size() < MAX_LINE_BYTES) {
                    line.write(b);
                } else {
                    cut = true;
                }
            }
        }
        if (line.size() > 0 || cut) emit(line, cut, token, sink);
    }

    private static void emit(java.io.ByteArrayOutputStream raw, boolean cut, String token, LineSink sink) {
        String line = new String(raw.toByteArray(), StandardCharsets.UTF_8);
        if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
        boolean hasToken = token != null && !token.isEmpty();
        if (cut) line = line.substring(0, Math.max(0, line.length() - (hasToken ? token.length() : 0))) + " …";
        if (hasToken) line = line.replace(token, "***");
        sink.line(line, cut);
    }

    private void onLine(String line, boolean cut) {
        if (port == 0 && !cut) {
            int p = parseReadyLine(line);
            if (p > 0) port = p; // the first ready line only: nothing later can move the port
        }
        synchronized (this) {
            tail.addLast(line);
            while (tail.size() > LOG_LINES) tail.removeFirst();
        }
        Log.i(TAG, "engine> " + line);
    }

    static String newToken() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static int pidOf(Process p) {
        try {
            java.lang.reflect.Field f = p.getClass().getDeclaredField("pid");
            f.setAccessible(true);
            return f.getInt(p);
        } catch (Throwable ignored) {
        }
        String s = p.toString();
        int i = s.indexOf("pid=");
        if (i >= 0) {
            int j = i + 4;
            while (j < s.length() && Character.isDigit(s.charAt(j))) j++;
            try { return Integer.parseInt(s.substring(i + 4, j)); } catch (NumberFormatException ignored) {}
        }
        return -1;
    }

    static List<Integer> childrenOf(int pid) {
        List<Integer> out = new ArrayList<>();
        if (pid <= 0) return out;
        String[] ids = new File("/proc").list();
        if (ids == null) return out;
        for (String id : ids) {
            if (id.isEmpty() || !Character.isDigit(id.charAt(0))) continue;
            String st = LocalEnginePaths.readSmall("/proc/" + id + "/stat");
            if (st == null) continue;
            int rp = st.lastIndexOf(')');
            if (rp < 0 || rp + 2 >= st.length()) continue;
            String[] f = st.substring(rp + 2).split(" ");
            try { if (f.length > 1 && Integer.parseInt(f[1]) == pid) out.add(Integer.parseInt(id)); } catch (Exception ignored) {}
        }
        return out;
    }
}
