package com.forsion.tangu

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream

/**
 * System document picker for the chat "Add files" entry when it is chosen from a native sheet.
 *
 * Why it exists: Chromium only opens `<input type=file>` with transient user activation. A tap inside the
 * Compose sheet (a separate dialog window) gives the WebView none, so the web input's `click()` is silently
 * dropped. JS reaches this through `window.tangu.pickFiles` (mobile/src/nativeFiles.ts); everything else
 * (size limits, attachment vs workspace file) stays in the composer exactly as for a web pick.
 *
 * Result: `{ files: [{ name, type, data(base64) }], skipped: [name] }`. Files over [MAX_FILE_BYTES], or past
 * [MAX_TOTAL_BYTES] / [MAX_FILES], are listed in `skipped` (never silently dropped). Cancel = empty lists.
 */
@CapacitorPlugin(name = "NativeFilePicker")
class NativeFilePickerPlugin : Plugin() {
    companion object {
        const val MAX_FILES = 20
        const val MAX_FILE_BYTES = 25L * 1024 * 1024 // = the composer's workspace-file cap (MAX_WS_BYTES)
        const val MAX_TOTAL_BYTES = 60L * 1024 * 1024
    }

    @PluginMethod
    fun pick(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        startActivityForResult(call, intent, "onPicked")
    }

    @ActivityCallback
    private fun onPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            call.resolve(JSObject().put("files", JSArray()).put("skipped", JSArray()))
            return
        }
        val uris = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add)
        else data.data?.let(uris::add)
        // Reading can take a while for large / remote documents: off the main thread.
        Thread {
            val files = JSArray()
            val skipped = JSArray()
            var total = 0L
            uris.forEachIndexed { index, uri ->
                val name = displayName(uri) ?: uri.lastPathSegment ?: "file"
                if (index >= MAX_FILES) { skipped.put(name); return@forEachIndexed }
                val bytes = try { readCapped(uri, minOf(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total)) } catch (_: Exception) { null }
                if (bytes == null) { skipped.put(name); return@forEachIndexed }
                total += bytes.size
                files.put(JSObject().apply {
                    put("name", name)
                    put("type", context.contentResolver.getType(uri) ?: "")
                    put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                })
            }
            call.resolve(JSObject().put("files", files).put("skipped", skipped))
        }.start()
    }

    private fun displayName(uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) { null }

    /** Whole document, or null when it is larger than [limit] bytes (never a truncated file). */
    private fun readCapped(uri: Uri, limit: Long): ByteArray? {
        if (limit <= 0) return null
        context.contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            var read = 0L
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                read += n
                if (read > limit) return null
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        }
        return null
    }
}
