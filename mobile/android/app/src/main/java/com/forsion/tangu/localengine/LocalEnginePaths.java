package com.forsion.tangu.localengine;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.os.Build;
import android.os.SystemClock;
import android.system.Os;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Where everything lives, and how PRoot is invoked.
 *
 *   files/local-engine/rootfs        the environment (Ubuntu + Node + engine). Update / reset / delete touch only this.
 *   files/local-engine/home          bound to /root/.tangu — sessions, memory, config. Outside the rootfs on purpose:
 *                                    updating or deleting the environment never touches conversations.
 *   files/local-engine/workspace     bound to /root/workspace — the files the agent works on (also outside the rootfs).
 *   files/local-engine/proc-standins static stand-ins for /proc files apps cannot read
 *   files/local-engine/installed.json what is installed (layer versions + sha256)
 *   cache/local-engine/              downloads (resumable .part files) and PRoot's temp dir
 *
 * None of this is backed up (backup_rules / data_extraction_rules exclude files/local-engine).
 */
final class LocalEnginePaths {
    static final String LAUNCHER = "libproot.so";
    static final String LOADER = "libproot_loader.so";
    /**
     * --link2symlink, off by default. Measured on the API 35 arm64 emulator (same environment, l2s on vs off):
     *  - on: coreutils `ln` still fails (ENOENT) and leaves `.l2s.*` debris; git leaves `.l2s.tmp_obj_*` in .git/objects
     *    (fsck: "bad sha1 file"); and stat of any file that went through a hard link comes back garbled — Node's
     *    fs.statSync reports a character device of size 0 (statx emulation), which breaks the agent's own file tools.
     *    dpkg can finalize installs (its status-old backup is a hard link).
     *  - off: hard links fail cleanly with EACCES (SELinux) and tools fall back (git commits / gc / fsck clean);
     *    the engine has its own copy fallback for generated files. dpkg cannot write status-old, so apt-get install
     *    unpacks the package but leaves it "unpacked, not configured" — known limitation until l2s is fixed.
     * Debug builds can flip it at runtime (LocalEnginePlugin.setLink2symlink) for experiments.
     */
    static volatile boolean link2symlink = false;

    final Context ctx;
    final File base;
    final File rootfs;
    final File home;
    final File workspace;
    final File standins;
    final File installedJson;
    final File cache;
    final File downloads;
    final File prootTmp;

    LocalEnginePaths(Context c) {
        ctx = c.getApplicationContext();
        base = new File(ctx.getFilesDir(), "local-engine");
        rootfs = new File(base, "rootfs");
        home = new File(base, "home");
        workspace = new File(base, "workspace");
        standins = new File(base, "proc-standins");
        installedJson = new File(base, "installed.json");
        cache = new File(ctx.getCacheDir(), "local-engine");
        downloads = new File(cache, "downloads");
        prootTmp = new File(cache, "proot-tmp");
    }

    String lib(String name) { return new File(ctx.getApplicationInfo().nativeLibraryDir, name).getPath(); }

    /** The launcher ships only in builds that carry it (test channel) and only runs on 64-bit ARM. */
    boolean launcherBundled() {
        boolean arm64 = false;
        for (String abi : Build.SUPPORTED_ABIS) if ("arm64-v8a".equals(abi)) arm64 = true;
        return arm64 && new File(lib(LAUNCHER)).canExecute() && new File(lib(LOADER)).exists();
    }

    Map<String, String> prootEnv() {
        prootTmp.mkdirs();
        Map<String, String> env = new LinkedHashMap<>();
        env.put("PROOT_LOADER", lib(LOADER));
        env.put("PROOT_TMP_DIR", prootTmp.getPath());
        env.put("HOME", "/root");
        env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin");
        env.put("LANG", "C.UTF-8");
        env.put("TMPDIR", "/tmp");
        String tz = java.util.TimeZone.getDefault().getID();
        if (tz != null && tz.matches("[A-Za-z0-9_+/-]{1,64}")) env.put("TZ", tz);
        return env;
    }

    List<String> engineBinds() {
        home.mkdirs();
        workspace.mkdirs();
        return Arrays.asList("-b", home.getPath() + ":/root/.tangu", "-b", workspace.getPath() + ":/root/workspace");
    }

    List<String> prootArgv(String cwd, List<String> extraBinds, List<String> cmd) {
        List<String> a = new ArrayList<>();
        a.add(lib(LAUNCHER));
        a.add("--kill-on-exit");
        if (link2symlink) a.add("--link2symlink");
        a.addAll(Arrays.asList("-0", "-r", rootfs.getPath()));
        for (String d : new String[]{"/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty", "/dev/ptmx", "/dev/pts"}) {
            if (new File(d).exists()) { a.add("-b"); a.add(d); }
        }
        a.addAll(Arrays.asList("-b", "/proc", "-b", "/sys"));
        String[] names = standins.list();
        if (names != null) for (String n : names) { a.add("-b"); a.add(new File(standins, n).getPath() + ":/proc/" + n); }
        if (extraBinds != null) a.addAll(extraBinds);
        a.add("-w"); a.add(cwd);
        a.addAll(cmd);
        return a;
    }

    /** After unpacking and before every start: files the environment needs from the phone. */
    void prepareRootfs() throws IOException {
        new File(rootfs, "etc").mkdirs();
        writeText(new File(rootfs, "etc/hosts"), "127.0.0.1 localhost\n::1 localhost\n");
        writeResolvConf();
        File dev = new File(rootfs, "dev");
        dev.mkdirs();
        String[][] links = {{"fd", "/proc/self/fd"}, {"stdin", "/proc/self/fd/0"}, {"stdout", "/proc/self/fd/1"}, {"stderr", "/proc/self/fd/2"}};
        for (String[] l : links) {
            File f = new File(dev, l[0]);
            try { Os.lstat(f.getPath()); } catch (Exception e) {
                try { Os.symlink(l[1], f.getPath()); } catch (Exception ignored) {}
            }
        }
        File tmp = new File(rootfs, "tmp");
        tmp.mkdirs();
        try { Os.chmod(tmp.getPath(), 01777); } catch (Exception ignored) {}
        new File(rootfs, "root/.tangu").mkdirs();
        new File(rootfs, "root/workspace").mkdirs();
        new File(rootfs, "proc").mkdirs();
        new File(rootfs, "sys").mkdirs();
        // apt drops to the _apt user for downloads; under PRoot's fake root its http method dies (exit 112).
        // Run the methods as root: the whole environment is already confined to the app's sandbox.
        File aptConf = new File(rootfs, "etc/apt/apt.conf.d");
        if (aptConf.isDirectory()) writeText(new File(aptConf, "99forsion-proot"), "APT::Sandbox::User \"root\";\n");
        writeStandins();
    }

    /** Nameservers of the phone's current network (not a hard-coded public resolver); rewritten on network changes. */
    void writeResolvConf() {
        List<String> servers = dnsServers();
        StringBuilder sb = new StringBuilder();
        for (String s : servers) sb.append("nameserver ").append(s).append('\n');
        File f = new File(rootfs, "etc/resolv.conf");
        if (sb.length() == 0) {
            // no network info right now: keep the last file written from a real network; only a fresh environment
            // with nothing at all gets public resolvers as a last resort (rewritten on the next network change)
            try { Os.lstat(f.getPath()); return; } catch (Exception ignored) {}
            sb.append("nameserver 223.5.5.5\nnameserver 1.1.1.1\n");
        }
        try {
            writeText(f, sb.toString());
        } catch (IOException ignored) {
        }
    }

    List<String> dnsServers() {
        List<String> out = new ArrayList<>();
        try {
            ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
            Network n = cm == null ? null : cm.getActiveNetwork();
            LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
            if (lp != null) for (InetAddress a : lp.getDnsServers()) {
                String h = a.getHostAddress();
                if (h == null) continue;
                int pct = h.indexOf('%'); // glibc does not take scoped IPv6 literals in resolv.conf
                if (pct >= 0) continue;
                if (!out.contains(h)) out.add(h);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private void writeStandins() throws IOException {
        standins.mkdirs();
        int cpus = Math.max(1, Runtime.getRuntime().availableProcessors());
        Map<String, String> m = new LinkedHashMap<>();
        StringBuilder stat = new StringBuilder("cpu  0 0 0 0 0 0 0 0 0 0\n");
        for (int i = 0; i < cpus; i++) stat.append("cpu").append(i).append(" 0 0 0 0 0 0 0 0 0 0\n");
        stat.append("intr 0\nctxt 0\nbtime ").append(System.currentTimeMillis() / 1000).append("\nprocesses 1\nprocs_running 1\nprocs_blocked 0\n");
        m.put("stat", stat.toString());
        m.put("loadavg", "0.00 0.00 0.00 1/1 1\n");
        double up = SystemClock.elapsedRealtime() / 1000.0;
        m.put("uptime", String.format(java.util.Locale.ROOT, "%.2f %.2f\n", up, up));
        m.put("version", "Linux version " + System.getProperty("os.version") + " (forsion@standin) #1 SMP PREEMPT\n");
        m.put("vmstat", "nr_free_pages 0\npgpgin 0\npgpgout 0\npswpin 0\npswpout 0\n");
        for (Map.Entry<String, String> e : m.entrySet()) {
            File f = new File(standins, e.getKey());
            if (readSmall("/proc/" + e.getKey()) != null) { f.delete(); continue; } // readable here: bind the real one
            writeText(f, e.getValue());
        }
    }

    static void writeText(File f, String s) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) { o.write(s.getBytes(StandardCharsets.UTF_8)); }
        try { if (android.system.OsConstants.S_ISLNK(Os.lstat(f.getPath()).st_mode)) Os.remove(f.getPath()); } catch (Exception ignored) {}
        if (!tmp.renameTo(f)) throw new IOException("rename " + tmp);
    }

    static String readSmall(String path) {
        try (InputStream in = new FileInputStream(path)) {
            byte[] buf = new byte[8192];
            int n = in.read(buf);
            return n < 0 ? "" : new String(buf, 0, n, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    /** Deletes a tree without following links (rootfs is full of absolute links into "/"). */
    static void deleteTree(File f) {
        try {
            android.system.StructStat st = Os.lstat(f.getPath());
            if (android.system.OsConstants.S_ISDIR(st.st_mode)) {
                try { Os.chmod(f.getPath(), 0700); } catch (Exception ignored) {}
                String[] kids = f.list();
                if (kids != null) for (String k : kids) deleteTree(new File(f, k));
            }
            Os.remove(f.getPath());
        } catch (Exception ignored) {
        }
    }

    /** Bytes on disk under a tree (no link following). */
    static long treeBytes(File f) {
        try {
            android.system.StructStat st = Os.lstat(f.getPath());
            if (android.system.OsConstants.S_ISDIR(st.st_mode)) {
                long sum = st.st_blocks * 512L;
                String[] kids = f.list();
                if (kids != null) for (String k : kids) sum += treeBytes(new File(f, k));
                return sum;
            }
            return st.st_blocks * 512L;
        } catch (Exception e) {
            return 0;
        }
    }
}
