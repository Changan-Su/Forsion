package com.forsion.tangu.localengine;

import android.os.StatFs;
import android.system.Os;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
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
import java.util.List;
import java.util.Locale;

/**
 * Downloads (resumable, sha256-checked, pausable) and unpacks the two environment layers.
 *
 * Manifest (schema 1, built by mobile/scripts/local-engine/build-env.sh; urls are relative to the manifest):
 *   { "schema": 1, "arch": "arm64",
 *     "base":   { "version", "url", "sha256", "size", "unpackedSize" },   Ubuntu + git + Node 24, changes rarely
 *     "engine": { "version", "url", "sha256", "size", "unpackedSize" } } /opt/tangu, follows the app
 *
 * A fresh install unpacks both into rootfs.new and swaps it in; an update replaces only /opt/tangu, so what the agent
 * installed into the base stays. Any entry the extractor refuses (unsafe path, failed entry) fails the install:
 * a half environment is worse than none.
 *
 * Swaps keep the previous generation until the new one passes the self-test: pending.json (the record of the new
 * generation) is written before anything moves, the previous tree is renamed aside (rootfs.old / tangu.old), and the
 * commit is the rename pending.json → installed.json. A failed self-test puts the previous tree back; a process
 * killed mid-swap is rolled back by recover() on the next start (pending.json still there = not committed).
 */
final class LocalEngineInstaller {
    private static final String TAG = "LocalEngine";
    private static final int CONNECT_MS = 15_000;
    private static final int READ_MS = 30_000;

    interface Listener {
        /** phase = downloading | unpacking | checking; done / total in bytes of the current phase. */
        void progress(String phase, String layer, long done, long total);
    }

    /** The destructive part of a swap, supplied by LocalEngine. */
    interface Swap {
        /** Called once the new tree is staged and before the live one moves: stop the engine and block starts. */
        void enter() throws IOException;

        /** Self-test of the tree now at rootfs; null = good, otherwise why not (the swap is rolled back). */
        String validate();
    }

    /** Manifest sizes are bounded so that space checks cannot overflow and a layer cannot claim the whole disk. */
    static final long MAX_LAYER_BYTES = 4L << 30;
    static final long MAX_UNPACKED_BYTES = 16L << 30;

    static final class Layer {
        final String id, version, url, sha256;
        final long size, unpackedSize;

        Layer(String id, JSONObject o, URI manifestUri) throws IOException {
            this.id = id;
            this.version = o.optString("version", "");
            this.sha256 = o.optString("sha256", "").toLowerCase(Locale.ROOT);
            this.size = boundedSize(o, "size", MAX_LAYER_BYTES);
            this.unpackedSize = boundedSize(o, "unpackedSize", MAX_UNPACKED_BYTES);
            String u = o.optString("url", "");
            if (version.isEmpty() || !sha256.matches("[0-9a-f]{64}") || u.isEmpty()) throw new IOException("bad manifest layer " + id);
            this.url = manifestUri.resolve(u).toString();
        }

        /** Engine-only record carried over from installed.json (no download fields). */
        private Layer(String id, String version, String sha256) {
            this.id = id; this.version = version; this.sha256 = sha256; this.url = ""; this.size = 0; this.unpackedSize = 0;
        }

        /** An integer JSON number in 1..max; anything else (missing, string, fraction, negative, huge) refuses the manifest. */
        private static long boundedSize(JSONObject o, String key, long max) throws IOException {
            Object v = o.opt(key);
            if (!(v instanceof Integer || v instanceof Long)) throw new IOException("bad manifest " + key);
            long n = ((Number) v).longValue();
            if (n <= 0 || n > max) throw new IOException("bad manifest " + key);
            return n;
        }

        /** Extraction may write at most this much (du sizes count hard links once; the extractor copies them). */
        long extractBudget() { return unpackedSize + unpackedSize / 2 + (64L << 20); }

        JSONObject installedRecord() {
            JSONObject o = new JSONObject();
            try { o.put("version", version); o.put("sha256", sha256); } catch (Exception ignored) {}
            return o;
        }
    }

    static final class Manifest {
        final Layer base, engine;

        Manifest(Layer base, Layer engine) { this.base = base; this.engine = engine; }
    }

    /** Thrown on pause / delete while downloading or unpacking. */
    static final class Cancelled extends IOException {
        Cancelled() { super("cancelled"); }
    }

    /** User-facing failure: code is what the page shows (local_engine.error.<code>). */
    static final class Failure extends IOException {
        final String code;

        Failure(String code, String detail) { super(code + (detail == null ? "" : ": " + detail)); this.code = code; }
    }

    private final LocalEnginePaths paths;
    private final boolean allowCleartextLoopback;
    private volatile boolean cancelled;
    private volatile HttpURLConnection conn;

    LocalEngineInstaller(LocalEnginePaths paths, boolean debuggable) {
        this.paths = paths;
        this.allowCleartextLoopback = debuggable;
    }

    void cancel() {
        cancelled = true;
        HttpURLConnection c = conn;
        if (c != null) try { c.disconnect(); } catch (RuntimeException ignored) {}
    }

    // ---------- manifest ----------

    Manifest fetchManifest(String manifestUrl) throws IOException {
        checkUrl(manifestUrl);
        HttpURLConnection c = open(manifestUrl);
        try {
            int st = c.getResponseCode();
            if (st != 200) throw new Failure("manifest", "http " + st);
            byte[] body = readCapped(c.getInputStream(), 64 * 1024);
            JSONObject m = new JSONObject(new String(body, StandardCharsets.UTF_8));
            if (m.optInt("schema", 0) != 1 || !"arm64".equals(m.optString("arch"))) throw new Failure("manifest", "unsupported schema");
            URI uri = URI.create(manifestUrl);
            Manifest out = new Manifest(new Layer("base", m.getJSONObject("base"), uri), new Layer("engine", m.getJSONObject("engine"), uri));
            checkUrl(out.base.url);
            checkUrl(out.engine.url);
            return out;
        } catch (org.json.JSONException e) {
            throw new Failure("manifest", "bad json");
        } finally {
            c.disconnect();
        }
    }

    // ---------- installed state ----------

    JSONObject installed() {
        String s = LocalEnginePaths.readSmall(paths.installedJson.getPath());
        if (s == null || s.isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(s);
            if (!o.has("base") || !o.has("engine")) return null;
            if (!new File(paths.rootfs, "opt/tangu/dist/standalone/main.js").exists()) return null;
            return o;
        } catch (Exception e) {
            return null; // unreadable = unknown; the page offers reset, nothing is deleted on our own
        }
    }

    private File pendingJson() { return new File(paths.base, "pending.json"); }

    private File oldRootfs() { return new File(paths.base, "rootfs.old"); }

    private File oldTangu() { return new File(paths.base, "tangu.old"); }

    private File trash() { return new File(paths.base, "trash"); }

    /** Step 1 of a swap: the record of the new generation, before anything moves (kind = fresh | engine; hadOld = a previous tree is being set aside). */
    private void writePending(String kind, boolean hadOld, Layer base, Layer engine) throws IOException {
        JSONObject o = new JSONObject();
        try {
            o.put("kind", kind);
            o.put("hadOld", hadOld);
            o.put("base", base.installedRecord());
            o.put("engine", engine.installedRecord());
            o.put("installedAt", System.currentTimeMillis());
        } catch (Exception ignored) {}
        LocalEnginePaths.writeText(pendingJson(), o.toString());
    }

    /** The commit point: one rename. */
    private void commit() throws IOException {
        try {
            Os.rename(pendingJson().getPath(), paths.installedJson.getPath());
        } catch (android.system.ErrnoException e) {
            throw new Failure("unpack", "commit " + e.getMessage());
        }
    }

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

    /** The commit; if the rename itself fails, the swap is undone like a failed self-test. */
    private void commitOrRollback(File live, File old, boolean hadOld) throws IOException {
        try {
            commit();
        } catch (IOException e) {
            rollback(live, old, hadOld);
            throw e;
        }
    }

    /**
     * Undoes a swap that did not commit. pending.json is dropped only once the previous tree is back in place; if
     * putting it back fails, pending.json stays and recover() retries on the next start (never trashing it).
     */
    private void rollback(File live, File old, boolean hadOld) {
        if (hadOld ? putBack(live, old) : true) {
            if (!hadOld) toTrash(live);
            pendingJson().delete();
        }
    }

    /**
     * After a process death mid-swap: pending.json still there = the swap never committed → put the previous tree
     * back; no pending.json but a previous tree still aside = committed, the leftover goes to the trash. Renames
     * only (fast); call before anything reads installed() or starts the engine.
     */
    void recover() {
        File pending = pendingJson();
        if (exists(pending)) {
            // an unreadable journal: judge by what is on disk (only one kind of swap runs at a time)
            String kind = exists(oldTangu()) ? "engine" : "fresh";
            boolean hadOld = exists("engine".equals(kind) ? oldTangu() : oldRootfs());
            try {
                JSONObject j = new JSONObject(LocalEnginePaths.readSmall(pending.getPath()));
                if (j.has("kind")) kind = j.getString("kind");
                if (j.has("hadOld")) hadOld = j.getBoolean("hadOld");
            } catch (Exception ignored) {}
            boolean restored;
            if ("engine".equals(kind)) {
                restored = putBack(new File(paths.rootfs, "opt/tangu"), oldTangu());
            } else {
                restored = putBack(paths.rootfs, oldRootfs());
                // an interrupted first install: whatever got swapped in never passed its self-test
                if (restored && !hadOld && !exists(oldRootfs()) && !exists(paths.installedJson)) toTrash(paths.rootfs);
            }
            if (!restored) {
                // keep pending.json and the previous tree aside: the next start tries again, nothing gets trashed
                Log.w(TAG, "could not restore the previous environment after an interrupted " + kind + " swap");
                return;
            }
            pending.delete();
            Log.w(TAG, "recovered an interrupted " + kind + " swap: previous environment restored");
        }
        toTrash(oldRootfs());
        toTrash(oldTangu());
        toTrash(new File(paths.base, "rootfs.new"));
        toTrash(new File(paths.base, "engine.new"));
    }

    // ---------- install / update ----------

    /** Fresh install (or reset): both layers into rootfs.new, then swap; the previous environment stays until the new one passes. */
    void installFresh(Manifest m, Listener l, Swap swap) throws IOException {
        cancelled = false;
        ensureRecovered();
        // free space for what the confirmation promised (download + unpacked size) plus a margin; extractBudget is only
        // the cap that stops a lying archive, not a reservation (bounded sizes, see Layer: no overflow)
        long need = m.base.size + m.engine.size + m.base.unpackedSize + m.engine.unpackedSize + (64L << 20) - partBytes(m.base) - partBytes(m.engine);
        checkSpace(need);
        File baseArc = download(m.base, l);
        File engArc = download(m.engine, l);
        File fresh = new File(paths.base, "rootfs.new");
        LocalEnginePaths.deleteTree(fresh);
        unpack(baseArc, fresh, m.base, l);
        unpack(engArc, fresh, m.engine, l);
        if (cancelled) throw new Cancelled();
        swap.enter();
        File old = oldRootfs();
        toTrash(old); // nothing pending (ensureRecovered): a leftover from a committed swap
        boolean hadOld = exists(paths.rootfs);
        writePending("fresh", hadOld, m.base, m.engine);
        if (hadOld && !paths.rootfs.renameTo(old)) { pendingJson().delete(); throw new Failure("unpack", "swap"); }
        if (!fresh.renameTo(paths.rootfs)) {
            rollback(paths.rootfs, old, hadOld);
            throw new Failure("unpack", "swap");
        }
        String why;
        try {
            paths.prepareRootfs();
            l.progress("checking", "engine", 0, 0);
            why = swap.validate();
        } catch (IOException e) {
            why = "prepare " + e.getMessage();
        }
        if (why != null) {
            rollback(paths.rootfs, old, hadOld);
            throw new Failure("selftest", why);
        }
        commitOrRollback(paths.rootfs, old, hadOld);
        toTrash(old);
        baseArc.delete();
        engArc.delete();
    }

    /** Engine layer only: replaces /opt/tangu, keeps everything else in the environment; the previous engine stays until the new one passes. */
    void updateEngine(Manifest m, JSONObject installed, Listener l, Swap swap) throws IOException {
        cancelled = false;
        ensureRecovered();
        checkSpace(m.engine.size + m.engine.unpackedSize + (32L << 20) - partBytes(m.engine));
        File engArc = download(m.engine, l);
        File staging = new File(paths.base, "engine.new");
        LocalEnginePaths.deleteTree(staging);
        unpack(engArc, staging, m.engine, l);
        File newTangu = new File(staging, "opt/tangu");
        if (!new File(newTangu, "dist/standalone/main.js").exists()) throw new Failure("unpack", "engine layer has no opt/tangu");
        if (cancelled) throw new Cancelled();
        Layer base;
        try {
            JSONObject b = installed.getJSONObject("base");
            base = new Layer("base", b.optString("version"), b.optString("sha256"));
        } catch (Exception e) {
            base = m.base;
        }
        swap.enter();
        File cur = new File(paths.rootfs, "opt/tangu");
        File old = oldTangu();
        toTrash(old); // nothing pending (ensureRecovered): a leftover from a committed swap
        paths.realDir("opt");
        boolean hadOld = exists(cur);
        writePending("engine", hadOld, base, m.engine);
        if (hadOld && !cur.renameTo(old)) { pendingJson().delete(); throw new Failure("unpack", "swap"); }
        if (!newTangu.renameTo(cur)) {
            rollback(cur, old, hadOld);
            throw new Failure("unpack", "swap");
        }
        String why;
        try {
            paths.prepareRootfs();
            l.progress("checking", "engine", 0, 0);
            why = swap.validate();
        } catch (IOException e) {
            why = "prepare " + e.getMessage();
        }
        if (why != null) {
            rollback(cur, old, hadOld);
            throw new Failure("selftest", why);
        }
        commitOrRollback(cur, old, hadOld);
        toTrash(old);
        toTrash(staging);
        engArc.delete();
    }

    /** Removes the environment (not home / workspace: conversations and files stay). */
    void removeEnvironment() {
        cancel();
        LocalEnginePaths.deleteTree(paths.installedJson);
        LocalEnginePaths.deleteTree(pendingJson());
        LocalEnginePaths.deleteTree(paths.rootfs);
        LocalEnginePaths.deleteTree(new File(paths.base, "rootfs.new"));
        LocalEnginePaths.deleteTree(oldRootfs());
        LocalEnginePaths.deleteTree(new File(paths.base, "engine.new"));
        LocalEnginePaths.deleteTree(oldTangu());
        LocalEnginePaths.deleteTree(trash());
        LocalEnginePaths.deleteTree(paths.downloads);
    }

    /** Bytes already downloaded for the layers (resume). */
    long downloadedBytes(Manifest m) { return partBytes(m.base) + partBytes(m.engine); }

    // ---------- download ----------

    private File archiveFile(Layer layer) { return new File(paths.downloads, layer.id + "-" + layer.sha256.substring(0, 16) + ".tar"); }

    private long partBytes(Layer layer) {
        File done = archiveFile(layer);
        if (done.exists()) return done.length();
        File part = new File(done.getPath() + ".part");
        return part.exists() ? part.length() : 0;
    }

    private static final java.util.regex.Pattern CONTENT_RANGE = java.util.regex.Pattern.compile("^bytes (\\d+)-(\\d+)/(\\d+|\\*)$");

    /**
     * Resumable download into <archive>.part. A 206 is appended only when its Content-Range starts exactly where the
     * partial file ends (and the total, when given, matches the manifest); a 200 starts over. A transfer that ends
     * short keeps its bytes and resumes; the hash is taken only once the file has exactly the manifest's size.
     */
    private File download(Layer layer, Listener l) throws IOException {
        paths.downloads.mkdirs();
        File done = archiveFile(layer);
        if (done.exists() && done.length() == layer.size && layer.sha256.equals(sha256(done, layer, l))) return done;
        done.delete();
        // archives of other versions are dead weight
        String[] olds = paths.downloads.list();
        if (olds != null) for (String n : olds) if (n.startsWith(layer.id + "-") && !n.startsWith(done.getName())) new File(paths.downloads, n).delete();
        File part = new File(done.getPath() + ".part");
        int failures = 0;
        for (int round = 0; ; round++) {
            if (cancelled) throw new Cancelled();
            long have = part.exists() ? part.length() : 0;
            if (have > layer.size) { part.delete(); have = 0; }
            if (have == layer.size) break;
            if (round >= 50) throw new Failure("network", "too many interrupted transfers");
            long before = have;
            try {
                fetchInto(layer, part, have, l);
            } catch (Cancelled e) {
                throw e;
            } catch (IOException e) {
                if (cancelled) throw new Cancelled();
                long now = part.exists() ? part.length() : 0;
                // only consecutive attempts without progress count: a flaky line that keeps delivering is not a dead one
                failures = now > before ? 0 : failures + 1;
                Log.w(TAG, "download " + layer.id + " (" + now + "/" + layer.size + "): " + e);
                if (failures >= 3) throw e instanceof Failure ? e : new Failure("network", e.getClass().getSimpleName());
                try { Thread.sleep(1500L * Math.max(1, failures)); } catch (InterruptedException ie) { throw new Cancelled(); }
            }
        }
        l.progress("downloading", layer.id, layer.size, layer.size);
        String got = sha256(part, layer, l);
        if (!layer.sha256.equals(got)) {
            part.delete(); // full size and wrong: these bytes will never become right
            throw new Failure("checksum", layer.id);
        }
        if (!part.renameTo(done)) throw new Failure("download", "rename");
        return done;
    }

    /** One request: appends to part from `have` (or starts over on 200). Throws on anything short of the full size. */
    private void fetchInto(Layer layer, File part, long have, Listener l) throws IOException {
        HttpURLConnection c = open(layer.url);
        conn = c;
        try {
            if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
            int st = c.getResponseCode();
            boolean append;
            if (st == 206) {
                // we asked for bytes=have- : the answer must be exactly have..size-1 (of size)
                java.util.regex.Matcher m = CONTENT_RANGE.matcher(String.valueOf(c.getHeaderField("Content-Range")).trim());
                boolean ok;
                try {
                    ok = have > 0 && m.matches() && Long.parseLong(m.group(1)) == have && Long.parseLong(m.group(2)) == layer.size - 1
                            && (m.group(3).equals("*") || Long.parseLong(m.group(3)) == layer.size);
                } catch (NumberFormatException e) {
                    ok = false;
                }
                if (!ok) { part.delete(); throw new IOException("unexpected Content-Range"); } // start over next round
                append = true;
            } else if (st == 200) {
                append = false; // server ignored the range: the body is the whole file
                have = 0;
            } else if (st == 416) {
                part.delete();
                throw new IOException("range not satisfiable");
            } else {
                throw new Failure("download", "http " + st);
            }
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, append)) {
                byte[] buf = new byte[1 << 16];
                long lastReport = 0;
                for (int n; (n = in.read(buf)) >= 0; ) {
                    if (cancelled) throw new Cancelled();
                    if (have + n > layer.size) {
                        out.close();
                        part.delete();
                        throw new Failure("download", "larger than the manifest says");
                    }
                    out.write(buf, 0, n);
                    have += n;
                    if (have - lastReport >= (512 << 10)) { lastReport = have; l.progress("downloading", layer.id, have, layer.size); }
                }
            }
            if (have < layer.size) throw new IOException("short transfer"); // bytes kept; the next round resumes
        } finally {
            conn = null;
            c.disconnect();
        }
    }

    private String sha256(File f, Layer layer, Listener l) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long done = 0, total = f.length(), lastReport = 0;
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) {
                    if (cancelled) throw new Cancelled();
                    md.update(buf, 0, n);
                    done += n;
                    if (done - lastReport >= (4 << 20)) { lastReport = done; l.progress("checking", layer.id, done, total); }
                }
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    private void unpack(File archive, File dest, Layer layer, Listener l) throws IOException {
        TarExtractor x = new TarExtractor(dest, layer.extractBudget());
        final long total = archive.length();
        x.extract(archive, (bytes) -> l.progress("unpacking", layer.id, bytes, total), () -> cancelled);
        Log.i(TAG, "unpacked " + layer.id + " " + x);
        if (x.errors > 0 || x.skippedUnsafe > 0) throw new Failure("unpack", layer.id + " " + x);
        l.progress("unpacking", layer.id, total, total);
    }

    // ---------- helpers ----------

    private void checkSpace(long need) throws Failure {
        long free = new StatFs(paths.ctx.getFilesDir().getPath()).getAvailableBytes();
        if (free < need) throw new Failure("space", (need >> 20) + "MB");
    }

    /** https anywhere; http only to the emulator host / loopback in debuggable builds (test servers). */
    void checkUrl(String u) throws Failure {
        if (u == null) throw new Failure("manifest", "no url");
        URI uri;
        try { uri = URI.create(u); } catch (IllegalArgumentException e) { throw new Failure("manifest", "bad url"); }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (uri.getUserInfo() != null || uri.getHost() == null) throw new Failure("manifest", "bad url");
        if (scheme.equals("https")) return;
        List<String> local = Arrays.asList("127.0.0.1", "localhost", "10.0.2.2");
        if (scheme.equals("http") && allowCleartextLoopback && local.contains(uri.getHost())) return;
        throw new Failure("manifest", "url must be https");
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

    private static boolean exists(File f) {
        try { Os.lstat(f.getPath()); return true; } catch (Exception e) { return false; }
    }

    static List<String> describeLayers(Manifest m) {
        List<String> out = new ArrayList<>();
        out.add("base " + m.base.version);
        out.add("engine " + m.engine.version);
        return out;
    }
}
