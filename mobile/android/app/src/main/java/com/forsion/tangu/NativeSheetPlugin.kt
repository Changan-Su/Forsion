package com.forsion.tangu

import android.content.Context
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
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
                    onGone = { if (surface === view) { removeSurface(); reportGone(payload.requestId) } },
                )
            }
        }
    }

    /**
     * Ask for the soft keyboard on the WebView's focused field. A field the page focuses without a touch of its own (an
     * answer from this sheet opening the command panel) gets no keyboard from the WebView: Chromium only asks for one on a
     * focus that follows a touch on the page. Measured 2026-11-19 (emulator, walk f): 1 in 10 came up, and that one was
     * the system's own forward-navigation show, not the page's. The page calls this once the sheet is gone and the field it
     * focused under it still has the caret (mobile/src/nativeSheet.ts).
     * The request is served only once the activity window has its focus back from the sheet's own window: asked at once
     * it fails at PHASE_CLIENT_VIEW_SERVED (7 in 10 in the same probe). So it is asked when the window has focus, and again
     * every 100 ms until it is taken (2 s at most); it stops as soon as the window has its focus and no editable field is
     * focused in the page.
     */
    @PluginMethod
    fun showKeyboard(call: PluginCall) {
        activity.runOnUiThread {
            val web = bridge.webView
            val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            var tries = 0
            lateinit var attempt: Runnable
            attempt = Runnable {
                tries++
                // while the window is without its focus Chromium may report no editor for a field that has the caret
                // (it resets its input state on losing window focus): only give up once the window has its focus back
                if (web.hasWindowFocus() && !web.onCheckIsTextEditor()) { call.resolve(JSObject().put("shown", false).put("tries", tries)); return@Runnable }
                if (!web.hasFocus()) web.requestFocus()
                val shown = web.hasWindowFocus() && imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT)
                if (shown || tries >= 20) call.resolve(JSObject().put("shown", shown).put("tries", tries))
                else web.postDelayed(attempt, 100)
            }
            attempt.run()
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
                is SheetAnswer.Checked -> put("result", JSObject().apply { put("checked", org.json.JSONArray(answer.ids)) })
            }
        })
    }

    private fun removeSurface() {
        surface?.let { view -> (view.parent as? ViewGroup)?.removeView(view); view.disposeComposition() }
        surface = null
    }

    /**
     * The sheet has finished going away: tell the page. An answer settles the call while the sheet is still animating out,
     * and the page acts on it at once — a text field it focuses then (the command panel opened from the avatar menu) gets
     * no keyboard while this view covers the WebView. Focused again after this, it does (mobile/src/nativeSheet.ts).
     * Only on the animated exit: a replacement brings the next sheet straight up. Carries the request it was, so the page
     * can tell a sheet that left from the one that is up now.
     */
    private fun reportGone(id: String) {
        val web = bridge.webView
        if (!web.hasFocus()) web.requestFocus()
        bridge.triggerWindowJSEvent("forsion:native-sheet-gone", JSObject().put("requestId", id).toString())
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
