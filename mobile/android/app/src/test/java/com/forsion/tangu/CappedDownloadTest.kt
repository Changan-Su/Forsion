package com.forsion.tangu

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.CookieHandler
import java.net.URI
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * The market package downloader against an in-process HTTP server (MiniHttp speaks plain http on 127.0.0.1,
 * so these tests run with the debug-only loopback allowance; the production policy is asserted in
 * [urlPolicy] and [refusesCleartextWithoutTheDebugAllowance]).
 */
class CappedDownloadTest {
    private val dir: File = Files.createTempDirectory("capped-dl").toFile()
    private val dest = File(dir, "pkg.zip")
    private val loopback = CappedDownload.Policy(allowLoopbackHttp = true, connectTimeoutMs = 2_000, stallTimeoutMs = 400)
    private var server: MiniHttp? = null

    @After fun tearDown() {
        server?.close()
        dir.deleteRecursively()
    }

    private fun serve(h: MiniHttp.Handler): String {
        val s = MiniHttp(h)
        server = s
        return "http://127.0.0.1:${s.port()}"
    }

    private fun failure(block: () -> Unit): CappedDownload.Failure = assertThrows(CappedDownload.Failure::class.java) { block() }

    @Test fun urlPolicy() {
        val strict = CappedDownload.Policy()
        assertEquals("https://example.com/a.zip", CappedDownload.checkUrl("https://example.com/a.zip", strict).toString())
        for (bad in listOf(
            "http://example.com/a.zip", "http://localhost:5317/a.zip", "http://127.0.0.1/a.zip",
            "file:///data/data/com.forsion.tangu/files/x", "content://media/external/file/1", "ftp://example.com/a.zip",
            "javascript:alert(1)", "//example.com/a.zip", "/a.zip", "https://user:pw@example.com/a.zip", "https:///a.zip", "", null,
        )) {
            assertEquals(bad, "insecure url", failure { CappedDownload.checkUrl(bad, strict) }.reason)
        }
        // Debug builds: cleartext only to the loopback hosts, nothing else.
        val debug = CappedDownload.Policy(allowLoopbackHttp = true)
        for (ok in listOf("http://localhost:5317/a.zip", "http://127.0.0.1:1/a.zip", "http://10.0.2.2/a.zip", "https://example.com/a.zip")) {
            CappedDownload.checkUrl(ok, debug)
        }
        for (bad in listOf("http://example.com/a.zip", "http://192.168.1.2/a.zip", "http://localhost.evil.test/a.zip", "file:///x")) {
            assertEquals(bad, "insecure url", failure { CappedDownload.checkUrl(bad, debug) }.reason)
        }
    }

    @Test fun downloadsWithProgressAndSendsNothingOfOurs() {
        val body = ByteArray(200_000) { (it % 251).toByte() }
        val seen = CopyOnWriteArrayList<MiniHttp.Req>()
        val base = serve { req, res -> seen.add(req); res.start(200, mapOf("Set-Cookie" to "sid=from-download-host"), body.size.toLong()).write(body) }
        // A process-wide cookie jar with a session cookie for this host (what CapacitorCookies installs on a device).
        val jar = RecordingJar(mapOf("Cookie" to listOf("forsion_unit_session=secret")))
        val before = CookieHandler.getDefault()
        CookieHandler.setDefault(jar)
        try {
            val ticks = ArrayList<Pair<Long, Long>>()
            val n = CappedDownload.download("$base/p.zip", dest, 1_000_000, loopback) { received, total -> ticks.add(received to total) }
            assertEquals(body.size.toLong(), n)
            assertArrayEquals(body, dest.readBytes())
            assertEquals(body.size.toLong() to body.size.toLong(), ticks.last())
            val req = seen.single()
            assertEquals("GET", req.method)
            assertNull("no cookie may reach the download host", req.headers["cookie"])
            assertNull(req.headers["authorization"])
            assertEquals("identity", req.headers["accept-encoding"])
            assertEquals("the host's Set-Cookie must not be stored", 0, jar.puts.get())
        } finally {
            CookieHandler.setDefault(before)
        }
    }

    @Test fun refusesADeclaredLengthOverTheCapBeforeReadingTheBody() {
        val bodyStarted = AtomicInteger()
        val base = serve { _, res ->
            val out = res.start(200, emptyMap(), 5_000_000)
            bodyStarted.incrementAndGet()
            try { out.write(ByteArray(5_000_000)) } catch (_: Exception) { }
        }
        assertEquals("too large", failure { CappedDownload.download("$base/big.zip", dest, 1_000_000, loopback) }.reason)
        assertFalse(dest.exists())
    }

    @Test fun abortsAnUnboundedBodyAtTheCapAndDeletesThePartialFile() {
        val written = AtomicInteger()
        val base = serve { _, res ->
            val out = res.start(200, emptyMap(), -1) // no Content-Length: the stream just keeps coming
            val chunk = ByteArray(64 * 1024)
            try { repeat(100_000) { out.write(chunk); out.flush(); written.addAndGet(chunk.size) } } catch (_: Exception) { }
        }
        val maxOnDisk = longArrayOf(0)
        val f = failure {
            CappedDownload.download("$base/endless.zip", dest, 300_000, loopback) { _, _ -> maxOnDisk[0] = maxOf(maxOnDisk[0], dest.length()) }
        }
        assertEquals("too_large", f.code)
        assertFalse("partial file must be deleted", dest.exists())
        assertTrue("never more than the cap on disk (saw ${maxOnDisk[0]})", maxOnDisk[0] <= 300_000)
        // The server would happily send 6.5 GB; it only got as far as the socket buffers before the client hung up.
        assertTrue("transfer stopped early (server wrote ${written.get()} bytes)", written.get() < 32 * 1024 * 1024)
    }

    @Test fun reportsHttpErrorsStallsAndTruncation() {
        val base = serve { req, res ->
            when (req.target) {
                "/404" -> res.start(404, emptyMap(), 2).write("no".toByteArray())
                "/stall" -> { val out = res.start(200, emptyMap(), -1); out.write(ByteArray(10)); out.flush(); Thread.sleep(1_500) }
                "/short" -> { val out = res.start(200, emptyMap(), 1_000); out.write(ByteArray(10)); out.flush() }
                else -> res.start(500, emptyMap(), 0)
            }
        }
        assertEquals("HTTP 404", failure { CappedDownload.download("$base/404", dest, 1_000, loopback) }.reason)
        assertEquals("stalled", failure { CappedDownload.download("$base/stall", dest, 1_000, loopback) }.reason)
        assertFalse(dest.exists())
        assertEquals("io", failure { CappedDownload.download("$base/short", dest, 10_000, loopback) }.code)
        assertFalse(dest.exists())
    }

    @Test fun followsRedirectsByHandAndOnlyToAllowedUrls() {
        val body = "PK-ok".toByteArray()
        val hits = CopyOnWriteArrayList<String>()
        val base = serve { req, res ->
            hits.add(req.target)
            when (req.target) {
                "/a" -> res.start(302, mapOf("Location" to "/b"), 0)
                "/b" -> res.start(307, mapOf("Location" to "http://127.0.0.1:${server!!.port()}/final"), 0)
                "/final" -> res.start(200, emptyMap(), body.size.toLong()).write(body)
                "/to-file" -> res.start(302, mapOf("Location" to "file:///etc/hosts"), 0)
                "/to-lan" -> res.start(302, mapOf("Location" to "http://192.168.1.2/x.zip"), 0)
                "/loop" -> res.start(302, mapOf("Location" to "/loop"), 0)
                else -> res.start(404, emptyMap(), 0)
            }
        }
        assertEquals(body.size.toLong(), CappedDownload.download("$base/a", dest, 1_000, loopback))
        assertArrayEquals(body, dest.readBytes())
        assertEquals(listOf("/a", "/b", "/final"), hits.toList())
        assertEquals("insecure redirect", failure { CappedDownload.download("$base/to-file", dest, 1_000, loopback) }.reason)
        assertEquals("insecure redirect", failure { CappedDownload.download("$base/to-lan", dest, 1_000, loopback) }.reason)
        assertEquals("too many redirects", failure { CappedDownload.download("$base/loop", dest, 1_000, loopback.copy(maxRedirects = 3)) }.reason)
        assertFalse(dest.exists())
    }

    @Test fun refusesCleartextWithoutTheDebugAllowance() {
        val hits = AtomicInteger()
        val base = serve { _, res -> hits.incrementAndGet(); res.start(200, emptyMap(), 2).write("PK".toByteArray()) }
        assertEquals("insecure url", failure { CappedDownload.download("$base/p.zip", dest, 1_000) }.reason)
        assertEquals("no request may leave for a refused URL", 0, hits.get())
        assertFalse(dest.exists())
    }

    /** Stand-in for the WebView-backed global cookie jar. */
    private class RecordingJar(private val cookies: Map<String, List<String>>) : CookieHandler() {
        val puts = AtomicInteger()
        override fun get(uri: URI, requestHeaders: Map<String, List<String>>): Map<String, List<String>> = cookies
        override fun put(uri: URI, responseHeaders: Map<String, List<String>>) { puts.incrementAndGet() }
    }
}
