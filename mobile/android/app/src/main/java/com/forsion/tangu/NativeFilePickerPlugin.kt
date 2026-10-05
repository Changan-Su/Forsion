package com.forsion.tangu

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Where the chat "+" sheet gets files from: the system document picker (`source` absent / "files"), the system
 * photo picker ("photos") or the camera ("camera"). Chosen from a native sheet.
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
 *
 * Photos: the system photo picker (images only) grants read access to what was picked, like the document picker.
 *
 * Camera: the camera APP takes the picture (ACTION_IMAGE_CAPTURE) into a file of ours under cache/[SHOTS], reached
 * through this app's FileProvider; the page then reads it like any other picked document. The merged manifest
 * declares CAMERA (WebView getUserMedia), and Android refuses ACTION_IMAGE_CAPTURE to an app that declares the
 * permission without holding it — so it is asked for first. A refusal rejects with code [DENIED]; a camera or a
 * picker that cannot be opened (no app for it) rejects with [UNAVAILABLE]. The wording lives in JS (nativeFiles.ts).
 * A shot stays in the cache only until the page has read it: shots older than [KEEP_UNREAD_MS] go at the next
 * capture, all of them at every app start.
 * ponytail: if the system destroys this activity while the camera is up, the shot is lost (the page reloads and
 * its pending call is gone) — take it again. Restoring it needs the saved-state route of @capacitor/camera.
 *
 * One pick at a time ([busy]): Capacitor keeps ONE pending activity call per plugin and [shot] is one slot, so a
 * second `pick` while a system surface (permission question, picker, camera) is still up rejects with [BUSY].
 */
@CapacitorPlugin(
    name = "NativeFilePicker",
    permissions = [Permission(alias = NativeFilePickerPlugin.CAMERA, strings = [Manifest.permission.CAMERA])],
)
class NativeFilePickerPlugin : Plugin() {
    /** The picture being taken: the camera app writes into it, [onCaptured] hands it to the page.
     *  Set on Capacitor's plugin thread (or the main thread, after the permission answer), read on the main thread. */
    @Volatile private var shot: File? = null

    /** True from a `pick` until its system surface has answered (or could not be opened). */
    private val busy = AtomicBoolean(false)

    override fun load() {
        try { clearShots(0) } catch (_: Exception) { /* the cache directory is the system's to manage too */ }
    }

    /** Removes the shots last written more than [keepMs] ago; returns the directory. */
    private fun clearShots(keepMs: Long): File = File(context.cacheDir, SHOTS).apply {
        mkdirs()
        val limit = System.currentTimeMillis() - keepMs
        listFiles()?.forEach { if (it.lastModified() <= limit) it.delete() }
    }

    private fun fail(call: PluginCall, message: String, code: String, cause: Exception? = null) {
        busy.set(false)
        call.reject(message, code, cause)
    }

    @PluginMethod
    fun pick(call: PluginCall) {
        if (!busy.compareAndSet(false, true)) {
            call.reject("another pick is still open", BUSY)
            return
        }
        when (call.getString("source")) {
            "camera" ->
                if (getPermissionState(CAMERA) == PermissionState.GRANTED) capture(call)
                else requestPermissionForAlias(CAMERA, call, "onCameraPermission")
            "photos" -> launch(call, "onPicked") {
                ActivityResultContracts.PickMultipleVisualMedia(FilePickPlan.MAX_FILES)
                    .createIntent(context, PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }
            else -> launch(call, "onPicked") {
                Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
            }
        }
    }

    /** An intent nothing can take throws from the launch — on Capacitor's plugin thread, where an uncaught exception
     *  ends the app: settle the call instead. (No `resolveActivity` probe: that needs a `<queries>` entry on 11+.) */
    private fun launch(call: PluginCall, callback: String, intent: () -> Intent) {
        try {
            startActivityForResult(call, intent(), callback)
        } catch (e: Exception) {
            fail(call, "the system picker could not be opened", UNAVAILABLE, e)
        }
    }

    @PermissionCallback
    private fun onCameraPermission(call: PluginCall?) {
        if (call == null) { busy.set(false); return }
        if (getPermissionState(CAMERA) == PermissionState.GRANTED) capture(call) else fail(call, "camera permission denied", DENIED)
    }

    private fun capture(call: PluginCall) {
        // One catch for the whole step: this runs on the plugin thread (or, after the permission answer, inside a
        // reflective callback) — an exception escaping here would end the app or leave the call unanswered.
        try {
            // Earlier shots were read by the page as soon as they were taken. One taken a moment ago is left alone
            // all the same: its metadata is back with the page, but nothing says the bytes were fetched yet.
            val target = File(clearShots(KEEP_UNREAD_MS), "IMG_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}.jpg")
            shot = target
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, shotUri(target))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            startActivityForResult(call, intent, "onCaptured")
        } catch (e: Exception) {
            shot = null
            fail(call, "the camera could not be opened", UNAVAILABLE, e)
        }
    }

    private fun shotUri(file: File): Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

    @ActivityCallback
    private fun onCaptured(call: PluginCall?, result: ActivityResult) {
        val taken = shot
        shot = null
        busy.set(false)
        if (call == null) { taken?.delete(); return }
        // The answer is OUR file — never an address out of the result intent, which the camera app fills in.
        if (taken == null || result.resultCode != Activity.RESULT_OK || taken.length() == 0L) {
            taken?.delete()
            call.resolve(DocList.answer(JSArray(), JSArray()))
            return
        }
        describe(call, listOf(shotUri(taken)))
    }

    @ActivityCallback
    private fun onPicked(call: PluginCall?, result: ActivityResult) {
        busy.set(false)
        if (call == null) return
        val uris = try { pickedUris(result) } catch (_: Exception) { emptyList() }
        if (uris.isEmpty()) { call.resolve(DocList.answer(JSArray(), JSArray())); return }
        describe(call, uris)
    }

    /** Provider queries can block (remote documents): off the main thread. One resolve, whatever happens inside. */
    private fun describe(call: PluginCall, uris: List<Uri>) {
        Thread {
            val out = try { DocList.describe(context, uris) } catch (_: Exception) { DocList.answer(JSArray(), JSArray()) }
            call.resolve(out)
        }.start()
    }

    private fun pickedUris(result: ActivityResult): List<Uri> {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) return emptyList()
        val uris = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add)
        else data.data?.let(uris::add)
        return uris
    }

    companion object {
        const val CAMERA = "camera"
        /** Error codes of a rejected `pick` (worded for the user in nativeFiles.ts). */
        const val DENIED = "denied"
        const val UNAVAILABLE = "unavailable"
        const val BUSY = "busy"
        /** Directory under the app cache holding the pictures the page has not read yet (normally: one). */
        const val SHOTS = "camera"
        /** How long a shot is safe from the next capture's clean-up (the page reads it within moments). */
        const val KEEP_UNREAD_MS = 60_000L
    }
}

/**
 * Describes documents for the page: `{ files: [{ uri, name, type, size }], skipped: [name] }`. No bytes are read here.
 * Shared by the picker above and the share target (ShareInboxPlugin): both hand the page content URIs this activity
 * holds a read grant for, and the page streams them the same way (mobile/src/pickedFiles.ts).
 */
internal object DocList {
    fun answer(files: JSArray, skipped: JSArray): JSObject = JSObject().put("files", files).put("skipped", skipped)

    private class Described(val name: String, val type: String, val size: Long)

    /** Blocking (provider queries): call off the main thread. */
    fun describe(context: Context, uris: List<Uri>): JSObject {
        // A document whose provider throws (getType / query are provider calls) is skipped; the others go on.
        val described = uris.map { uri -> try { describeOne(context, uri) } catch (_: Exception) { null } }
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

    fun fallbackName(uri: Uri): String = try { uri.lastPathSegment } catch (_: Exception) { null } ?: "file"

    private fun describeOne(context: Context, uri: Uri): Described {
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
