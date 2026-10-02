package com.forsion.tangu

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL

/**
 * Streams one HTTP(S) response into a file with a hard byte cap. Pure JVM (no Android classes) so the whole
 * policy is unit-tested against an in-process server (CappedDownloadTest).
 *
 * Why it exists: the market installer used Capacitor's `Filesystem.downloadFile`, which writes the complete
 * response to the cache directory before anyone looks at its size, so an unbounded response fills the
 * device's storage. Here the transfer itself is bounded:
 *  - a `Content-Length` over the cap is refused before the body is read;
 *  - the body is counted while streaming and the transfer is aborted the moment it passes the cap
 *    (`Accept-Encoding: identity`, so the count is the bytes on the wire and on disk);
 *  - whatever was written is deleted on every failure path.
 * The download host is a third party (GitHub / a mirror / object storage), so the request carries nothing of
 * ours: only `https:` URLs, redirects followed by hand and only to `https:`, no app headers, and no cookies
 * (Capacitor installs the WebView cookie jar as the process-wide CookieHandler; see NoCookieJar).
 */
internal object CappedDownload {
    /** [reason] is the language-neutral text the JS side lists per host: `too large`, `HTTP 404`, `timeout`, … */
    class Failure(val code: String, val reason: String) : IOException(reason)

    data class Policy(
        /** Debug builds only: also allow cleartext `http:` to the loopback hosts the emulator harness uses. */
        val allowLoopbackHttp: Boolean = false,
        val connectTimeoutMs: Int = 15_000,
        /** Max silence between two reads once the response started. */
        val stallTimeoutMs: Int = 20_000,
        val maxRedirects: Int = 5,
    )

    fun interface Progress {
        /** [total] is the declared Content-Length, or -1 when the server did not send one. */
        fun onProgress(received: Long, total: Long)
    }

    private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")
    private val REDIRECTS = setOf(301, 302, 303, 307, 308)

    /** `https:` only (plus loopback `http:` when the policy allows it); no credentials in the URL. */
    fun checkUrl(raw: String?, policy: Policy): URL {
        val uri = try { URI(raw ?: "") } catch (_: Exception) { throw Failure("bad_url", "insecure url") }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()
        val allowed = !host.isNullOrEmpty() && uri.rawUserInfo == null && (
            scheme == "https" || (scheme == "http" && policy.allowLoopbackHttp && host in LOOPBACK_HOSTS)
        )
        if (!allowed) throw Failure("bad_url", "insecure url")
        return try { uri.toURL() } catch (_: Exception) { throw Failure("bad_url", "insecure url") }
    }

    /**
     * Downloads [url] into [dest] (created / overwritten) and returns the byte count. Throws [Failure];
     * [dest] does not exist afterwards unless the call returned normally. Blocking: call off the main thread.
     */
    fun download(url: String?, dest: File, maxBytes: Long, policy: Policy = Policy(), progress: Progress = Progress { _, _ -> }): Long {
        val prevNoCookies = NoCookieJar.enter()
        try {
            return follow(checkUrl(url, policy), dest, maxBytes, policy, progress)
        } catch (e: Failure) {
            dest.delete()
            throw e
        } catch (e: Exception) {
            dest.delete()
            throw Failure("io", "io: ${e.javaClass.simpleName}")
        } finally {
            NoCookieJar.exit(prevNoCookies)
        }
    }

    private fun follow(first: URL, dest: File, maxBytes: Long, policy: Policy, progress: Progress): Long {
        var current = first
        for (hop in 0..policy.maxRedirects) {
            val c = current.openConnection() as HttpURLConnection
            try {
                c.connectTimeout = policy.connectTimeoutMs
                c.readTimeout = policy.stallTimeoutMs
                c.instanceFollowRedirects = false // followed by hand: every hop goes through checkUrl again
                c.useCaches = false
                c.requestMethod = "GET"
                c.setRequestProperty("Accept", "*/*")
                c.setRequestProperty("Accept-Encoding", "identity")
                val status = try { c.responseCode } catch (_: SocketTimeoutException) { throw Failure("timeout", "timeout") }
                if (status in REDIRECTS) {
                    val location = c.getHeaderField("Location") ?: throw Failure("http", "HTTP $status")
                    val next = try { current.toURI().resolve(location).toString() } catch (_: Exception) { throw Failure("bad_url", "insecure redirect") }
                    current = try { checkUrl(next, policy) } catch (_: Failure) { throw Failure("bad_url", "insecure redirect") }
                    continue
                }
                if (status !in 200..299) throw Failure("http", "HTTP $status")
                val total = c.getHeaderField("Content-Length")?.trim()?.toLongOrNull() ?: -1L
                if (total > maxBytes) throw Failure("too_large", "too large")
                return copyCapped(c, dest, maxBytes, total, progress)
            } finally {
                c.disconnect()
            }
        }
        throw Failure("redirects", "too many redirects")
    }

    private fun copyCapped(c: HttpURLConnection, dest: File, maxBytes: Long, total: Long, progress: Progress): Long {
        var received = 0L
        try {
            c.inputStream.use { input ->
                FileOutputStream(dest).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        received += n
                        if (received > maxBytes) throw Failure("too_large", "too large") // before the write: disk never holds more than the cap
                        out.write(buf, 0, n)
                        progress.onProgress(received, total)
                    }
                }
            }
        } catch (_: SocketTimeoutException) {
            throw Failure("stalled", "stalled")
        }
        // A body shorter than its Content-Length is a dropped connection, not a finished download.
        if (total >= 0 && received != total) throw Failure("io", "truncated")
        return received
    }
}
