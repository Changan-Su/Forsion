package com.forsion.tangu.localengine;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
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
 *   files/local-engine/accounts/<k>/home       bound to /root/.tangu — sessions, memory, config.
 *   files/local-engine/accounts/<k>/workspace  bound to /root/workspace — the files the agent works on.
 *                                    Per Forsion account (k = hash of the account id in the sign-in token): another
 *                                    account signing in on this phone gets its own engine data, never the last one's.
 *                                    Outside the rootfs on purpose: updating or deleting the environment never
 *                                    touches conversations.
 *   files/local-engine/secrets/<k>/cloud-token  the account token for model calls, bound read-only-ish to
 *                                    /run/forsion (outside home so that home can move to a new phone without it)
 *   files/local-engine/selftest      throwaway engine data for the install self-test (one real start), deleted after it
 *   files/local-engine/proc-standins static stand-ins for /proc files apps cannot read
 *   files/local-engine/installed.json what is installed (layer versions + sha256); pending.json while a swap is
 *                                    in progress (LocalEngineInstaller.recover)
 *   cache/local-engine/              downloads (resumable .part files) and PRoot's temp dir
 *
 * Cloud backup excludes all of files/local-engine; device transfer carries accounts/ (conversations and files)
 * and leaves out the environment, secrets and install state (data_extraction_rules.xml).
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
    final File accounts;
    final File secrets;
    final File standins;
    final File installedJson;
    final File selftest;
    final File cache;
    final File downloads;
    final File prootTmp;

    LocalEnginePaths(Context c) {
        ctx = c.getApplicationContext();
        base = new File(ctx.getFilesDir(), "local-engine");
        rootfs = new File(base, "rootfs");
        accounts = new File(base, "accounts");
        secrets = new File(base, "secrets");
        standins = new File(base, "proc-standins");
        installedJson = new File(base, "installed.json");
        selftest = new File(base, "selftest");
        cache = new File(ctx.getCacheDir(), "local-engine");
        downloads = new File(cache, "downloads");
        prootTmp = new File(cache, "proot-tmp");
    }

    String lib(String name) { return new File(ctx.getApplicationInfo().nativeLibraryDir, name).getPath(); }

    /** The launcher ships only in builds that carry it (test channel) and only runs on 64-bit ARM. */
    boolean launcherBundled() {
        String machine;
        try { machine = Os.uname().machine; } catch (Exception e) { machine = null; }
        return arm64Native(android.os.Process.is64Bit(), machine)
                && new File(lib(LAUNCHER)).canExecute() && new File(lib(LOADER)).exists();
    }

    /**
     * PRoot is an arm64 program that ptraces arm64 children, so this process must itself run as 64-bit ARM. Asked of
     * the process and the kernel, not of the ABI list: x86_64 devices with ARM translation (x86_64 emulator images,
     * some Chromebooks) list arm64-v8a too, and if the APK ever carries only arm64 libraries the package manager
     * installs it translated and extracts the launcher there; the native bridge may also rewrite os.arch, while
     * uname(2) still names the real machine. The ABI order is only a preference (a 32-bit-first arm64 build lists
     * armeabi-v7a first and can still run this app as arm64), so it is not used. 32-bit processes on arm64 kernels
     * see "armv8l" and is64Bit() == false.
     */
    static boolean arm64Native(boolean is64BitProcess, String unameMachine) {
        return is64BitProcess && "aarch64".equals(unameMachine);
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

    File home(String account) { return new File(new File(accounts, account), "home"); }

    File workspace(String account) { return new File(new File(accounts, account), "workspace"); }

    File secretDir(String account) { return new File(secrets, account); }

    /** Where the engine reads the account token (TANGU_TOKEN_FILE); secretDir(account) is bound to its directory. */
    static final String GUEST_TOKEN_FILE = "/run/forsion/cloud-token";

    List<String> engineBinds(String account) {
        return binds(home(account), workspace(account), secretDir(account));
    }

    /**
     * The install self-test's engine data: same mount points as an account's, in a throwaway tree under selftest (no
     * account's home, workspace or token is ever bound into the self-test). The caller deletes selftest afterwards.
     */
    List<String> selftestBinds() {
        return binds(new File(selftest, "home"), new File(selftest, "workspace"), new File(selftest, "secrets"));
    }

    private static List<String> binds(File home, File workspace, File secret) {
        home.mkdirs();
        workspace.mkdirs();
        secret.mkdirs();
        return Arrays.asList("-b", home.getPath() + ":/root/.tangu", "-b", workspace.getPath() + ":/root/workspace",
                "-b", secret.getPath() + ":/run/forsion");
    }

    /**
     * The account a sign-in token belongs to, as a directory name: sha256 of the token's userId claim (the token is
     * the server's JWT; only the payload is read, nothing is verified here — the server verifies every call). null
     * when signed out or the token carries no account id: the engine does not start then.
     */
    static String accountKey(String jwt) {
        if (jwt == null) return null;
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) return null;
        try {
            byte[] raw = android.util.Base64.decode(parts[1], android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
            org.json.JSONObject o = new org.json.JSONObject(new String(raw, StandardCharsets.UTF_8));
            Object id = o.opt("userId");
            if (id == null || id == org.json.JSONObject.NULL) id = o.opt("sub");
            if (id == null || id == org.json.JSONObject.NULL) return null;
            String s = String.valueOf(id);
            if (s.isEmpty()) return null;
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(("forsion-account:" + s).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 12; i++) hex.append(String.format("%02x", d[i]));
            return hex.toString();
        } catch (Exception e) {
            return null;
        }
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
        // the archive decides what is in the tree, so every directory this side writes into must be a real directory
        // (a layer could ship `etc` as a link to somewhere outside the environment)
        realDir("etc");
        writeText(new File(rootfs, "etc/hosts"), "127.0.0.1 localhost\n::1 localhost\n");
        writeResolvConf();
        File dev = realDir("dev");
        String[][] links = {{"fd", "/proc/self/fd"}, {"stdin", "/proc/self/fd/0"}, {"stdout", "/proc/self/fd/1"}, {"stderr", "/proc/self/fd/2"}};
        for (String[] l : links) {
            File f = new File(dev, l[0]);
            try { Os.lstat(f.getPath()); } catch (Exception e) {
                try { Os.symlink(l[1], f.getPath()); } catch (Exception ignored) {}
            }
        }
        File tmp = realDir("tmp");
        try { Os.chmod(tmp.getPath(), 01777); } catch (Exception ignored) {}
        realDir("root/.tangu");
        realDir("root/workspace");
        realDir("run/forsion");
        realDir("proc");
        realDir("sys");
        // apt drops to the _apt user for downloads; under PRoot's fake root its http method dies (exit 112).
        // Run the methods as root: the whole environment is already confined to the app's sandbox.
        if (isRealDir("etc/apt/apt.conf.d")) writeText(new File(rootfs, "etc/apt/apt.conf.d/99forsion-proot"), "APT::Sandbox::User \"root\";\n");
        writeStandins();
    }

    /** rootfs/rel as a real directory: links on the way are replaced by directories, missing ones created; a regular file in the way fails. */
    File realDir(String rel) throws IOException {
        try {
            if (!android.system.OsConstants.S_ISDIR(Os.lstat(rootfs.getPath()).st_mode)) throw new IOException("rootfs is not a directory");
        } catch (android.system.ErrnoException e) {
            throw new IOException("no rootfs");
        }
        File cur = rootfs;
        for (String part : rel.split("/")) {
            cur = new File(cur, part);
            try {
                android.system.StructStat st = Os.lstat(cur.getPath());
                if (android.system.OsConstants.S_ISDIR(st.st_mode)) continue;
                if (!android.system.OsConstants.S_ISLNK(st.st_mode)) throw new IOException("not a directory: " + rel);
                Os.remove(cur.getPath()); // the link itself, not what it points to
            } catch (android.system.ErrnoException missing) {
                // fall through: create it
            }
            try { Os.mkdir(cur.getPath(), 0755); } catch (android.system.ErrnoException e) { throw new IOException("mkdir " + rel + ": " + e.getMessage()); }
        }
        return cur;
    }

    /** rootfs/rel exists and every component is a real directory (no link anywhere on the way). */
    boolean isRealDir(String rel) {
        try {
            if (!android.system.OsConstants.S_ISDIR(Os.lstat(rootfs.getPath()).st_mode)) return false;
        } catch (Exception e) {
            return false;
        }
        File cur = rootfs;
        for (String part : rel.split("/")) {
            cur = new File(cur, part);
            try {
                if (!android.system.OsConstants.S_ISDIR(Os.lstat(cur.getPath()).st_mode)) return false;
            } catch (Exception e) {
                return false;
            }
        }
        return true;
    }

    /** Nameservers of the phone's current network (not a hard-coded public resolver); rewritten on network changes. */
    void writeResolvConf() {
        List<String> servers = dnsServers();
        StringBuilder sb = new StringBuilder();
        for (String s : servers) sb.append("nameserver ").append(s).append('\n');
        try { realDir("etc"); } catch (IOException e) { return; }
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

    /**
     * Atomic replace that never writes through a link: the temp file is created O_EXCL | O_NOFOLLOW (whatever sat
     * at that name is removed first, links included, not followed), and rename(2) replaces a link at the target
     * rather than following it. Callers keep the parent a real directory (realDir).
     */
    static void writeText(File f, String s) throws IOException {
        // a temp name of its own per writer: two writers of the same file never unlink or publish each other's half file
        String tmp = f.getPath() + ".tmp-" + android.os.Process.myTid() + "-" + System.nanoTime();
        java.io.FileDescriptor fd;
        try {
            fd = Os.open(tmp, android.system.OsConstants.O_WRONLY | android.system.OsConstants.O_CREAT | android.system.OsConstants.O_EXCL
                    | android.system.OsConstants.O_NOFOLLOW, 0644);
        } catch (android.system.ErrnoException e) {
            throw new IOException("open " + tmp + ": " + e.getMessage());
        }
        boolean ok = false;
        try {
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            for (int off = 0; off < b.length; ) off += Os.write(fd, b, off, b.length - off);
            Os.fsync(fd); // install records commit by rename: the bytes must be on disk first
            ok = true;
        } catch (android.system.ErrnoException | java.io.InterruptedIOException e) {
            throw new IOException("write " + tmp + ": " + e.getMessage());
        } finally {
            try { Os.close(fd); } catch (android.system.ErrnoException ignored) {} // Android's FileOutputStream(fd) would not close it
            if (!ok) try { Os.remove(tmp); } catch (Exception ignored) {}
        }
        try {
            Os.rename(tmp, f.getPath());
        } catch (android.system.ErrnoException e) {
            try { Os.remove(tmp); } catch (Exception ignored) {}
            throw new IOException("rename " + tmp + ": " + e.getMessage());
        }
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
