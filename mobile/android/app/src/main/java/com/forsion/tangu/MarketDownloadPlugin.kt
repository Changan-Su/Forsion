package com.forsion.tangu

import android.content.pm.ApplicationInfo
import android.os.SystemClock
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Market package download with an enforced transfer cap (JS: mobile/src/plugins/capacitorPluginFs.ts).
 * All policy lives in [CappedDownload]; this class only binds it to the app cache directory and the bridge.
 *
 * | method                         | result / reject                                                          |
 * |--------------------------------|--------------------------------------------------------------------------|
 * | download({id, url, maxBytes})  | {name, size}: file `name` in the app cache dir. Rejects with the reason  |
 * |                                | as message (`too large`, `HTTP 404`, `timeout`, `stalled`, `insecure url`…) |
 * | discard({name})                | {} : deletes that cache file (JS calls it once the bytes are read)       |
 * event `progress` {id, received, total}: total = -1 when the server sent no Content-Length.
 *
 * Cleartext `http:` is accepted only for loopback hosts and only in debuggable builds (the emulator harness
 * serves the package from the host through `adb reverse`); JS cannot switch that on.
 */
@CapacitorPlugin(name = "ForsionMarketDownload")
class MarketDownloadPlugin : Plugin() {
    companion object {
        private const val PREFIX = "forsion-market-"
        private const val SUFFIX = ".zip"
        /** Upper bound for the cap JS may ask for (the installer asks for 25 MB). */
        private const val MAX_CAP = 64L * 1024 * 1024
        private const val PROGRESS_INTERVAL_MS = 120L
        private val NAME = Regex("^forsion-market-[0-9a-f-]{36}\\.zip$")
    }

    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "forsion-market-download").apply { isDaemon = true } }

    override fun load() {
        // A download interrupted by process death leaves its file behind: nothing else ever reads these names.
        io.execute {
            try { context.cacheDir.listFiles { f -> f.name.startsWith(PREFIX) && f.name.endsWith(SUFFIX) }?.forEach { it.delete() } } catch (_: Exception) { }
        }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val id = call.getString("id") ?: ""
        val url = call.getString("url")
        val maxBytes = call.data.optLong("maxBytes", -1L)
        if (maxBytes <= 0 || maxBytes > MAX_CAP) { call.reject("invalid maxBytes", "bad_request"); return }
        val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        io.execute {
            val name = PREFIX + UUID.randomUUID() + SUFFIX
            var lastSent = 0L
            try {
                val size = CappedDownload.download(url, File(context.cacheDir, name), maxBytes, CappedDownload.Policy(allowLoopbackHttp = debuggable)) { received, total ->
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastSent >= PROGRESS_INTERVAL_MS) {
                        lastSent = now
                        notifyListeners("progress", JSObject().put("id", id).put("received", received).put("total", total))
                    }
                }
                call.resolve(JSObject().put("name", name).put("size", size))
            } catch (e: CappedDownload.Failure) {
                call.reject(e.reason, e.code)
            } catch (e: Exception) {
                File(context.cacheDir, name).delete()
                call.reject("io: ${e.javaClass.simpleName}", "io")
            }
        }
    }

    @PluginMethod
    fun discard(call: PluginCall) {
        val name = call.getString("name") ?: ""
        // Only names this plugin generated: the value is joined to a directory, so nothing else may pass.
        if (NAME.matches(name)) io.execute { File(context.cacheDir, name).delete(); call.resolve() } else call.resolve()
    }

    override fun handleOnDestroy() {
        io.shutdown()
    }
}
