package com.forsion.tangu

import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Generic native bottom sheet (menu / prompt / confirm) for `lcl/engine/nativeSheet.ts`.
 * Presentation only. Each request is bound to its caller by requestId and resolves exactly once:
 * `{ result }` on an answer, `{ cancelled: true }` on cancel / replacement / page reload / destroy.
 * Lifecycle mirrors NativeModelPickerPlugin.
 */
@CapacitorPlugin(name = "NativeSheet")
class NativeSheetPlugin : Plugin() {
    private var pending: PluginCall? = null
    private var requestId: String? = null
    private var surface: ComposeView? = null
    private var observingPages = false
    private val pageListener = object : WebViewListener() {
        override fun onPageStarted(webView: WebView) { activity.runOnUiThread { finish(null) } }
    }

    @PluginMethod
    fun present(call: PluginCall) {
        val payload = try { SheetPayload.parse(call.data) } catch (e: Exception) {
            call.reject("Invalid native sheet request", "INVALID_REQUEST"); return
        }
        activity.runOnUiThread {
            // Bridge.Builder replaces the listener list after loading plugins: register lazily on first use,
            // otherwise page reloads silently lose this listener (same as NativeModelPickerPlugin).
            if (!observingPages) { bridge.addWebViewListener(pageListener); observingPages = true }
            finish(null)
            pending = call; requestId = payload.requestId
            val root = activity.findViewById<ViewGroup>(android.R.id.content)
            val view = ComposeView(activity)
            surface = view
            view.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            root.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            view.setContent {
                NativeSheetHost(
                    payload,
                    onAnswer = { answer -> if (requestId == payload.requestId) resolve(if (answer != null && payload.accepts(answer)) answer else null) },
                    onGone = { if (surface === view) removeSurface() },
                )
            }
        }
    }

    @PluginMethod
    fun dismiss(call: PluginCall) {
        val id = call.getString("requestId")
        activity.runOnUiThread {
            if (id != null && id == requestId) finish(null)
            call.resolve()
        }
    }

    /** Settle the pending call; the sheet may still be animating out (removed by onGone). */
    private fun resolve(answer: SheetAnswer?) {
        val call = pending
        pending = null; requestId = null
        call?.resolve(JSObject().apply {
            when (answer) {
                null -> put("cancelled", true)
                is SheetAnswer.Pick -> put("result", JSObject().apply { put("id", answer.id); if (answer.trailing) put("trailing", true) })
                is SheetAnswer.Text -> put("result", JSObject().apply { put("text", answer.text) })
                SheetAnswer.Ok -> put("result", JSObject().apply { put("ok", true) })
            }
        })
    }

    private fun removeSurface() {
        surface?.let { view -> (view.parent as? ViewGroup)?.removeView(view); view.disposeComposition() }
        surface = null
    }

    /** Cancel whatever is open, without animation (replacement, reload, destroy, JS abort). */
    private fun finish(answer: SheetAnswer?) {
        resolve(answer)
        removeSurface()
    }

    override fun handleOnDestroy() {
        bridge.removeWebViewListener(pageListener)
        activity.runOnUiThread { finish(null) }
    }
}
