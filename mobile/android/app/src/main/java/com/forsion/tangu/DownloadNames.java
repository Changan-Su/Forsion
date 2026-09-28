package com.forsion.tangu;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * P1-DL「存到下载」的文件名与 MIME 规整 —— 纯逻辑,不碰 android.*(JVM 单测 DownloadNamesTest)。
 * 调用方:DownloadsPlugin(MediaStore.Downloads 落盘)。
 *
 * 名字是**权威**:MIME 绝不能让 MediaProvider 改名。MediaProvider 在显示名扩展名与 MIME 对不上时会把 MIME 的扩展名
 * 追加上去(`data.csv` + text/plain → `data.csv.txt`),所以 MIME 按扩展名反推;扩展名不认识 / 没有扩展名时,只在
 * 「这个 MIME 不会引出任何扩展名」时才用调用方给的 MIME,否则 application/octet-stream(MediaProvider 对它原名照收)。
 */
final class DownloadNames {
    private DownloadNames() {
    }

    static final String FALLBACK = "download";
    static final String OCTET = "application/octet-stream";
    /** 单个文件名 255 字节是文件系统上限;给 MediaStore 去重追加的 " (12)" 留足余量。 */
    static final int MAX_BYTES = 200;
    /** 点后面超过这个长度(或含空白)就不当扩展名,整体当正文截。 */
    static final int MAX_EXT_CHARS = 16;

    private static final Pattern MIME = Pattern.compile("^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$");
    private static final String ILLEGAL = "\"*:<>?|/\\";

    /** 扩展名 ↔ MIME 的查表(生产 = android.webkit.MimeTypeMap;它在 android.jar 里是桩,单测注入假的)。 */
    interface MimeLookup {
        /** 小写扩展名(不带点)→ MIME;不认识回 null。 */
        String mimeFromExtension(String extLower);

        /** MIME → 扩展名(不带点);不认识回 null。 */
        String extensionFromMime(String mime);
    }

    /**
     * 规整成可以直接给 MediaStore 的显示名:只取最后一段路径(`/` 与 `\` 都算);丢掉 C0 / DEL / C1 控制符、Unicode 格式符
     * (U+202E 之类的方向覆盖,能把 `exe.txt` 伪装成别的扩展名)、行 / 段分隔符与孤立代理项;FAT 不收的 `"*:<>?|` 换成 `_`;
     * 去掉开头的点(隐藏文件)与结尾的点和空白;按 UTF-8 字节截到 {@link #MAX_BYTES},截在码点边界上并保住扩展名;
     * 空 / `.` / `..` → {@link #FALLBACK}。
     */
    static String sanitize(String raw) {
        if (raw == null) return FALLBACK;
        String seg = lastSegment(raw);
        StringBuilder sb = new StringBuilder(seg.length());
        for (int i = 0; i < seg.length(); ) {
            int cp = seg.codePointAt(i);
            i += Character.charCount(cp);
            if (dropped(cp)) continue;
            if (cp < 0x80 && ILLEGAL.indexOf(cp) >= 0) {
                sb.append('_');
                continue;
            }
            // 各种 Unicode 空白(NBSP、全角空格…)一律折成普通空格,免得「看着一样的名字」其实不同
            sb.appendCodePoint(Character.isWhitespace(cp) || Character.isSpaceChar(cp) ? ' ' : cp);
        }
        String s = trimEnds(sb.toString());
        if (s.isEmpty()) return FALLBACK;
        return bound(s);
    }

    /** 名字的扩展名(不带点、原样大小写);没有 / 不像扩展名 → null。 */
    static String extensionOf(String name) {
        if (name == null) return null;
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return null;
        String ext = name.substring(dot + 1);
        if (ext.length() > MAX_EXT_CHARS) return null;
        for (int i = 0; i < ext.length(); i++) {
            if (Character.isWhitespace(ext.charAt(i))) return null;
        }
        return ext;
    }

    /** 调用方给的 MIME 规整:去参数(`; charset=…`)、小写、格式不对 → null。 */
    static String normalizeMime(String provided) {
        if (provided == null) return null;
        String m = provided;
        int semi = m.indexOf(';');
        if (semi >= 0) m = m.substring(0, semi);
        m = m.trim().toLowerCase(Locale.ROOT);
        return MIME.matcher(m).matches() ? m : null;
    }

    /** 见类注释:扩展名认识 → 扩展名的 MIME;否则调用方的 MIME 不会引出扩展名才用;再否则 octet-stream。 */
    static String chooseMime(String name, String provided, MimeLookup lookup) {
        String ext = extensionOf(name);
        if (ext != null) {
            String byExt = lookup.mimeFromExtension(ext.toLowerCase(Locale.ROOT));
            if (byExt != null && !byExt.isEmpty()) return byExt;
        }
        String p = normalizeMime(provided);
        if (p == null || OCTET.equals(p)) return OCTET;
        String appended = lookup.extensionFromMime(p);
        if (appended == null || appended.isEmpty()) return p;
        if (ext != null && appended.equalsIgnoreCase(ext)) return p;
        return OCTET;
    }

    private static String lastSegment(String raw) {
        int end = raw.length();
        while (end > 0 && (raw.charAt(end - 1) == '/' || raw.charAt(end - 1) == '\\')) end--;
        String s = raw.substring(0, end);
        int cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return s.substring(cut + 1);
    }

    private static boolean dropped(int cp) {
        if (Character.isISOControl(cp)) return true; // C0、DEL、C1
        int type = Character.getType(cp);
        return type == Character.FORMAT // 含 U+200B/U+202A–202E/U+2066–2069/U+FEFF 与标签字符
                || type == Character.SURROGATE // 孤立代理项:编不成合法 UTF-8
                || type == Character.LINE_SEPARATOR
                || type == Character.PARAGRAPH_SEPARATOR;
    }

    /** 去头部空白与点、尾部空白与点(反复,直到稳定)。 */
    private static String trimEnds(String s) {
        int a = 0;
        int b = s.length();
        while (a < b && (s.charAt(a) == ' ' || s.charAt(a) == '.')) a++;
        while (b > a && (s.charAt(b - 1) == ' ' || s.charAt(b - 1) == '.')) b--;
        return s.substring(a, b);
    }

    private static int utf8Len(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    private static String bound(String s) {
        if (utf8Len(s) <= MAX_BYTES) return s;
        String ext = extensionOf(s);
        String tail = ext == null ? "" : "." + ext;
        String base = ext == null ? s : s.substring(0, s.length() - tail.length());
        String cut = trimEnds(truncateUtf8(base, MAX_BYTES - utf8Len(tail)));
        if (cut.isEmpty()) cut = FALLBACK;
        return cut + tail;
    }

    /** 按 UTF-8 字节数截,只截在码点边界上(不劈开代理对)。 */
    private static String truncateUtf8(String s, int maxBytes) {
        int bytes = 0;
        int i = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i);
            int n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
            if (bytes + n > maxBytes) break;
            bytes += n;
            i += Character.charCount(cp);
        }
        return s.substring(0, i);
    }
}
