package com.forsion.tangu

import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.view.WindowCompat
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin

/** Presentation only. Each request is bound to its caller and resolves once, including cancellation. */
@CapacitorPlugin(name = "NativeModelPicker")
class NativeModelPickerPlugin : Plugin() {
    private var pending: PluginCall? = null
    private var requestId: String? = null
    private var surface: ComposeView? = null
    private var observingPages = false
    private val pageListener = object : WebViewListener() {
        override fun onPageStarted(webView: WebView) { activity.runOnUiThread { finish(null) } }
    }

    @PluginMethod
    fun setAppearance(call: PluginCall) {
        val dark = call.getBoolean("dark", false) == true
        val background = try { android.graphics.Color.parseColor(call.getString("background")) }
            catch (_: Exception) { if (dark) 0xff272a2a.toInt() else 0xfff8f7f6.toInt() }
        activity.runOnUiThread {
            val root = activity.findViewById<ViewGroup>(android.R.id.content)
            root.setBackgroundColor(background)
            WindowCompat.getInsetsController(activity.window, root).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun present(call: PluginCall) {
        val payload = try { ModelPickerPayload.parse(call.data) } catch (e: Exception) {
            call.reject("Invalid model picker request", "INVALID_REQUEST"); return
        }
        activity.runOnUiThread {
            // Bridge.Builder replaces the listener list after loading plugins. Register lazily
            // once the first call arrives, otherwise page reloads silently lose this listener.
            if (!observingPages) { bridge.addWebViewListener(pageListener); observingPages = true }
            finish(null)
            pending = call; requestId = payload.requestId
            val root = activity.findViewById<ViewGroup>(android.R.id.content)
            val view = ComposeView(activity)
            surface = view
            view.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            root.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            view.setContent {
                NativeModelSheet(payload, onCancel = { if (requestId == payload.requestId) finish(null) }, onDone = { values ->
                    if (requestId == payload.requestId) finish(if (payload.validValues(values)) values else null)
                })
            }
        }
    }

    @PluginMethod
    fun dismiss(call: PluginCall) {
        val id = call.getString("requestId")
        activity.runOnUiThread {
            if (id == requestId) finish(null)
            call.resolve()
        }
    }

    private fun finish(values: Map<String, String>?) {
        val call = pending
        pending = null; requestId = null
        surface?.let { view -> (view.parent as? ViewGroup)?.removeView(view); view.disposeComposition() }
        surface = null
        call?.resolve(JSObject().apply {
            if (values == null) put("cancelled", true)
            else put("values", JSObject().apply { values.forEach { (key, value) -> put(key, value) } })
        })
    }

    override fun handleOnDestroy() { bridge.removeWebViewListener(pageListener); activity.runOnUiThread { finish(null) } }
}
