package com.forsion.tangu.localengine;

import android.system.Os;
import android.system.OsConstants;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * One run of the Tangu engine inside PRoot: random loopback port, a fresh local token per start (native-only),
 * health check, stop. What the probes taught (probe-apk/REPORT.md):
 *  - PRoot ignores SIGTERM, and Process.destroy() sends SIGTERM: stop by SIGTERM to the guest (node), then SIGKILL PRoot.
 *  - Exit codes lie: after a glibc "double free" the engine exited with 0. Any exit before /health answered counts as a
 *    crash, whatever the code.
 *  - /health over a raw socket: not subject to the network security config, so it works even before the relay can.
 */
final class LocalEngineProcess {
    private static final String TAG = "LocalEngine";
    static final int HEALTH_TIMEOUT_MS = 90_000;
    private static final int LOG_LINES = 200;

    final int port;
    final String token;
    final long startedAt;
    private final Process process;
    private final int prootPid;
    private final Deque<String> tail = new ArrayDeque<>();
    private volatile boolean stopping;

    private LocalEngineProcess(Process p, int port, String token) {
        this.process = p;
        this.port = port;
        this.token = token;
        this.startedAt = System.currentTimeMillis();
        this.prootPid = pidOf(p);
        Thread pump = new Thread(this::pump, "local-engine-log");
        pump.setDaemon(true);
        pump.start();
    }

    /** Starts PRoot + node. Does not wait for health; call {@link #awaitHealthy}. */
    static LocalEngineProcess spawn(LocalEnginePaths paths, Map<String, String> extraEnv) throws IOException {
        int port = freePort();
        String token = newToken();
        Map<String, String> env = paths.prootEnv();
        env.put("TANGU_HOME", "/root/.tangu");
        env.put("TANGU_LOCAL_TOKEN", token);
        env.put("TANGU_SANDBOX", "none");
        env.put("TANGU_PHONE", "1");
        env.put("TANGU_BROWSER_EXTENSION", "0");
        env.put("NODE_ENV", "production");
        if (extraEnv != null) env.putAll(extraEnv);
        List<String> argv = paths.prootArgv("/opt/tangu", paths.engineBinds(),
                java.util.Arrays.asList("/opt/node/bin/node", "dist/standalone/main.js", "--port", String.valueOf(port), "--host", "127.0.0.1"));
        ProcessBuilder pb = new ProcessBuilder(argv);
        pb.environment().clear();
        pb.environment().putAll(env);
        pb.redirectErrorStream(true);
        pb.directory(paths.base);
        Process p = pb.start();
        Log.i(TAG, "spawned proot pid=" + pidOf(p) + " port=" + port);
        return new LocalEngineProcess(p, port, token);
    }

    /**
     * Polls /health until it answers 200 or the process is gone. Returns null when healthy, otherwise why not
     * ("exited" = crashed before ready; "timeout").
     */
    String awaitHealthy(int timeoutMs) {
        long t0 = System.nanoTime();
        while ((System.nanoTime() - t0) / 1_000_000 < timeoutMs) {
            if (!process.isAlive()) return "exited";
            if (health(500) == 200) return null;
            try { Thread.sleep(250); } catch (InterruptedException e) { return "interrupted"; }
        }
        return "timeout";
    }

    boolean alive() { return !stopping && process.isAlive(); }

    /** GET /health over a raw socket; -1 when unreachable. */
    int health(int timeoutMs) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), timeoutMs);
            s.setSoTimeout(timeoutMs);
            OutputStream o = s.getOutputStream();
            o.write(("GET /health HTTP/1.0\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            o.flush();
            byte[] buf = new byte[64];
            int n = s.getInputStream().read(buf);
            if (n < 12) return -1;
            String line = new String(buf, 0, n, StandardCharsets.US_ASCII);
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
        try (BufferedReader br = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                if (token != null && !token.isEmpty()) line = line.replace(token, "***");
                synchronized (this) {
                    tail.addLast(line);
                    while (tail.size() > LOG_LINES) tail.removeFirst();
                }
                Log.i(TAG, "engine> " + line);
            }
        } catch (IOException ignored) {
        }
    }

    static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return s.getLocalPort();
        }
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
