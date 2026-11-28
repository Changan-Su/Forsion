package com.forsion.tangu.localengine;

import android.os.StatFs;
import android.system.Os;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Installs and updates the two halves (mobile/android/local-engine/README.md):
 *   base   — Ubuntu + Node, a stored asset in this APK (BASE_ASSET), unpacked into rootfs. Follows the app.
 *   engine — npm package (LocalEngineConfig.pkg, dist-tag android-<line>), downloaded resumably from npmmirror then
 *            registry.npmjs.org, unpacked into engines/.staging, verified (EngineSignature) before anything in it runs,
 *            then moved to engines/<version> and bound at /opt/tangu when it runs.
 *
 * installed.json (schema 2) = { base: {version, sha256}, engine: {version, fingerprint}, previous?: {version, fingerprint},
 * bad: [versions] }: the (base, engine) pair that passed the self-test together, plus the engine before it.
 *
 * Every change goes through apply(): stage what is new (base into rootfs.new, engine into the staging tree), stop the
 * engine (Swap.enter), swap the base in if there is one, self-test the pair, then commit by one rename (pending.json →
 * installed.json). A failed self-test puts the previous base back and drops the staged engine; a process killed mid-swap
 * is undone by recover() on the next start (pending.json still there = not committed). Engine trees that no record
 * points at (current / previous) are leftovers and go to the trash.
 */
final class LocalEngineInstaller {
    private static final String TAG = "LocalEngine";
    private static final int CONNECT_MS = 15_000;
    private static final int READ_MS = 30_000;
    private static final int MAX_REDIRECTS = 3;
    /** A tarball above this is refused before it is stored (the signed table caps the unpacked tree separately). */
    static final long MAX_TARBALL_BYTES = 300L << 20;
    /** Starts in a row that never became healthy before a version is marked bad (each start = up to 2 spawns). */
    static final int BAD_AFTER_FAILED_STARTS = 3;

    interface Listener {
        /** phase = downloading | unpacking | checking; done / total in bytes of the current phase; layer = base | engine. */
        void progress(String phase, String layer, long done, long total);
    }

    /** The destructive part of a swap, supplied by LocalEngine. */
    interface Swap {
        /** Called once everything is staged and before the live tree moves: stop the engine and block starts. */
        void enter() throws IOException;

        /** Self-test of rootfs with this engine tree bound at /opt/tangu; null = good, otherwise why not (rolled back). */
        String validate(File engineDir);
    }

    /** What the registry offers on this APK's line. Sizes are display hints only (bounded, never trusted). */
    static final class Release {
        final String version;
        final List<String> tarballs;
        final long size, unpackedSize;

        Release(String version, List<String> tarballs, long size, long unpackedSize) {
            this.version = version; this.tarballs = tarballs; this.size = size; this.unpackedSize = unpackedSize;
        }
    }

    /** installed.json, schema 2. */
    static final class Installed {
        final String baseVersion, baseSha256, engineVersion, engineFingerprint, prevVersion, prevFingerprint;
        final Set<String> bad;

        Installed(String baseVersion, String baseSha256, String engineVersion, String engineFingerprint, String prevVersion, String prevFingerprint, Set<String> bad) {
            this.baseVersion = baseVersion; this.baseSha256 = baseSha256; this.engineVersion = engineVersion; this.engineFingerprint = engineFingerprint;
            this.prevVersion = prevVersion; this.prevFingerprint = prevFingerprint; this.bad = bad;
        }

        static Installed parse(String s) {
            try {
                JSONObject o = new JSONObject(s);
                if (o.optInt("schema", 0) != 2) return null;
                JSONObject b = o.getJSONObject("base"), e = o.getJSONObject("engine");
                JSONObject p = o.optJSONObject("previous");
                Set<String> bad = new LinkedHashSet<>();
                JSONArray a = o.optJSONArray("bad");
                if (a != null) for (int i = 0; i < a.length(); i++) bad.add(a.getString(i));
                String ev = e.getString("version"), ef = e.getString("fingerprint");
                if (!Versions.isRelease(ev) || !ef.matches("[0-9a-f]{64}")) return null;
                String pv = p == null ? null : p.optString("version", null), pf = p == null ? null : p.optString("fingerprint", null);
                if (pv != null && (!Versions.isRelease(pv) || pf == null || !pf.matches("[0-9a-f]{64}"))) { pv = null; pf = null; }
                return new Installed(b.getString("version"), b.optString("sha256"), ev, ef, pv, pf, bad);
            } catch (Exception ex) {
                return null;
            }
        }

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("schema", 2);
                o.put("base", new JSONObject().put("version", baseVersion).put("sha256", baseSha256));
                o.put("engine", new JSONObject().put("version", engineVersion).put("fingerprint", engineFingerprint));
                if (prevVersion != null) o.put("previous", new JSONObject().put("version", prevVersion).put("fingerprint", prevFingerprint));
                JSONArray a = new JSONArray();
                for (String v : bad) a.put(v);
                o.put("bad", a);
                o.put("installedAt", System.currentTimeMillis());
            } catch (Exception ignored) {}
            return o;
        }

        Installed withBad(Set<String> b) { return new Installed(baseVersion, baseSha256, engineVersion, engineFingerprint, prevVersion, prevFingerprint, b); }
    }

    /** Thrown on pause / delete while downloading or unpacking. */
    static final class Cancelled extends IOException {
        Cancelled() { super("cancelled"); }
    }

    /** User-facing failure: code is what the page shows (phoneEngine.err.<code>). */
    static final class Failure extends IOException {
        final String code;

        Failure(String code, String detail) { super(code + (detail == null ? "" : ": " + detail)); this.code = code; }
    }

    private final LocalEnginePaths paths;
    private final LocalEngineConfig cfg;
    private final boolean allowCleartextLoopback;
    private volatile boolean cancelled;
    private volatile HttpURLConnection conn;
    /** Read-modify-write of installed.json (bad marks from the start path, commits from the install path). */
    private final Object recordLock = new Object();

    LocalEngineInstaller(LocalEnginePaths paths, LocalEngineConfig cfg, boolean debuggable) {
        this.paths = paths;
        this.cfg = cfg;
        this.allowCleartextLoopback = debuggable;
    }

    void cancel() {
        cancelled = true;
        HttpURLConnection c = conn;
        if (c != null) try { c.disconnect(); } catch (RuntimeException ignored) {}
    }

    // ---------- registry ----------

    /**
     * The version on this APK's line that an update / install would take, or null when there is none newer than
     * `installed` (null = nothing installed) that is not bad and not older than the APK's minimum. Mirror first; when the
     * mirror offers nothing eligible (it lags), the official registry is asked too and the higher eligible version wins.
     * Throws Failure("registry") only when no registry answered at all.
     */
    Release resolve(List<String> registries, String installed, Set<String> bad) throws IOException {
        List<String> failed = new ArrayList<>();
        String best = null, bestFrom = null;
        long size = 0, unpacked = 0;
        boolean answered = false;
        for (String reg : registries) {
            if (cancelled) throw new Cancelled();
            JSONObject doc;
            try {
                doc = new JSONObject(new String(getSmall(LocalEngineConfig.packumentUrl(reg, cfg.pkg), 8 << 20, "application/vnd.npm.install-v1+json"), StandardCharsets.UTF_8));
            } catch (Failure f) {
                if ("registry_missing".equals(f.code)) { answered = true; continue; } // not published there (yet)
                failed.add(host(reg) + ": " + f.getMessage());
                continue;
            } catch (Exception e) {
                failed.add(host(reg) + ": " + e.getClass().getSimpleName());
                continue;
            }
            answered = true;
            JSONObject tags = doc.optJSONObject("dist-tags");
            String v = tags == null ? null : tags.optString(cfg.distTag(), null);
            if (eligible(v, installed, bad) && (best == null || Versions.compare(v, best) > 0)) {
                best = v;
                bestFrom = reg;
                JSONObject dist = doc.optJSONObject("versions") == null ? null : doc.optJSONObject("versions").optJSONObject(v);
                dist = dist == null ? null : dist.optJSONObject("dist");
                size = dist == null ? 0 : hint(dist.opt("size"), MAX_TARBALL_BYTES);
                unpacked = dist == null ? 0 : hint(dist.opt("unpackedSize"), EngineSignature.MAX_BYTES);
            }
            if (best != null) break; // the first registry with something eligible: the mirror when it has caught up
        }
        if (!answered) throw new Failure("registry", String.join(" · ", failed));
        if (best == null) return null;
        List<String> urls = new ArrayList<>();
        urls.add(LocalEngineConfig.tarballUrl(bestFrom, cfg.pkg, best));
        for (String reg : registries) if (!reg.equals(bestFrom)) urls.add(LocalEngineConfig.tarballUrl(reg, cfg.pkg, best));
        if (size <= 0) size = probeSize(urls.get(0)); // npmjs's packument has no tarball size
        return new Release(best, urls, size, unpacked);
    }

    private boolean eligible(String v, String installed, Set<String> bad) {
        if (!Versions.isRelease(v)) return false;
        if (bad != null && bad.contains(v)) return false;
        if (cfg.minEngineVersion != null && !cfg.minEngineVersion.isEmpty() && Versions.compare(v, cfg.minEngineVersion) < 0) return false;
        return installed == null || Versions.compare(v, installed) > 0;
    }

    private static long hint(Object o, long cap) {
        if (!(o instanceof Integer || o instanceof Long)) return 0;
        long n = ((Number) o).longValue();
        return n > 0 && n <= cap ? n : 0;
    }

    /** Total size from a one-byte range request (follows the same redirects as the download); 0 when unknown. */
    private long probeSize(String url) {
        try {
            HttpURLConnection c = openFollowing(url, 0, "bytes=0-0");
            try {
                if (c.getResponseCode() == 206) {
                    java.util.regex.Matcher m = CONTENT_RANGE.matcher(String.valueOf(c.getHeaderField("Content-Range")).trim());
                    if (m.matches() && !m.group(3).equals("*")) return Math.min(Long.parseLong(m.group(3)), MAX_TARBALL_BYTES);
                }
                if (c.getResponseCode() == 200) return Math.max(0, Math.min(c.getContentLengthLong(), MAX_TARBALL_BYTES));
            } finally {
                c.disconnect();
            }
        } catch (Exception ignored) {}
        return 0;
    }

    // ---------- installed state ----------

    /** The committed (base, engine) pair, or null when there is none usable (also for a pre-npm schema 1 record). */
    Installed installed() {
        String s = LocalEnginePaths.readSmall(paths.installedJson.getPath());
        if (s == null || s.isEmpty()) return null;
        Installed r = Installed.parse(s);
        if (r == null) return null; // unreadable = unknown; the page offers reset, nothing is deleted on our own
        if (!new File(paths.rootfs, "opt/node/bin/node").exists()) return null;
        if (!new File(paths.engineDir(r.engineVersion), "dist/standalone/main.js").exists()) return null;
        return r;
    }

    /** Raw: a record exists at all (a schema 1 record from before the npm engine counts; reset replaces it). */
    boolean hasAnyRecord() { return paths.installedJson.exists(); }

    private File pendingJson() { return new File(paths.base, "pending.json"); }

    private File oldRootfs() { return new File(paths.base, "rootfs.old"); }

    private File newRootfs() { return new File(paths.base, "rootfs.new"); }

    private File staging() { return new File(paths.engines, ".staging"); }

    private File trash() { return new File(paths.base, "trash"); }

    /** Moves a tree out of the way in one rename (deleting a rootfs takes a while; emptyTrash does that later). */
    private void toTrash(File f) {
        if (!exists(f)) return;
        trash().mkdirs();
        File dst = new File(trash(), f.getName() + "-" + System.nanoTime());
        if (!f.renameTo(dst)) LocalEnginePaths.deleteTree(f);
    }

    void emptyTrash() { LocalEnginePaths.deleteTree(trash()); }

    /** Puts the previous tree back at live (whatever is at live goes to the trash). true when old is in place or there was none. */
    private boolean putBack(File live, File old) {
        if (!exists(old)) return true;
        toTrash(live);
        return old.renameTo(live);
    }

    /** Before a new swap: a previous one that did not commit is put back first, or this one refuses (nothing gets trashed). */
    private void ensureRecovered() throws Failure {
        if (!exists(pendingJson())) return;
        recover();
        if (exists(pendingJson())) throw new Failure("unpack", "a previous swap could not be undone");
    }

    /**
     * After a process death mid-swap: pending.json still there = never committed → put the previous rootfs back (when
     * this swap moved one) and drop pending.json. Then every leftover goes to the trash: rootfs.old / rootfs.new, the
     * engine staging tree, and engine trees that neither the committed record's current nor previous points at.
     * Renames only (fast); call before anything reads installed() or starts the engine.
     */
    void recover() {
        File pending = pendingJson();
        if (exists(pending)) {
            boolean baseSwap = exists(oldRootfs()), hadOld = baseSwap;
            try {
                JSONObject j = new JSONObject(LocalEnginePaths.readSmall(pending.getPath()));
                baseSwap = j.optBoolean("baseSwap", baseSwap);
                hadOld = j.optBoolean("hadOld", hadOld);
            } catch (Exception ignored) {}
            if (baseSwap) {
                boolean restored = putBack(paths.rootfs, oldRootfs());
                if (!restored) {
                    // keep pending.json and the previous tree aside: the next start tries again, nothing gets trashed
                    Log.w(TAG, "could not restore the previous environment after an interrupted swap");
                    return;
                }
                // an interrupted first install: whatever got swapped in never passed its self-test
                if (!hadOld && !exists(paths.installedJson)) toTrash(paths.rootfs);
            }
            pending.delete();
            Log.w(TAG, "recovered an interrupted swap: previous environment restored");
        }
        toTrash(oldRootfs());
        toTrash(newRootfs());
        toTrash(staging());
        toTrash(new File(paths.base, "engine.new")); // pre-npm layout
        Installed r = Installed.parse(String.valueOf(LocalEnginePaths.readSmall(paths.installedJson.getPath())));
        String[] names = paths.engines.list();
        if (names != null && r != null) {
            for (String n : names) {
                if (n.equals(r.engineVersion) || n.equals(r.prevVersion)) continue;
                toTrash(new File(paths.engines, n));
            }
        }
    }

    // ---------- the start path's record keeping ----------

    /** One more start of `version` that never became healthy; returns true when that made it bad (and records it). */
    boolean recordFailedStart(String version) {
        synchronized (recordLock) {
            JSONObject h = health();
            int n = h.optInt(version, 0) + 1;
            try { h.put(version, n); } catch (Exception ignored) {}
            writeQuietly(paths.healthJson, h.toString());
            if (n < BAD_AFTER_FAILED_STARTS) return false;
            Installed r = installed();
            if (r == null || r.bad.contains(version)) return r != null;
            Set<String> bad = new LinkedHashSet<>(r.bad);
            bad.add(version);
            try {
                LocalEnginePaths.writeText(paths.installedJson, r.withBad(bad).toJson().toString());
            } catch (IOException e) {
                Log.w(TAG, "could not record " + version + " as bad: " + e.getMessage());
                return false;
            }
            Log.w(TAG, "engine " + version + " marked bad after " + n + " failed starts");
            return true;
        }
    }

    void recordHealthyStart(String version) {
        synchronized (recordLock) {
            JSONObject h = health();
            if (h.optInt(version, 0) == 0) return;
            h.remove(version);
            writeQuietly(paths.healthJson, h.toString());
        }
    }

    int failedStarts(String version) {
        synchronized (recordLock) { return health().optInt(version, 0); }
    }

    private JSONObject health() {
        try {
            String s = LocalEnginePaths.readSmall(paths.healthJson.getPath());
            return s == null || s.isEmpty() ? new JSONObject() : new JSONObject(s);
        } catch (Exception e) {
            return new JSONObject(); // counters only: losing them delays a bad mark, never allows anything
        }
    }

    private static void writeQuietly(File f, String s) {
        try { LocalEnginePaths.writeText(f, s); } catch (IOException e) { Log.w(TAG, "write " + f.getName() + ": " + e.getMessage()); }
    }

    // ---------- install / update ----------

    /**
     * One change of the environment. base = unpack this APK's base layer (fresh install, reset, or an app update brought a
     * new one); release = download this engine (null = keep the installed one). With neither, nothing happens.
     */
    void apply(boolean base, Release release, Listener l, Swap swap) throws IOException {
        cancelled = false;
        ensureRecovered();
        Installed cur = installed();
        if (!base && release == null) return;
        if (cur == null && release == null) throw new Failure("registry", "no engine on line " + cfg.line);
        if (cur == null && !base) base = true;

        long need = (base ? cfg.baseUnpackedSize : 0) + (64L << 20);
        if (release != null) need += Math.max(release.size, 64L << 20) * 2 + Math.max(release.unpackedSize, 200L << 20) - partBytes(release);
        checkSpace(need);

        // stage the engine: downloaded + unpacked + verified, or the kept one
        File engineDir;
        EngineSignature.Result signed;
        if (release != null) {
            Object[] got = fetchEngine(release, l);
            engineDir = (File) got[0];
            signed = (EngineSignature.Result) got[1];
        } else {
            engineDir = paths.engineDir(cur.engineVersion);
            signed = null;
        }
        // stage the base
        if (base) {
            LocalEnginePaths.deleteTree(newRootfs());
            unpackBase(newRootfs(), l);
        }
        if (cancelled) throw new Cancelled();

        swap.enter(); // no start runs from here until the caller leaves maintenance
        boolean baseSwap = base, hadOld = exists(paths.rootfs);
        Installed now = installed(); // after enter(): bad marks a failing start wrote meanwhile are in here
        String engVersion = release != null ? signed.version : cur.engineVersion;
        String engFp = release != null ? signed.fingerprint : cur.engineFingerprint;
        String prevV = null, prevF = null;
        if (release != null && now != null && !now.engineVersion.equals(signed.version)) { prevV = now.engineVersion; prevF = now.engineFingerprint; }
        else if (now != null) { prevV = now.prevVersion; prevF = now.prevFingerprint; }
        // a new base clears bad marks (the crash may have been the base); otherwise they carry over
        Set<String> bad = base || now == null ? new LinkedHashSet<>() : new LinkedHashSet<>(now.bad);
        String baseV = base ? cfg.baseVersion : now != null ? now.baseVersion : cfg.baseVersion;
        String baseS = base ? cfg.baseSha256 : now != null ? now.baseSha256 : cfg.baseSha256;
        Installed next = new Installed(baseV, baseS, engVersion, engFp, prevV, prevF, bad);
        JSONObject journal = next.toJson();
        try { journal.put("baseSwap", baseSwap); journal.put("hadOld", hadOld); } catch (Exception ignored) {}
        File old = oldRootfs();
        toTrash(old); // nothing pending (ensureRecovered): a leftover from a committed swap
        LocalEnginePaths.writeText(pendingJson(), journal.toString());
        if (baseSwap) {
            if (hadOld && !paths.rootfs.renameTo(old)) { pendingJson().delete(); throw new Failure("unpack", "swap"); }
            if (!newRootfs().renameTo(paths.rootfs)) {
                rollback(hadOld);
                throw new Failure("unpack", "swap");
            }
        }
        String why;
        try {
            paths.prepareRootfs();
            l.progress("checking", "engine", 0, 0);
            why = swap.validate(engineDir);
        } catch (IOException e) {
            why = "prepare " + e.getMessage();
        }
        if (why != null) {
            if (baseSwap) rollback(hadOld); else pendingJson().delete();
            if (release != null) toTrash(staging());
            throw new Failure("selftest", why);
        }
        if (release != null) {
            File dst = paths.engineDir(signed.version);
            toTrash(dst); // a leftover of the same version that no record points at
            if (!engineDir.renameTo(dst)) {
                if (baseSwap) rollback(hadOld); else pendingJson().delete();
                throw new Failure("unpack", "engine move");
            }
        }
        try {
            synchronized (recordLock) { Os.rename(pendingJson().getPath(), paths.installedJson.getPath()); } // the commit
        } catch (android.system.ErrnoException e) {
            if (baseSwap) rollback(hadOld); else pendingJson().delete();
            throw new Failure("unpack", "commit " + e.getMessage());
        }
        if (base) {
            synchronized (recordLock) { paths.healthJson.delete(); }
        }
        toTrash(old);
        toTrash(staging());
        // only current + previous stay
        String[] names = paths.engines.list();
        if (names != null) for (String n : names) if (!n.equals(next.engineVersion) && !n.equals(next.prevVersion)) toTrash(new File(paths.engines, n));
        if (release != null) tarball(release.version).delete();
    }

    /** Undoes a base swap that did not commit; pending.json is dropped only once the previous rootfs is back in place. */
    private void rollback(boolean hadOld) {
        if (hadOld ? putBack(paths.rootfs, oldRootfs()) : true) {
            if (!hadOld) toTrash(paths.rootfs);
            pendingJson().delete();
        }
    }

    /** Removes the environment (not accounts/: conversations, files and each account's engine history stay). */
    void removeEnvironment() {
        cancel();
        LocalEnginePaths.deleteTree(paths.installedJson);
        LocalEnginePaths.deleteTree(pendingJson());
        LocalEnginePaths.deleteTree(paths.healthJson);
        LocalEnginePaths.deleteTree(paths.rootfs);
        LocalEnginePaths.deleteTree(newRootfs());
        LocalEnginePaths.deleteTree(oldRootfs());
        LocalEnginePaths.deleteTree(paths.engines);
        LocalEnginePaths.deleteTree(new File(paths.base, "engine.new"));
        LocalEnginePaths.deleteTree(new File(paths.base, "tangu.old"));
        LocalEnginePaths.deleteTree(trash());
        LocalEnginePaths.deleteTree(paths.selftest);
        LocalEnginePaths.deleteTree(paths.downloads);
    }

    // ---------- engine: download, unpack, verify ----------

    private File tarball(String version) { return new File(paths.downloads, "engine-" + version + ".tgz"); }

    long partBytes(Release r) {
        if (r == null) return 0;
        File done = tarball(r.version);
        if (done.exists()) return done.length();
        File part = new File(done.getPath() + ".part");
        return part.exists() ? part.length() : 0;
    }

    /**
     * Each tarball URL in turn (mirror first): download (resuming what is there), unpack into the staging tree, verify.
     * A network failure moves on to the next URL keeping the partial file (npm versions are immutable: the bytes are the
     * same everywhere); a tree that fails verification deletes the download and the next URL starts from scratch.
     * Returns {engine tree, verification}.
     */
    private Object[] fetchEngine(Release r, Listener l) throws IOException {
        IOException last = null;
        boolean sawSignature = false;
        for (String url : r.tarballs) {
            if (cancelled) throw new Cancelled();
            File tgz;
            try {
                tgz = download(url, r, l);
            } catch (Cancelled c) {
                throw c;
            } catch (Failure f) {
                if ("space".equals(f.code)) throw f;
                last = f;
                Log.w(TAG, "engine " + r.version + " from " + host(url) + ": " + f.getMessage());
                continue;
            } catch (IOException e) {
                last = e;
                continue;
            }
            LocalEnginePaths.deleteTree(staging());
            try {
                unpack(tgz, staging(), l);
                File pkg = new File(staging(), "package");
                String[] top = staging().list();
                if (top == null || top.length != 1 || !pkg.isDirectory()) throw new EngineSignature.Refused("tarball root is not package/");
                return new Object[]{pkg, verifyTree(pkg, r.version, l)};
            } catch (EngineSignature.Refused e) {
                Log.w(TAG, "engine " + r.version + " from " + host(url) + " refused: " + e.getMessage());
                sawSignature = true;
                last = new Failure("signature", e.getMessage());
                tgz.delete();
                LocalEnginePaths.deleteTree(staging());
            } catch (Failure f) {
                if ("unpack".equals(f.code)) { tgz.delete(); LocalEnginePaths.deleteTree(staging()); last = f; continue; }
                throw f;
            }
        }
        if (sawSignature) throw new Failure("signature", last == null ? null : last.getMessage());
        if (last instanceof Failure) throw last;
        throw new Failure("network", last == null ? null : last.getClass().getSimpleName());
    }

    private EngineSignature.Result verifyTree(File dir, String version, Listener l) throws IOException {
        l.progress("checking", "engine", 0, 0);
        try {
            return EngineSignature.verify(dir, cfg.keys, cfg.pkg, version, cfg.line, cfg.minEngineVersion,
                    (d, t) -> l.progress("checking", "engine", d, t), () -> cancelled);
        } catch (EngineSignature.Refused e) {
            throw e;
        } catch (Cancelled e) {
            throw e;
        } catch (IOException e) {
            throw new EngineSignature.Refused("unreadable tree: " + e.getMessage());
        }
    }

    /** Re-verification of an installed engine tree (reset); null when it does not verify. */
    EngineSignature.Result verifyInstalled(String version) {
        try {
            return EngineSignature.verify(paths.engineDir(version), cfg.keys, cfg.pkg, version, cfg.line, null, null, null);
        } catch (IOException e) {
            Log.w(TAG, "installed engine " + version + " does not verify: " + e.getMessage());
            return null;
        }
    }

    private static final java.util.regex.Pattern CONTENT_RANGE = java.util.regex.Pattern.compile("^bytes (\\d+)-(\\d+)/(\\d+|\\*)$");

    /**
     * Resumable download into engine-<version>.tgz.part. The total comes from the server (Content-Length of a 200, the
     * total of a 206) and must stay the same across rounds and under MAX_TARBALL_BYTES; nothing about it is trusted —
     * the signature decides. A 206 is appended only when it starts exactly where the partial file ends.
     */
    private File download(String url, Release r, Listener l) throws IOException {
        checkUrl(url);
        paths.downloads.mkdirs();
        File done = tarball(r.version);
        if (done.exists() && done.length() > 0) return done;
        String[] olds = paths.downloads.list();
        if (olds != null) for (String n : olds) if (!n.startsWith(done.getName())) new File(paths.downloads, n).delete(); // other versions
        File part = new File(done.getPath() + ".part");
        long[] total = {-1}; // what the server reports; the packument's size is a display hint only
        int failures = 0;
        for (int round = 0; ; round++) {
            if (cancelled) throw new Cancelled();
            long have = part.exists() ? part.length() : 0;
            if (total[0] > 0 && have > total[0]) { part.delete(); have = 0; }
            if (total[0] > 0 && have == total[0]) break;
            if (round >= 50) throw new Failure("network", "too many interrupted transfers");
            long before = have;
            try {
                if (fetchInto(url, part, have, total, l)) break;
            } catch (Cancelled e) {
                throw e;
            } catch (IOException e) {
                if (cancelled) throw new Cancelled();
                if (e instanceof Failure && !"network".equals(((Failure) e).code)) throw e;
                long now = part.exists() ? part.length() : 0;
                // only consecutive attempts without progress count: a flaky line that keeps delivering is not a dead one
                failures = now > before ? 0 : failures + 1;
                Log.w(TAG, "download engine (" + now + "/" + total[0] + ") from " + host(url) + ": " + e);
                if (failures >= 3) throw e instanceof Failure ? e : new Failure("network", e.getClass().getSimpleName());
                try { Thread.sleep(1500L * Math.max(1, failures)); } catch (InterruptedException ie) { throw new Cancelled(); }
            }
        }
        l.progress("downloading", "engine", part.length(), part.length());
        if (!part.renameTo(done)) throw new Failure("download", "rename");
        return done;
    }

    /** One request; true when the file is complete. total[0] = the size the server reported (-1 until known). */
    private boolean fetchInto(String url, File part, long have, long[] total, Listener l) throws IOException {
        HttpURLConnection c = openFollowing(url, have, have > 0 ? "bytes=" + have + "-" : null);
        conn = c;
        try {
            int st = c.getResponseCode();
            boolean append;
            long size;
            if (st == 206) {
                java.util.regex.Matcher m = CONTENT_RANGE.matcher(String.valueOf(c.getHeaderField("Content-Range")).trim());
                boolean ok;
                long tot = -1;
                try {
                    ok = have > 0 && m.matches() && Long.parseLong(m.group(1)) == have && !m.group(3).equals("*");
                    if (ok) tot = Long.parseLong(m.group(3));
                    ok = ok && Long.parseLong(m.group(2)) == tot - 1;
                } catch (NumberFormatException e) {
                    ok = false;
                }
                if (!ok || (total[0] > 0 && tot != total[0])) { part.delete(); total[0] = -1; throw new IOException("unexpected Content-Range"); }
                size = tot;
                append = true;
            } else if (st == 200) {
                append = false; // the whole file
                have = 0;
                size = c.getContentLengthLong();
                if (size <= 0) throw new Failure("download", "no length"); // registries always send one; without it resume cannot work
                if (total[0] > 0 && size != total[0]) total[0] = size; // a fresh body: whatever it is, the signature decides
            } else if (st == 416) {
                part.delete();
                throw new IOException("range not satisfiable");
            } else if (st == 404) {
                throw new Failure("network", "not found"); // a lagging mirror: try the next registry
            } else {
                throw new Failure("network", "http " + st);
            }
            if (size > MAX_TARBALL_BYTES) throw new Failure("download", "too large");
            total[0] = size;
            checkSpace(size - have + (16L << 20));
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, append)) {
                byte[] buf = new byte[1 << 16];
                long lastReport = 0;
                for (int n; (n = in.read(buf)) >= 0; ) {
                    if (cancelled) throw new Cancelled();
                    if (have + n > size) {
                        out.close();
                        part.delete();
                        throw new IOException("longer than announced");
                    }
                    out.write(buf, 0, n);
                    have += n;
                    if (have - lastReport >= (512 << 10)) { lastReport = have; l.progress("downloading", "engine", have, size); }
                }
            }
            if (have < size) throw new IOException("short transfer"); // bytes kept; the next round resumes
            return true;
        } finally {
            conn = null;
            c.disconnect();
        }
    }

    private void unpack(File archive, File dest, Listener l) throws IOException {
        // the npm tarball's own size bounds what it may write (the signed table bounds the tree again)
        TarExtractor x = new TarExtractor(dest, EngineSignature.MAX_BYTES + (16L << 20));
        final long total = archive.length();
        try {
            x.extract(archive, (bytes) -> l.progress("unpacking", "engine", bytes, total), () -> cancelled);
        } catch (TarExtractor.InterruptedIOException2 e) {
            throw new Cancelled();
        }
        Log.i(TAG, "unpacked engine " + x);
        if (x.errors > 0 || x.skippedUnsafe > 0) throw new Failure("unpack", "engine " + x);
        // the table allows regular files only: links or special entries in the tarball are refused by the verifier
    }

    // ---------- base: from this APK ----------

    /** The base layer straight from the stored asset: its hash is checked against the pinned one first, then it streams into dest. */
    private void unpackBase(File dest, Listener l) throws IOException {
        if (!baseBundled()) throw new Failure("unsupported", "no base layer in this build");
        l.progress("checking", "base", 0, 0);
        if (!cfg.baseSha256.equals(baseAssetSha256())) throw new Failure("unpack", "base layer does not match this build");
        TarExtractor x = new TarExtractor(dest, cfg.baseUnpackedSize + cfg.baseUnpackedSize / 2 + (64L << 20));
        final long total = cfg.baseSize;
        try {
            x.extract(paths.ctx.getAssets().open(LocalEngineConfig.BASE_ASSET, android.content.res.AssetManager.ACCESS_STREAMING),
                    (bytes) -> l.progress("unpacking", "base", bytes, total), () -> cancelled);
        } catch (TarExtractor.InterruptedIOException2 e) {
            throw new Cancelled();
        }
        Log.i(TAG, "unpacked base " + x);
        if (x.errors > 0 || x.skippedUnsafe > 0) throw new Failure("unpack", "base " + x);
    }

    /** sha256 of the whole stored asset (a second read; 63 MB in well under a second). */
    private String baseAssetSha256() throws IOException {
        try (InputStream in = paths.ctx.getAssets().open(LocalEngineConfig.BASE_ASSET, android.content.res.AssetManager.ACCESS_STREAMING)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) md.update(buf, 0, n);
            return EngineSignature.hex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    /** true when this APK carries a base layer asset. */
    boolean baseBundled() {
        try (InputStream in = paths.ctx.getAssets().open(LocalEngineConfig.BASE_ASSET)) {
            return in != null;
        } catch (IOException e) {
            return false;
        }
    }

    // ---------- http ----------

    private void checkSpace(long need) throws Failure {
        long free = new StatFs(paths.ctx.getFilesDir().getPath()).getAvailableBytes();
        if (free < need) throw new Failure("space", (need >> 20) + "MB");
    }

    /** https anywhere; http only to the emulator host / loopback in debuggable builds (test registries). */
    void checkUrl(String u) throws Failure {
        if (u == null) throw new Failure("registry", "no url");
        URI uri;
        try { uri = URI.create(u); } catch (IllegalArgumentException e) { throw new Failure("registry", "bad url"); }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (uri.getUserInfo() != null || uri.getHost() == null) throw new Failure("registry", "bad url");
        if (scheme.equals("https")) return;
        List<String> local = Arrays.asList("127.0.0.1", "localhost", "10.0.2.2");
        if (scheme.equals("http") && allowCleartextLoopback && local.contains(uri.getHost())) return;
        throw new Failure("registry", "url must be https");
    }

    /**
     * Opens url and follows at most MAX_REDIRECTS redirects itself (npmmirror answers tarballs with a 302 to its CDN):
     * every hop must pass checkUrl, and the Range header is sent again on each. The caller reads the final response.
     */
    private HttpURLConnection openFollowing(String url, long have, String range) throws IOException {
        String cur = url;
        for (int hop = 0; ; hop++) {
            checkUrl(cur);
            HttpURLConnection c = open(cur);
            if (range != null) c.setRequestProperty("Range", range);
            int st = c.getResponseCode();
            if (st != 301 && st != 302 && st != 303 && st != 307 && st != 308) return c;
            String loc = c.getHeaderField("Location");
            c.disconnect();
            if (loc == null || hop >= MAX_REDIRECTS) throw new Failure("network", "redirect");
            cur = URI.create(cur).resolve(loc).toString();
        }
    }

    /** A small GET (packument). 404 = Failure("registry_missing"). */
    private byte[] getSmall(String url, int cap, String accept) throws IOException {
        checkUrl(url);
        HttpURLConnection c = open(url);
        conn = c;
        try {
            if (accept != null) c.setRequestProperty("Accept", accept);
            int st = c.getResponseCode();
            if (st == 404) throw new Failure("registry_missing", null);
            if (st != 200) throw new Failure("registry", "http " + st);
            return readCapped(c.getInputStream(), cap);
        } finally {
            conn = null;
            c.disconnect();
        }
    }

    private HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(CONNECT_MS);
        c.setReadTimeout(READ_MS);
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        c.setRequestProperty("Accept-Encoding", "identity");
        return c;
    }

    private static byte[] readCapped(InputStream in, int cap) throws IOException {
        try (InputStream s = in) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = s.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                if (out.size() > cap) throw new IOException("too large");
            }
            return out.toByteArray();
        }
    }

    private static String host(String url) {
        try { return URI.create(url).getHost(); } catch (Exception e) { return "?"; }
    }

    private static boolean exists(File f) {
        try { Os.lstat(f.getPath()); return true; } catch (Exception e) { return false; }
    }
}
