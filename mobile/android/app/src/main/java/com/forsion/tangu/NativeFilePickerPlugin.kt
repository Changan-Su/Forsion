package com.forsion.tangu

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * System document picker for the chat "Add files" entry when it is chosen from a native sheet.
 *
 * Why it exists: Chromium only opens `<input type=file>` with transient user activation. A tap inside the
 * Compose sheet (a separate dialog window) gives the WebView none, so the web input's `click()` is silently
 * dropped. JS reaches this through `window.tangu.pickFiles` (mobile/src/nativeFiles.ts); everything else
 * (attachment vs workspace file) stays in the composer exactly as for a web pick.
 *
 * No file bytes cross the bridge. The result only describes the picked documents:
 * `{ files: [{ uri, name, type, size }], skipped: [name] }` (`size` = -1 when the provider does not report one).
 * JS then streams each document through Capacitor's local server (`Capacitor.convertFileSrc(uri)` →
 * `https://localhost/_capacitor_content_/…`, served by WebViewLocalServer via ContentResolver.openInputStream)
 * and enforces the byte caps on what actually arrives. The previous version read every file into a byte
 * array, base64-encoded it and sent up to 60 MB as ONE bridge message that JS decoded and copied again.
 *
 * URI permission: ACTION_OPEN_DOCUMENT grants this app read access to the returned URIs for as long as this
 * activity lives. JS fetches right after `pick()` resolves, so nothing is persisted (no
 * takePersistableUriPermission) and there is nothing to release.
 *
 * Documents past [FilePickPlan]'s caps, or whose provider throws while being described, are listed in
 * `skipped` (never silently dropped). Cancel = empty lists. Every path settles the call exactly once.
 */
@CapacitorPlugin(name = "NativeFilePicker")
class NativeFilePickerPlugin : Plugin() {
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
        val uris = try { pickedUris(result) } catch (_: Exception) { emptyList() }
        if (uris.isEmpty()) { call.resolve(answer(JSArray(), JSArray())); return }
        // Provider queries can block (remote documents): off the main thread. One resolve, whatever happens inside.
        Thread {
            val out = try { describe(uris) } catch (_: Exception) { answer(JSArray(), JSArray()) }
            call.resolve(out)
        }.start()
    }

    private fun answer(files: JSArray, skipped: JSArray): JSObject = JSObject().put("files", files).put("skipped", skipped)

    private fun pickedUris(result: ActivityResult): List<Uri> {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) return emptyList()
        val uris = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add)
        else data.data?.let(uris::add)
        return uris
    }

    private class Described(val name: String, val type: String, val size: Long)

    private fun describe(uris: List<Uri>): JSObject {
        // A document whose provider throws (getType / query are provider calls) is skipped; the others go on.
        val described = uris.map { uri -> try { describeOne(uri) } catch (_: Exception) { null } }
        val plan = FilePickPlan.plan(described.map { it?.size })
        val files = JSArray()
        val skipped = JSArray()
        uris.forEachIndexed { i, uri ->
            val d = described[i]
            if (d != null && plan[i]) {
                files.put(JSObject().put("uri", uri.toString()).put("name", d.name).put("type", d.type).put("size", d.size))
            } else {
                skipped.put(d?.name ?: fallbackName(uri))
            }
        }
        return answer(files, skipped)
    }

    private fun fallbackName(uri: Uri): String = try { uri.lastPathSegment } catch (_: Exception) { null } ?: "file"

    private fun describeOne(uri: Uri): Described {
        var name: String? = null
        var size = -1L
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val nameAt = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeAt = c.getColumnIndex(OpenableColumns.SIZE)
                if (nameAt >= 0 && !c.isNull(nameAt)) name = c.getString(nameAt)
                if (sizeAt >= 0 && !c.isNull(sizeAt)) size = c.getLong(sizeAt)
            }
        }
        return Described(name ?: fallbackName(uri), context.contentResolver.getType(uri) ?: "", if (size >= 0) size else -1L)
    }
}
