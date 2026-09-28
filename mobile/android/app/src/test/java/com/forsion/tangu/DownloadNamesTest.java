package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** P1-DL「存到下载」的显示名 / MIME 规整(DownloadNames)。MimeTypeMap 在 android.jar 里是桩,这里注入一张小表。 */
public class DownloadNamesTest {
    private static final Map<String, String> EXT2MIME = new HashMap<>();
    private static final Map<String, String> MIME2EXT = new HashMap<>();

    static {
        String[][] rows = {
                {"txt", "text/plain"}, {"csv", "text/comma-separated-values"}, {"pdf", "application/pdf"},
                {"png", "image/png"}, {"zip", "application/zip"}, {"json", "application/json"},
        };
        for (String[] r : rows) {
            EXT2MIME.put(r[0], r[1]);
            MIME2EXT.put(r[1], r[0]);
        }
    }

    private static final DownloadNames.MimeLookup LOOKUP = new DownloadNames.MimeLookup() {
        @Override
        public String mimeFromExtension(String extLower) {
            return EXT2MIME.get(extLower);
        }

        @Override
        public String extensionFromMime(String mime) {
            return MIME2EXT.get(mime);
        }
    };

    private static String s(String raw) {
        return DownloadNames.sanitize(raw);
    }

    @Test
    public void plainNamesPassThrough() {
        assertEquals("report.txt", s("report.txt"));
        assertEquals("季度 报告.pdf", s("季度 报告.pdf"));
        assertEquals("a (1).tar.gz", s("a (1).tar.gz"));
    }

    @Test
    public void keepsOnlyTheLastPathSegment() {
        assertEquals("b.txt", s("/workspace/a/b.txt"));
        assertEquals("b.txt", s("..\\..\\b.txt"));
        assertEquals("passwd", s("../../etc/passwd"));
        assertEquals("dir", s("a/dir/"));
        assertEquals("x.txt", s("C:\\Users\\me\\x.txt"));
    }

    @Test
    public void emptyAndDotNamesFallBack() {
        assertEquals(DownloadNames.FALLBACK, s(null));
        assertEquals(DownloadNames.FALLBACK, s(""));
        assertEquals(DownloadNames.FALLBACK, s("   "));
        assertEquals(DownloadNames.FALLBACK, s("."));
        assertEquals(DownloadNames.FALLBACK, s(".."));
        assertEquals(DownloadNames.FALLBACK, s("/"));
        assertEquals(DownloadNames.FALLBACK, s("\u0000\u0007\n"));
    }

    @Test
    public void dropsControlAndFormatCharacters() {
        assertEquals("ab.txt", s("a\u0000b.txt"));
        assertEquals("ab.txt", s("a\r\nb.txt"));
        assertEquals("ab.txt", s("a\u007fb.txt"));
        assertEquals("ab.txt", s("a\u0085b.txt")); // C1
        // RTLO:`report\u202Etxt.exe` 在屏幕上看起来像 report exe.txt
        assertEquals("reporttxt.exe", s("report\u202Etxt.exe"));
        assertEquals("ab.txt", s("a\u200Bb\uFEFF.txt"));
        assertEquals("ab.txt", s("a\u2028b\u2029.txt"));
        assertEquals("ab.txt", s("a\uD800b.txt")); // 孤立代理项
    }

    @Test
    public void replacesCharactersFatRejects() {
        assertEquals("a_b_c_d_e_f_g.txt", s("a\"b*c:d<e>f?g.txt"));
        assertEquals("x_y.txt", s("x|y.txt"));
    }

    @Test
    public void trimsLeadingDotsAndTrailingDotsAndSpaces() {
        assertEquals("env", s(".env"));
        assertEquals("hidden.txt", s("...hidden.txt"));
        assertEquals("name", s("name. . "));
        assertEquals("name.txt", s("  name.txt  "));
        assertEquals("a b.txt", s("a\u00A0b.txt")); // NBSP 折成普通空格
        assertEquals("a b.txt", s("a\u3000b.txt")); // 全角空格
    }

    @Test
    public void boundsLengthInUtf8BytesAndKeepsTheExtension() {
        StringBuilder longAscii = new StringBuilder();
        for (int i = 0; i < 400; i++) longAscii.append('a');
        String out = s(longAscii + ".pdf");
        assertTrue(out.endsWith(".pdf"));
        assertEquals(DownloadNames.MAX_BYTES, out.getBytes(StandardCharsets.UTF_8).length);

        StringBuilder longCjk = new StringBuilder();
        for (int i = 0; i < 200; i++) longCjk.append('报'); // 3 字节
        String cjk = s(longCjk + ".docx");
        assertTrue(cjk.endsWith(".docx"));
        assertTrue(cjk.getBytes(StandardCharsets.UTF_8).length <= DownloadNames.MAX_BYTES);
        assertEquals(cjk, new String(cjk.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8));

        StringBuilder emoji = new StringBuilder();
        for (int i = 0; i < 100; i++) emoji.append("\uD83D\uDE00"); // 4 字节,代理对
        String e = s(emoji + ".png");
        assertTrue(e.endsWith(".png"));
        assertTrue(e.getBytes(StandardCharsets.UTF_8).length <= DownloadNames.MAX_BYTES);
        String body = e.substring(0, e.length() - 4);
        assertEquals(0, body.length() % 2); // 没劈开代理对
        assertFalse(Character.isHighSurrogate(body.charAt(body.length() - 1)));

        // 点后面太长就不算扩展名,整体截
        StringBuilder longExt = new StringBuilder("a.");
        for (int i = 0; i < 300; i++) longExt.append('x');
        assertEquals(DownloadNames.MAX_BYTES, s(longExt.toString()).getBytes(StandardCharsets.UTF_8).length);
    }

    @Test
    public void extensionOf() {
        assertEquals("txt", DownloadNames.extensionOf("a.txt"));
        assertEquals("gz", DownloadNames.extensionOf("a.tar.gz"));
        assertEquals("PDF", DownloadNames.extensionOf("A.PDF"));
        assertNull(DownloadNames.extensionOf("Makefile"));
        assertNull(DownloadNames.extensionOf("a."));
        assertNull(DownloadNames.extensionOf("a.has space"));
        assertNull(DownloadNames.extensionOf("a.abcdefghijklmnopq")); // 17 > MAX_EXT_CHARS
    }

    @Test
    public void mimeFollowsTheExtensionSoMediaStoreNeverRenames() {
        // 扩展名认识:永远用扩展名的 MIME,哪怕服务端说的是别的(否则 data.csv + text/plain → data.csv.txt)
        assertEquals("text/comma-separated-values", DownloadNames.chooseMime("data.csv", "text/plain", LOOKUP));
        assertEquals("application/pdf", DownloadNames.chooseMime("A.PDF", "application/octet-stream", LOOKUP));
        assertEquals("text/plain", DownloadNames.chooseMime("r.txt", "text/plain; charset=utf-8", LOOKUP));
    }

    @Test
    public void unknownExtensionUsesProvidedMimeOnlyIfItWouldNotAppendAnExtension() {
        // text/markdown 在查表里没有扩展名 → 用它,名字不变
        assertEquals("text/markdown", DownloadNames.chooseMime("notes.md", "text/markdown; charset=UTF-8", LOOKUP));
        // text/plain 会引出 .txt → notes.md.txt;宁可 octet-stream 保住原名
        assertEquals(DownloadNames.OCTET, DownloadNames.chooseMime("notes.md", "text/plain", LOOKUP));
        assertEquals(DownloadNames.OCTET, DownloadNames.chooseMime("Makefile", "text/plain", LOOKUP));
        assertEquals("application/x-thing", DownloadNames.chooseMime("Makefile", "application/x-thing", LOOKUP));
    }

    @Test
    public void malformedOrMissingMimeFallsBackToOctetStream() {
        assertEquals(DownloadNames.OCTET, DownloadNames.chooseMime("x.unknownext", null, LOOKUP));
        assertEquals(DownloadNames.OCTET, DownloadNames.chooseMime("x.unknownext", "", LOOKUP));
        assertEquals(DownloadNames.OCTET, DownloadNames.chooseMime("x.unknownext", "not a mime", LOOKUP));
        assertEquals(DownloadNames.OCTET, DownloadNames.chooseMime("x.unknownext", "text/plain\r\nX: y", LOOKUP));
        assertEquals(DownloadNames.OCTET, DownloadNames.chooseMime("x", "../../etc", LOOKUP));
    }

    @Test
    public void normalizeMime() {
        assertEquals("text/html", DownloadNames.normalizeMime(" Text/HTML ; charset=utf-8"));
        assertEquals("application/vnd.ms-excel", DownloadNames.normalizeMime("application/vnd.ms-excel"));
        assertNull(DownloadNames.normalizeMime("text"));
        assertNull(DownloadNames.normalizeMime("text/"));
        assertNull(DownloadNames.normalizeMime("a/b/c"));
    }
}
