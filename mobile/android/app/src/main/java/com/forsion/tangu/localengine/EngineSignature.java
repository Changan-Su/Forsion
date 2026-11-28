package com.forsion.tangu.localengine;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Verifies an unpacked engine package (npm @forsion/tangu-engine-android-arm64) before anything in it runs.
 *
 * The package carries forsion-signed.json and forsion-signed.sig (base64 Ed25519). The signed message is
 * CONTEXT + the exact bytes of forsion-signed.json: the bytes are verified first and parsed only afterwards, so Java never
 * re-serialises anything. The context line is not JSON, so a desktop engine SIGNATURE (a JSON table signed with the same
 * key) can never pass here. Producer: mobile/scripts/local-engine/pack-android-engine.mjs (same constants).
 *
 * forsion-signed.json = { name, version, line, schemaFiles: [path…], schemaFingerprint, files: { path: [sha256hex, size] } }.
 * Accepted only if: the signature verifies under a key shipped in the APK; name / version / line are the ones asked for;
 * version is at least the APK's minimum; the tree holds exactly the listed regular files (no links, nothing extra or
 * missing, sizes and hashes equal; the two signature files aside); within MAX_FILES / MAX_BYTES; package.json agrees on
 * name and version; and the schema fingerprint recomputes from the listed hashes.
 */
final class EngineSignature {
    static final String CONTEXT = "forsion-android-engine-v1\n";
    static final String SIGNED_FILE = "forsion-signed.json";
    static final String SIG_FILE = "forsion-signed.sig";
    static final int MAX_FILES = 20_000;
    static final long MAX_BYTES = 400L << 20;
    static final int MAX_SIGNED_BYTES = 8 << 20;

    /**
     * The engine signing key (tangu-agent/src/boot/signingKey.ts, SPKI base64 MCowBQYDK2VwAyEAO18f9nC/LKWH2pvmM99snGnI+FsTQsM/ZI90NXtwkXo=),
     * raw 32 bytes. EngineSignatureTest checks it against that file. Never from a download.
     */
    static final String PRODUCTION_KEY_HEX = "3b5f1ff670bf2ca587da9be633df6c9c69c8f85b1342c33f648f74357b70917a";

    interface Progress { void onBytes(long hashed, long total); }

    interface Cancel { boolean cancelled(); }

    static final class Result {
        final String name, version, fingerprint;
        final int line, files;
        final long bytes;

        Result(String name, String version, int line, String fingerprint, int files, long bytes) {
            this.name = name; this.version = version; this.line = line; this.fingerprint = fingerprint; this.files = files; this.bytes = bytes;
        }
    }

    /** Refusal: code is the page's error code (always "signature"), detail says which check. */
    static final class Refused extends IOException {
        Refused(String detail) { super(detail); }
    }

    /**
     * @param expectedVersion null = any version (re-verifying a tree already on disk: the caller compares)
     */
    static Result verify(File root, List<byte[]> keys, String expectedName, String expectedVersion, int line, String minVersion,
                         Progress progress, Cancel cancel) throws IOException {
        byte[] signed = readCapped(new File(root, SIGNED_FILE), MAX_SIGNED_BYTES);
        byte[] sig;
        try {
            String s = new String(readCapped(new File(root, SIG_FILE), 1024), StandardCharsets.US_ASCII).trim();
            sig = java.util.Base64.getDecoder().decode(s);
        } catch (IllegalArgumentException e) {
            throw new Refused("signature is not base64");
        }
        byte[] ctx = CONTEXT.getBytes(StandardCharsets.UTF_8);
        byte[] msg = new byte[ctx.length + signed.length];
        System.arraycopy(ctx, 0, msg, 0, ctx.length);
        System.arraycopy(signed, 0, msg, ctx.length, signed.length);
        boolean ok = false;
        for (byte[] k : keys) if (Ed25519.verify(k, msg, sig)) { ok = true; break; }
        if (!ok) throw new Refused("bad signature");

        // signed: from here on the content is the publisher's
        JSONObject m;
        String name, version, fingerprint;
        int gotLine;
        Map<String, String> sha = new HashMap<>();
        Map<String, Long> size = new HashMap<>();
        List<String> schema = new ArrayList<>();
        long total = 0;
        try {
            m = new JSONObject(new String(signed, StandardCharsets.UTF_8));
            name = m.getString("name");
            version = m.getString("version");
            Object l = m.get("line");
            if (!(l instanceof Integer)) throw new Refused("line is not an integer");
            gotLine = (Integer) l;
            fingerprint = m.getString("schemaFingerprint");
            JSONObject files = m.getJSONObject("files");
            if (files.length() > MAX_FILES) throw new Refused("too many files");
            for (Iterator<String> it = files.keys(); it.hasNext(); ) {
                String p = it.next();
                if (!safePath(p)) throw new Refused("unsafe path " + p);
                JSONArray e = files.getJSONArray(p);
                String h = e.getString(0);
                Object n = e.get(1);
                if (e.length() != 2 || !h.matches("[0-9a-f]{64}") || !(n instanceof Integer || n instanceof Long)) throw new Refused("bad entry " + p);
                long sz = ((Number) n).longValue();
                if (sz < 0 || sz > MAX_BYTES) throw new Refused("bad size " + p);
                total += sz;
                if (total > MAX_BYTES) throw new Refused("too large");
                sha.put(p, h);
                size.put(p, sz);
            }
            JSONArray sf = m.getJSONArray("schemaFiles");
            for (int i = 0; i < sf.length(); i++) schema.add(sf.getString(i));
        } catch (org.json.JSONException e) {
            throw new Refused("bad signed table");
        }
        if (!expectedName.equals(name)) throw new Refused("name " + name);
        if (!Versions.isRelease(version)) throw new Refused("version " + version);
        if (expectedVersion != null && !expectedVersion.equals(version)) throw new Refused("version " + version + " (asked for " + expectedVersion + ")");
        if (gotLine != line) throw new Refused("line " + gotLine + " (this app is line " + line + ")");
        if (minVersion != null && !minVersion.isEmpty() && Versions.compare(version, minVersion) < 0) throw new Refused("version " + version + " is older than " + minVersion);
        for (String need : new String[]{"package.json", "dist/standalone/main.js"}) if (!sha.containsKey(need)) throw new Refused("missing " + need);
        if (schema.isEmpty()) throw new Refused("no schema files");
        for (String s : schema) if (!sha.containsKey(s)) throw new Refused("schema file not in table " + s);
        if (!fingerprint(schema, sha).equals(fingerprint)) throw new Refused("schema fingerprint");

        // the tree: exactly the table (plus the two signature files), regular files and directories only
        Set<String> seen = new HashSet<>();
        long[] hashed = {0};
        walk(root, "", sha, size, seen, hashed, total, progress, cancel);
        if (seen.size() != sha.size()) throw new Refused("missing files: " + (sha.size() - seen.size()));

        try {
            JSONObject pkg = new JSONObject(new String(readCapped(new File(root, "package.json"), 1 << 20), StandardCharsets.UTF_8));
            if (!name.equals(pkg.optString("name")) || !version.equals(pkg.optString("version"))) throw new Refused("package.json disagrees");
        } catch (org.json.JSONException e) {
            throw new Refused("package.json unreadable");
        }
        return new Result(name, version, gotLine, fingerprint, sha.size(), total);
    }

    /** sha256 hex of the sorted "path:sha256\n" lines of the schema files. */
    static String fingerprint(List<String> schemaFiles, Map<String, String> sha) {
        List<String> sorted = new ArrayList<>(schemaFiles);
        Collections.sort(sorted);
        StringBuilder sb = new StringBuilder();
        for (String p : sorted) sb.append(p).append(':').append(sha.get(p)).append('\n');
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(sb.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void walk(File dir, String rel, Map<String, String> sha, Map<String, Long> size, Set<String> seen, long[] hashed,
                             long total, Progress progress, Cancel cancel) throws IOException {
        String[] kids = dir.list();
        if (kids == null) throw new Refused("unreadable " + (rel.isEmpty() ? "." : rel));
        for (String k : kids) {
            if (cancel != null && cancel.cancelled()) throw new LocalEngineInstaller.Cancelled();
            String r = rel.isEmpty() ? k : rel + "/" + k;
            File f = new File(dir, k);
            BasicFileAttributes a = Files.readAttributes(f.toPath(), BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (a.isDirectory()) {
                walk(f, r, sha, size, seen, hashed, total, progress, cancel);
                continue;
            }
            if (!a.isRegularFile()) throw new Refused("not a regular file: " + r);
            if (rel.isEmpty() && (k.equals(SIGNED_FILE) || k.equals(SIG_FILE))) continue;
            String want = sha.get(r);
            if (want == null) throw new Refused("not in the table: " + r);
            if (a.size() != size.get(r)) throw new Refused("size " + r);
            if (!want.equals(sha256(f, hashed, total, progress, cancel))) throw new Refused("hash " + r);
            seen.add(r);
        }
    }

    static boolean safePath(String p) {
        if (p.isEmpty() || p.startsWith("/") || p.endsWith("/") || p.indexOf('\\') >= 0 || p.indexOf('\0') >= 0) return false;
        if (p.equals(SIGNED_FILE) || p.equals(SIG_FILE)) return false;
        for (String seg : p.split("/", -1)) if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) return false;
        return true;
    }

    private static String sha256(File f, long[] hashed, long total, Progress progress, Cancel cancel) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[1 << 16];
                long lastReport = hashed[0];
                for (int n; (n = in.read(buf)) > 0; ) {
                    md.update(buf, 0, n);
                    hashed[0] += n;
                    if (progress != null && hashed[0] - lastReport >= (4 << 20)) {
                        lastReport = hashed[0];
                        if (cancel != null && cancel.cancelled()) throw new LocalEngineInstaller.Cancelled();
                        progress.onBytes(hashed[0], total);
                    }
                }
            }
            return hex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
        return s.toString();
    }

    static byte[] unhex(String h) {
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    private static byte[] readCapped(File f, int cap) throws IOException {
        if (!f.isFile()) throw new Refused("missing " + f.getName());
        if (f.length() > cap) throw new Refused(f.getName() + " too large");
        try (InputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                if (out.size() > cap) throw new Refused(f.getName() + " too large");
            }
            return out.toByteArray();
        }
    }
}
