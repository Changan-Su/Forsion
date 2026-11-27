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
 */
final class LocalEngineInstaller {
    private static final String TAG = "LocalEngine";
    private static final int CONNECT_MS = 15_000;
    private static final int READ_MS = 30_000;

    interface Listener {
        /** phase = downloading | unpacking | checking; done / total in bytes of the current phase. */
        void progress(String phase, String layer, long done, long total);
    }

    static final class Layer {
        final String id, version, url, sha256;
        final long size, unpackedSize;

        Layer(String id, JSONObject o, URI manifestUri) throws IOException {
            this.id = id;
            this.version = o.optString("version", "");
            this.sha256 = o.optString("sha256", "").toLowerCase(Locale.ROOT);
            this.size = o.optLong("size", -1);
            this.unpackedSize = o.optLong("unpackedSize", 0);
            String u = o.optString("url", "");
            if (version.isEmpty() || !sha256.matches("[0-9a-f]{64}") || size <= 0 || u.isEmpty()) throw new IOException("bad manifest layer " + id);
            this.url = manifestUri.resolve(u).toString();
        }

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

    private void writeInstalled(Layer base, Layer engine) throws IOException {
        JSONObject o = new JSONObject();
        try {
            o.put("base", base.installedRecord());
            o.put("engine", engine.installedRecord());
            o.put("installedAt", System.currentTimeMillis());
        } catch (Exception ignored) {}
        LocalEnginePaths.writeText(paths.installedJson, o.toString());
    }

    // ---------- install / update ----------

    /** Fresh install (or reset): both layers into rootfs.new, then swap. */
    void installFresh(Manifest m, Listener l) throws IOException {
        cancelled = false;
        long need = m.base.size + m.engine.size + m.base.unpackedSize + m.engine.unpackedSize + (64L << 20) - partBytes(m.base) - partBytes(m.engine);
        checkSpace(need);
        File baseArc = download(m.base, l);
        File engArc = download(m.engine, l);
        File fresh = new File(paths.base, "rootfs.new");
        LocalEnginePaths.deleteTree(fresh);
        unpack(baseArc, fresh, m.base, l);
        unpack(engArc, fresh, m.engine, l);
        File old = new File(paths.base, "rootfs.old");
        LocalEnginePaths.deleteTree(old);
        if (exists(paths.rootfs) && !paths.rootfs.renameTo(old)) throw new Failure("unpack", "swap");
        if (!fresh.renameTo(paths.rootfs)) throw new Failure("unpack", "swap");
        LocalEnginePaths.deleteTree(old);
        paths.prepareRootfs();
        writeInstalled(m.base, m.engine);
        baseArc.delete();
        engArc.delete();
    }

    /** Engine layer only: replaces /opt/tangu, keeps everything else in the environment. */
    void updateEngine(Manifest m, JSONObject installed, Listener l) throws IOException {
        cancelled = false;
        checkSpace(m.engine.size + m.engine.unpackedSize + (32L << 20) - partBytes(m.engine));
        File engArc = download(m.engine, l);
        File staging = new File(paths.base, "engine.new");
        LocalEnginePaths.deleteTree(staging);
        unpack(engArc, staging, m.engine, l);
        File newTangu = new File(staging, "opt/tangu");
        if (!new File(newTangu, "dist/standalone/main.js").exists()) throw new Failure("unpack", "engine layer has no opt/tangu");
        File cur = new File(paths.rootfs, "opt/tangu");
        File old = new File(paths.base, "tangu.old");
        LocalEnginePaths.deleteTree(old);
        new File(paths.rootfs, "opt").mkdirs();
        if (exists(cur) && !cur.renameTo(old)) throw new Failure("unpack", "swap");
        if (!newTangu.renameTo(cur)) {
            old.renameTo(cur);
            throw new Failure("unpack", "swap");
        }
        LocalEnginePaths.deleteTree(old);
        LocalEnginePaths.deleteTree(staging);
        paths.prepareRootfs();
        Layer base;
        try {
            base = new Layer("base", new JSONObject()
                    .put("version", installed.getJSONObject("base").optString("version"))
                    .put("sha256", installed.getJSONObject("base").optString("sha256"))
                    .put("size", 1).put("url", "x"), URI.create("https://x/"));
        } catch (Exception e) {
            base = m.base;
        }
        writeInstalled(base, m.engine);
        engArc.delete();
    }

    /** Removes the environment (not home / workspace: conversations and files stay). */
    void removeEnvironment() {
        cancel();
        LocalEnginePaths.deleteTree(paths.installedJson);
        LocalEnginePaths.deleteTree(paths.rootfs);
        LocalEnginePaths.deleteTree(new File(paths.base, "rootfs.new"));
        LocalEnginePaths.deleteTree(new File(paths.base, "rootfs.old"));
        LocalEnginePaths.deleteTree(new File(paths.base, "engine.new"));
        LocalEnginePaths.deleteTree(new File(paths.base, "tangu.old"));
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

    private File download(Layer layer, Listener l) throws IOException {
        paths.downloads.mkdirs();
        File done = archiveFile(layer);
        if (done.exists() && done.length() == layer.size && layer.sha256.equals(sha256(done, layer, l))) return done;
        done.delete();
        // archives of other versions are dead weight
        String[] olds = paths.downloads.list();
        if (olds != null) for (String n : olds) if (n.startsWith(layer.id + "-") && !n.startsWith(done.getName())) new File(paths.downloads, n).delete();
        File part = new File(done.getPath() + ".part");
        for (int attempt = 0; attempt < 3; attempt++) {
            if (cancelled) throw new Cancelled();
            long have = part.exists() ? part.length() : 0;
            if (have > layer.size) { part.delete(); have = 0; }
            if (have < layer.size) {
                HttpURLConnection c = open(layer.url);
                conn = c;
                try {
                    if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
                    int st = c.getResponseCode();
                    boolean append = have > 0 && st == 206;
                    if (st != 200 && st != 206) throw new Failure("download", "http " + st);
                    if (!append) have = 0;
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, append)) {
                        byte[] buf = new byte[1 << 16];
                        long lastReport = 0;
                        for (int n; (n = in.read(buf)) >= 0; ) {
                            if (cancelled) throw new Cancelled();
                            out.write(buf, 0, n);
                            have += n;
                            if (have > layer.size) throw new Failure("download", "larger than the manifest says");
                            if (have - lastReport >= (512 << 10)) { lastReport = have; l.progress("downloading", layer.id, have, layer.size); }
                        }
                    }
                } catch (Cancelled e) {
                    throw e;
                } catch (IOException e) {
                    if (cancelled) throw new Cancelled();
                    Log.w(TAG, "download " + layer.id + " attempt " + attempt + ": " + e);
                    if (attempt == 2) throw e instanceof Failure ? e : new Failure("network", e.getClass().getSimpleName());
                    try { Thread.sleep(1500L * (attempt + 1)); } catch (InterruptedException ie) { throw new Cancelled(); }
                    continue;
                } finally {
                    conn = null;
                    c.disconnect();
                }
            }
            l.progress("downloading", layer.id, layer.size, layer.size);
            String got = sha256(part, layer, l);
            if (!layer.sha256.equals(got)) {
                part.delete();
                throw new Failure("checksum", layer.id);
            }
            if (!part.renameTo(done)) throw new Failure("download", "rename");
            return done;
        }
        throw new Failure("network", "retries");
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
        TarExtractor x = new TarExtractor(dest);
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
