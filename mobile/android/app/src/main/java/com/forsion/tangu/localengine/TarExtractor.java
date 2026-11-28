package com.forsion.tangu.localengine;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;

import java.io.BufferedInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.zip.GZIPInputStream;

import org.tukaani.xz.XZInputStream;

/**
 * Unpacks one environment layer (tar, gzip- or xz-compressed) into the app's private directory.
 *
 * Ported from the local-engine probe (docs: 手机本机引擎方案, probe-apk/TarGz.java), which unpacked the same Ubuntu
 * rootfs on an emulator and a phone with entry counts equal to `tar -tv`. Handles regular files, directories,
 * symlinks (Os.symlink), hard links (copied: apps may not create hard links), PAX x/g, GNU L/K long names and the
 * ustar prefix. Device nodes / fifos are skipped (PRoot binds the host /dev).
 *
 * Containment: entry names with ".." are refused, and nothing is written through a symlink that an earlier entry
 * created (a parent component that is a link would send the write outside the rootfs on the host side).
 */
final class TarExtractor {
    interface Progress { void onBytes(long compressedBytesRead); }
    interface Cancel { boolean cancelled(); }

    long files, dirs, symlinks, hardlinks, skippedSpecial, skippedUnsafe, bytes;
    int errors;
    final List<String> errorSamples = new ArrayList<>();

    private final File dest;
    private final String destPath;
    private final List<Object[]> dirModes = new ArrayList<>();
    /** Directories under dest already checked to be real directories (not links). */
    private final Set<String> safeDirs = new HashSet<>();

    /** Most bytes this extraction may write (regular files plus copied hard links); more fails the unpack. */
    private final long budget;
    private long written;

    /**
     * Strict (the engine tarball, unpacked before its signature is checked): only regular files and directories under
     * canonical names; a link, hard link or special entry, a non-canonical name ("a//b", "./x", "a/../b"), more than
     * maxEntries entries or a path deeper than MAX_DEPTH fails the whole unpack. With no links in the tree nothing can be
     * written through one, whatever names the archive uses.
     */
    private final boolean strict;
    private final int maxEntries;
    private long entries;
    static final int MAX_DEPTH = 64;

    TarExtractor(File dest, long budget) { this(dest, budget, false, Integer.MAX_VALUE); }

    TarExtractor(File dest, long budget, boolean strict, int maxEntries) {
        this.dest = dest;
        this.destPath = dest.getAbsolutePath();
        this.budget = budget;
        this.strict = strict;
        this.maxEntries = maxEntries;
    }

    private void spend(long n) throws IOException {
        if (n < 0 || n > budget - written) throw new LocalEngineInstaller.Failure("unpack", "archive larger than the manifest says");
        written += n;
    }

    @Override public String toString() {
        return "files=" + files + " dirs=" + dirs + " symlinks=" + symlinks + " hardlinks(copied)=" + hardlinks
                + " skippedSpecial=" + skippedSpecial + " skippedUnsafe=" + skippedUnsafe + " errors=" + errors
                + " bytes=" + bytes + (errorSamples.isEmpty() ? "" : " errorSamples=" + errorSamples);
    }

    /** Opens the right decompressor by magic bytes: xz (FD 37 7A 58 5A 00) or gzip (1F 8B); anything else is plain tar. */
    static InputStream decompress(InputStream raw) throws IOException {
        BufferedInputStream in = new BufferedInputStream(raw, 1 << 16);
        in.mark(8);
        byte[] m = new byte[6];
        int n = 0;
        while (n < m.length) { int r = in.read(m, n, m.length - n); if (r < 0) break; n += r; }
        in.reset();
        if (n >= 6 && (m[0] & 0xff) == 0xFD && m[1] == '7' && m[2] == 'z' && m[3] == 'X' && m[4] == 'Z' && m[5] == 0) {
            return new BufferedInputStream(new XZInputStream(in), 1 << 16);
        }
        if (n >= 2 && (m[0] & 0xff) == 0x1F && (m[1] & 0xff) == 0x8B) {
            return new BufferedInputStream(new GZIPInputStream(in, 1 << 16), 1 << 16);
        }
        return in;
    }

    void extract(File archive, Progress progress, Cancel cancel) throws IOException {
        extract(new FileInputStream(archive), progress, cancel);
    }

    /** From a stream (the base layer comes straight from the APK's stored asset); closes it. */
    void extract(InputStream raw, Progress progress, Cancel cancel) throws IOException {
        dest.mkdirs();
        safeDirs.add(destPath);
        try (CountingInputStream counting = new CountingInputStream(raw, progress);
             InputStream in = decompress(counting)) {
            byte[] hdr = new byte[512];
            String paxPath = null, paxLink = null, gnuName = null, gnuLink = null;
            long paxSize = -1;
            while (true) {
                if (cancel != null && cancel.cancelled()) throw new InterruptedIOException2();
                if (!readFully(in, hdr)) break;
                if (allZero(hdr)) break;
                char type = (char) hdr[156];
                long size = paxSize >= 0 ? paxSize : parseNum(hdr, 124, 12);
                String name = str(hdr, 0, 100);
                String link = str(hdr, 157, 100);
                String magic = str(hdr, 257, 6);
                if (magic.startsWith("ustar")) {
                    String prefix = str(hdr, 345, 155);
                    if (!prefix.isEmpty()) name = prefix + "/" + name;
                }
                int mode = (int) parseNum(hdr, 100, 8);
                if (type == 'x' || type == 'g') {
                    byte[] data = readData(in, size);
                    if (type == 'x') {
                        // PAX record lengths count bytes: parse on the byte array.
                        int i = 0;
                        while (i < data.length) {
                            int sp = i;
                            while (sp < data.length && data[sp] != ' ') sp++;
                            if (sp >= data.length) break;
                            int len = Integer.parseInt(new String(data, i, sp - i, StandardCharsets.US_ASCII));
                            if (len <= 0 || i + len > data.length) break;
                            String rec = new String(data, sp + 1, i + len - 1 - (sp + 1), StandardCharsets.UTF_8);
                            int eq = rec.indexOf('=');
                            if (eq > 0) {
                                String k = rec.substring(0, eq), v = rec.substring(eq + 1);
                                if (k.equals("path")) paxPath = v;
                                else if (k.equals("linkpath")) paxLink = v;
                                else if (k.equals("size")) paxSize = Long.parseLong(v);
                            }
                            i += len;
                        }
                    }
                    continue;
                }
                if (type == 'L') { gnuName = cstr(readData(in, size)); continue; }
                if (type == 'K') { gnuLink = cstr(readData(in, size)); continue; }
                if (paxPath != null) name = paxPath; else if (gnuName != null) name = gnuName;
                if (paxLink != null) link = paxLink; else if (gnuLink != null) link = gnuLink;
                paxPath = paxLink = gnuName = gnuLink = null;
                paxSize = -1;

                String rel = clean(name);
                boolean unsafe = rel == null;
                if (strict) {
                    if (++entries > maxEntries) throw new LocalEngineInstaller.Failure("unpack", "too many entries");
                    if (type != '0' && type != '\0' && type != '7' && type != '5') throw new LocalEngineInstaller.Failure("unpack", "link or special entry " + type + " in the engine archive");
                    String bare = type == '5' ? name.replaceAll("/+$", "") : name;
                    boolean canonical = !unsafe && !rel.isEmpty() && bare.equals(rel) && rel.split("/").length <= MAX_DEPTH && rel.indexOf('\\') < 0;
                    if (canonical) for (String seg : rel.split("/", -1)) if (seg.isEmpty() || seg.equals(".")) canonical = false;
                    if (!canonical) throw new LocalEngineInstaller.Failure("unpack", "non-canonical name in the engine archive");
                }
                File out = unsafe ? null : (rel.isEmpty() ? dest : new File(dest, rel));
                try {
                    switch (type) {
                        case '0': case '\0': case '7': {
                            if (unsafe || rel.isEmpty() || !parentSafe(out)) { skip(in, size + pad(size)); skippedUnsafe++; break; }
                            spend(size);
                            removeIfLink(out);
                            try (OutputStream o = new FileOutputStream(out)) { copy(in, o, size); }
                            skip(in, pad(size));
                            Os.chmod(out.getPath(), (mode & 0777) | 0600);
                            files++; bytes += size;
                            break;
                        }
                        case '5': {
                            skip(in, size + pad(size));
                            if (!unsafe && rel.isEmpty()) { dirs++; break; } // "./" itself
                            if (unsafe || !parentSafe(out)) { skippedUnsafe++; break; }
                            if (isLink(out)) Os.remove(out.getPath());
                            out.mkdirs();
                            safeDirs.add(out.getAbsolutePath());
                            dirModes.add(new Object[]{out.getPath(), (mode & 0777) | 0700});
                            dirs++;
                            break;
                        }
                        case '2': {
                            skip(in, size + pad(size));
                            if (unsafe || rel.isEmpty() || !parentSafe(out)) { skippedUnsafe++; break; }
                            if (exists(out)) Os.remove(out.getPath());
                            Os.symlink(link, out.getPath());
                            // a directory we vetted may just have been replaced by this link
                            safeDirs.remove(out.getAbsolutePath());
                            dropSafeUnder(out.getAbsolutePath() + "/");
                            symlinks++;
                            break;
                        }
                        case '1': {
                            skip(in, size + pad(size));
                            String lrel = clean(link);
                            if (unsafe || lrel == null || !parentSafe(out)) { skippedUnsafe++; break; }
                            File src = new File(dest, lrel);
                            if (!parentSafe(src)) { skippedUnsafe++; break; }
                            removeIfLink(out);
                            if (isLink(src)) {
                                Os.symlink(Os.readlink(src.getPath()), out.getPath());
                            } else {
                                spend(src.length());
                                try (InputStream si = new FileInputStream(src); OutputStream o = new FileOutputStream(out)) {
                                    copy(si, o, Long.MAX_VALUE);
                                }
                                Os.chmod(out.getPath(), Os.stat(src.getPath()).st_mode & 07777);
                            }
                            hardlinks++;
                            break;
                        }
                        default:
                            skip(in, size + pad(size));
                            skippedSpecial++;
                    }
                } catch (ErrnoException | java.io.FileNotFoundException e) {
                    // one entry that cannot be created; a broken archive or a full disk still aborts (IOException)
                    errors++;
                    if (errorSamples.size() < 8) errorSamples.add(type + ":" + rel + " -> " + e);
                }
            }
        }
        for (int i = dirModes.size() - 1; i >= 0; i--) {
            Object[] d = dirModes.get(i);
            // a later entry may have replaced this directory, or one above it, with a link: chmod would follow it out of the tree
            try { if (realDirChain((String) d[0])) Os.chmod((String) d[0], (Integer) d[1]); } catch (Exception ignored) {}
        }
    }

    /** Every directory between dest and f's parent exists as a real directory, or is created as one. */
    private boolean parentSafe(File f) {
        File parent = f.getAbsoluteFile().getParentFile();
        if (parent == null) return false;
        String p = parent.getPath();
        if (safeDirs.contains(p)) return true;
        if (!(p + "/").startsWith(destPath + "/")) return false;
        if (!parentSafe(parent)) return false;
        try {
            android.system.StructStat st = Os.lstat(p);
            if (!OsConstants.S_ISDIR(st.st_mode)) return false; // a link or a file in the way
        } catch (ErrnoException e) {
            if (!parent.mkdir()) return false;
        }
        safeDirs.add(p);
        return true;
    }

    /** dest and every component from dest down to path are real directories (lstat, no link anywhere on the way). */
    private boolean realDirChain(String path) {
        if (!path.startsWith(destPath + "/")) return false;
        String cur = destPath;
        try {
            if (!OsConstants.S_ISDIR(Os.lstat(cur).st_mode)) return false;
            for (String part : path.substring(destPath.length() + 1).split("/")) {
                if (part.isEmpty()) continue;
                cur = cur + "/" + part;
                if (!OsConstants.S_ISDIR(Os.lstat(cur).st_mode)) return false;
            }
            return true;
        } catch (ErrnoException e) {
            return false;
        }
    }

    private void dropSafeUnder(String prefix) {
        safeDirs.removeIf(s -> s.startsWith(prefix));
    }

    private static boolean exists(File f) {
        try { Os.lstat(f.getPath()); return true; } catch (Exception e) { return false; }
    }

    private static boolean isLink(File f) {
        try { return OsConstants.S_ISLNK(Os.lstat(f.getPath()).st_mode); } catch (Exception e) { return false; }
    }

    private static void removeIfLink(File f) {
        try { if (isLink(f)) Os.remove(f.getPath()); } catch (Exception ignored) {}
    }

    /** Normalised relative path; null if it tries to escape. */
    static String clean(String n) {
        if (n == null) return null;
        while (n.startsWith("./")) n = n.substring(2);
        while (n.startsWith("/")) n = n.substring(1);
        if (n.equals(".")) n = "";
        while (n.endsWith("/")) n = n.substring(0, n.length() - 1);
        for (String seg : n.split("/")) if (seg.equals("..")) return null;
        return n;
    }

    private static long pad(long size) { long r = size % 512; return r == 0 ? 0 : 512 - r; }

    private static boolean allZero(byte[] b) { for (byte x : b) if (x != 0) return false; return true; }

    private static boolean readFully(InputStream in, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int r = in.read(b, off, b.length - off);
            if (r < 0) { if (off == 0) return false; throw new EOFException("short header"); }
            off += r;
        }
        return true;
    }

    private static byte[] readData(InputStream in, long size) throws IOException {
        if (size < 0 || size > (16 << 20)) throw new IOException("tar metadata entry too large: " + size);
        byte[] d = new byte[(int) size];
        int off = 0;
        while (off < d.length) {
            int r = in.read(d, off, d.length - off);
            if (r < 0) throw new EOFException();
            off += r;
        }
        skip(in, pad(size));
        return d;
    }

    private static void copy(InputStream in, OutputStream o, long size) throws IOException {
        byte[] buf = new byte[1 << 16];
        long left = size;
        while (left > 0) {
            int r = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (r < 0) { if (size == Long.MAX_VALUE) return; throw new EOFException(); }
            o.write(buf, 0, r);
            left -= r;
        }
    }

    private static void skip(InputStream in, long n) throws IOException {
        while (n > 0) {
            long s = in.skip(n);
            if (s <= 0) { if (in.read() < 0) throw new EOFException(); s = 1; }
            n -= s;
        }
    }

    private static String str(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    private static String cstr(byte[] d) {
        int end = 0;
        while (end < d.length && d[end] != 0) end++;
        return new String(d, 0, end, StandardCharsets.UTF_8);
    }

    private static long parseNum(byte[] b, int off, int len) {
        if ((b[off] & 0x80) != 0) {
            long v = b[off] & 0x7f;
            for (int i = 1; i < len; i++) v = (v << 8) | (b[off + i] & 0xff);
            return v;
        }
        String s = str(b, off, len).trim();
        if (s.isEmpty()) return 0;
        return Long.parseLong(s, 8);
    }

    /** Thrown when the caller cancels mid-extract (pause / delete). */
    static final class InterruptedIOException2 extends IOException {
        InterruptedIOException2() { super("cancelled"); }
    }

    private static final class CountingInputStream extends java.io.FilterInputStream {
        private final Progress progress;
        private long count, lastReport;
        CountingInputStream(InputStream in, Progress p) { super(in); this.progress = p; }
        @Override public int read() throws IOException {
            int r = super.read();
            if (r >= 0) bump(1);
            return r;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            int r = super.read(b, off, len);
            if (r > 0) bump(r);
            return r;
        }
        @Override public long skip(long n) throws IOException {
            long r = super.skip(n);
            if (r > 0) bump(r);
            return r;
        }
        private void bump(long n) {
            count += n;
            if (progress != null && count - lastReport >= (256 << 10)) { lastReport = count; progress.onBytes(count); }
        }
    }
}
