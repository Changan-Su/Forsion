package com.forsion.tangu

import android.widget.Toast
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The system back gesture as it happens, and the "back again to exit" hint (page side: mobile/src/nativeBack.ts).
 *
 * What a back does is decided in the page (MobileRoot's chain, on Capacitor's `backButton`). This plugin only adds what
 * that event cannot carry: where the gesture is while the finger is still down. Since Android 14 the system tells an
 * app that opted in (`enableOnBackInvokedCallback`) when an edge swipe starts, how far it went and whether it was
 * abandoned; the page draws that as the same in-between state its own horizontal drag has. Older systems (and the back
 * key) never call the three progress methods: there a back is one event at release, exactly as before.
 *
 * ⚠️ The callback is added after the activity is created, not in `load()`: plugins registered by AppActivity load
 *    before Capacitor's own, and the dispatcher asks the callback added last. Added in `load()`, Capacitor's App
 *    callback would sit on top and this one would never hear a gesture.
 * ⚠️ A completed back is handed on to the callback below (Capacitor's) instead of being answered here: one place
 *    decides what a back does, and a page that has not attached its listener yet keeps Capacitor's fallback.
 */
@CapacitorPlugin(name = "NativeBack")
class NativeBackPlugin : Plugin() {
    private val callback = object : OnBackPressedCallback(true) {
        override fun handleOnBackStarted(backEvent: BackEventCompat) = gesture("start", backEvent)
        override fun handleOnBackProgressed(backEvent: BackEventCompat) = gesture("progress", backEvent)
        override fun handleOnBackCancelled() {
            notifyListeners("gesture", JSObject().put("phase", "cancel"))
        }
        override fun handleOnBackPressed() {
            isEnabled = false
            try { activity.onBackPressedDispatcher.onBackPressed() } finally { isEnabled = true }
        }
    }

    override fun load() {
        bridge.webView.post { activity.onBackPressedDispatcher.addCallback(activity, callback) }
    }

    /** `x` = where the finger is across the page, 0 (left edge) … 1; `edge` = the screen edge the swipe came in from. */
    private fun gesture(phase: String, event: BackEventCompat) {
        val width = bridge.webView?.width ?: 0
        if (width <= 0) return
        notifyListeners(
            "gesture",
            JSObject().put("phase", phase)
                .put("edge", if (event.swipeEdge == BackEventCompat.EDGE_RIGHT) "right" else "left")
                .put("x", (event.touchX / width).coerceIn(0f, 1f).toDouble())
        )
    }

    /** A short system toast: the page's answer to a back on the start page ("back again to exit"). Text is the page's. */
    @PluginMethod
    fun hint(call: PluginCall) {
        val text = call.getString("text")?.take(80)
        if (text.isNullOrBlank()) { call.reject("text is required", "INVALID_TEXT"); return }
        activity.runOnUiThread {
            Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()
            call.resolve()
        }
    }
}
