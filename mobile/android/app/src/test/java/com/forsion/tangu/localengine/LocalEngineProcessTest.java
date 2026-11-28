package com.forsion.tangu.localengine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * The port comes only from the engine's machine-readable ready line (tangu-agent standalone/readyLine.ts), never from
 * the wording of its human-readable startup lines. The fixture line below is pinned on the engine side too
 * (readyLine.test.ts): the two parsers and the formatter cannot drift apart unnoticed.
 */
public class LocalEngineProcessTest {
    /** Same string as FIXTURE in tangu-agent/src/standalone/readyLine.test.ts. */
    static final String FIXTURE = "TANGU_READY {\"v\":1,\"host\":\"127.0.0.1\",\"port\":40123,\"version\":\"0.0.0-test\"}";

    @Test
    public void readsThePortFromTheReadyLine() {
        assertEquals(40123, LocalEngineProcess.parseReadyLine(FIXTURE));
        assertEquals(1, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":1}"));
        assertEquals(65535, LocalEngineProcess.parseReadyLine("TANGU_READY {\"v\":2,\"port\":65535,\"extra\":{\"a\":[1]}}"));
    }

    @Test
    public void humanReadableLinesNeverCarryThePort() {
        // what the engine prints for people, in any wording: not a source of the port
        assertEquals(0, LocalEngineProcess.parseReadyLine("[tangu] standalone 已启动 http://127.0.0.1:40123"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("[tangu] standalone started http://127.0.0.1:40123"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("[tangu] cloud=https://example.invalid 存储=sqlite"));
        assertEquals(0, LocalEngineProcess.parseReadyLine(""));
        assertEquals(0, LocalEngineProcess.parseReadyLine(null));
    }

    @Test
    public void malformedReadyLinesAreIgnored() {
        assertEquals(0, LocalEngineProcess.parseReadyLine(" " + FIXTURE)); // the prefix starts the line
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY{\"port\":40123}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY "));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":40123"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY not json"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":0}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":-1}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":65536}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":4294967297}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":401.5}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":\"40123\"}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY [40123]"));
        // exactly one object and nothing around it (Android's JSONObject(String) alone would take these)
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":40123} extra"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":40123}{\"port\":1}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY  {\"port\":40123}"));
        assertEquals(0, LocalEngineProcess.parseReadyLine("TANGU_READY {\"port\":40123} "));
    }

    @Test
    public void statusNeverFollowsRedirects() throws Exception {
        try (ServerSocket ss = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            Thread t = serveOnce(ss, "HTTP/1.1 302 Found\r\nLocation: /health\r\nContent-Length: 0\r\n\r\n", 0);
            assertEquals(302, LocalEngineProcess.status(ss.getLocalPort(), "/agent/sessions?limit=1", "tok", 3000));
            t.join(3000);
        }
    }

    @Test
    public void statusSendsTheTokenAndReadsTheCode() throws Exception {
        try (ServerSocket ss = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            final String[] req = new String[1];
            Thread t = new Thread(() -> {
                try (Socket s = ss.accept()) {
                    byte[] b = new byte[2048];
                    int n = s.getInputStream().read(b);
                    req[0] = new String(b, 0, Math.max(0, n), StandardCharsets.US_ASCII);
                    s.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".getBytes(StandardCharsets.US_ASCII));
                } catch (Exception ignored) {}
            });
            t.start();
            assertEquals(200, LocalEngineProcess.status(ss.getLocalPort(), "/agent/sessions?limit=1", "tok-123", 3000));
            t.join(3000);
            assertTrue(req[0], req[0].startsWith("GET /agent/sessions?limit=1 HTTP/1.0\r\n"));
            assertTrue(req[0], req[0].contains("\r\nAuthorization: Bearer tok-123\r\n"));
        }
    }

    /** A status line dripped a byte at a time cannot hold the probe past its budget. */
    @Test
    public void statusIsBoundedOverall() throws Exception {
        try (ServerSocket ss = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            Thread t = serveOnce(ss, "HTTP/1.1 200 OK\r\n\r\n", 400);
            long t0 = System.nanoTime();
            int st = LocalEngineProcess.status(ss.getLocalPort(), "/health", null, 1500);
            long ms = (System.nanoTime() - t0) / 1_000_000L;
            assertEquals(-1, st);
            assertTrue("took " + ms + " ms", ms < 2500);
            t.interrupt();
        }
        assertEquals(-1, LocalEngineProcess.status(0, "/health", null, 100));
    }

    @Test
    public void longLinesAreCutAndTheReadyLineStillCounts() throws Exception {
        String token = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
        StringBuilder in = new StringBuilder();
        for (int i = 0; i < 20_000; i++) in.append('a');                         // never a newline for 20 KB
        in.append('\n');
        for (int i = 0; i < LocalEngineProcess.MAX_LINE_BYTES - 2; i++) in.append('b');
        in.append(token).append('\n');                                           // the token straddles the cut
        in.append("log ").append(token).append(" end\r\n");
        in.append(FIXTURE).append('\n');
        in.append("no newline at the end");
        final List<String> lines = new ArrayList<>();
        final List<Boolean> cuts = new ArrayList<>();
        LocalEngineProcess.readLines(new ByteArrayInputStream(in.toString().getBytes(StandardCharsets.UTF_8)), token, (l, cut) -> { lines.add(l); cuts.add(cut); });
        assertEquals(5, lines.size());
        assertTrue(cuts.get(0));
        assertTrue(lines.get(0).length() <= LocalEngineProcess.MAX_LINE_BYTES + 2);
        assertTrue(cuts.get(1));
        assertFalse("no piece of the token survives a cut", lines.get(1).contains("f0"));
        assertEquals("log *** end", lines.get(2));
        assertFalse(cuts.get(3));
        assertEquals(40123, LocalEngineProcess.parseReadyLine(lines.get(3)));
        assertEquals("no newline at the end", lines.get(4));
    }

    /** Accepts one connection and answers with body, one byte every dripMs (0 = at once). */
    private static Thread serveOnce(ServerSocket ss, String body, int dripMs) {
        Thread t = new Thread(() -> {
            try (Socket s = ss.accept()) {
                s.getInputStream().read(new byte[2048]);
                OutputStream o = s.getOutputStream();
                for (byte b : body.getBytes(StandardCharsets.US_ASCII)) {
                    o.write(b);
                    o.flush();
                    if (dripMs > 0) Thread.sleep(dripMs);
                }
            } catch (Exception ignored) {}
        });
        t.setDaemon(true);
        t.start();
        return t;
    }

    /** The engine reads the same env switch and prints the same prefix (gradle runs unit tests from the app module). */
    @Test
    public void matchesTheEngineSide() throws Exception {
        File ts = new File("../../../tangu-agent/src/standalone/readyLine.ts");
        assertTrue("engine side not found at " + ts.getCanonicalPath(), ts.isFile());
        String src = new String(Files.readAllBytes(ts.toPath()), StandardCharsets.UTF_8);
        assertTrue("prefix", src.contains("export const READY_LINE_PREFIX = '" + LocalEngineProcess.READY_PREFIX + "';"));
        assertTrue("env switch", src.contains("env." + LocalEngineProcess.READY_ENV + " === '1'"));
    }
}
