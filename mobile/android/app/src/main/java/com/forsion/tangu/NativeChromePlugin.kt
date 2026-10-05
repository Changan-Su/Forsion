package com.forsion.tangu

import android.os.Build
import android.util.TypedValue
import android.view.HapticFeedbackConstants
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.coordinatorlayout.widget.CoordinatorLayout
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import kotlin.math.roundToInt

/**
 * Native top app bar around the Capacitor WebView (`lcl/engine/nativeChrome.ts` → `mobile/src/nativeChrome.ts`).
 *
 * Layout: the bar is a ComposeView added to the WebView's parent (CoordinatorLayout, gravity TOP), painted from
 * the status bar down; the WebView is laid out BELOW it via its top margin. On Android 15 Capacitor
 * (`adjustMarginsForEdgeToEdge: 'auto'`) installs a window-insets listener on the WebView that copies the
 * system-bar insets into its margins — after plugins load. We replace that listener lazily on the first
 * `setState` with one that keeps left/right/bottom identical and sets top = status bar + bar (bar visible) or
 * status bar (hidden), so nothing is padded twice and no web content sits under the status bar.
 * Bottom navigation bar (Spaces): a second ComposeView at gravity BOTTOM, painted down to the screen edge behind
 * the system navigation inset; the WebView ends above it via its bottom margin. Shown in shell mode with two or
 * more Spaces, and never while the keyboard is up (it would sit on top of the keyboard and eat the composer's room).
 * Actions are emitted as `action` events; JS owns all state. A page reload removes the bar (the next page
 * pushes state again if it has a shell).
 */
@CapacitorPlugin(name = "NativeChrome")
class NativeChromePlugin : Plugin() {
    private var bar: ComposeView? = null
    private var spaceBar: ComposeView? = null
    private var imeVisible = false
    private var imeBottom = 0
    private val state = mutableStateOf<ChromeState?>(null)
    private val insets = mutableStateOf(Insets.NONE)
    private var observingPages = false
    private var insetsHooked = false
    private var adjustsMargins = false
    private val pageListener = object : WebViewListener() {
        override fun onPageStarted(webView: WebView) { activity.runOnUiThread { teardown() } }
    }

    @PluginMethod
    fun setState(call: PluginCall) {
        val parsed = try { ChromeState.parse(call.data) } catch (e: Exception) {
            call.reject("Invalid chrome state", "INVALID_STATE"); return
        }
        activity.runOnUiThread {
            attach()
            state.value = parsed
            WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
                isAppearanceLightStatusBars = !parsed.theme.dark
                isAppearanceLightNavigationBars = !parsed.theme.dark
            }
            layout()
            call.resolve()
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        activity.runOnUiThread { teardown(); call.resolve() }
    }

    /**
     * Touch feedback for a moment that happens inside the page (JS decides when): "tick" = something small went
     * through (a message was sent). The system's own effect, so the user's touch-feedback setting applies and no
     * VIBRATE permission is involved. Unknown kinds do nothing. Long-presses are not routed here: the WebView already
     * gives LONG_PRESS when the page takes one.
     */
    @PluginMethod
    fun haptic(call: PluginCall) {
        val tick = call.getString("kind") == "tick"
        activity.runOnUiThread {
            if (tick) bridge.webView?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
            call.resolve()
        }
    }

    /** Same decision Capacitor's CapacitorWebView.edgeToEdgeHandler makes. */
    private fun capacitorAdjustsMargins(): Boolean {
        val mode = bridge.config.adjustMarginsForEdgeToEdge()
        if (mode == "force") return true
        if (mode != "auto" || Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return false
        val value = TypedValue()
        val found = activity.theme.resolveAttribute(android.R.attr.windowOptOutEdgeToEdgeEnforcement, value, true)
        return !(found && value.data != 0)
    }

    private fun attach() {
        if (!observingPages) { bridge.addWebViewListener(pageListener); observingPages = true }
        val webView = bridge.webView
        if (!insetsHooked) {
            insetsHooked = true
            adjustsMargins = capacitorAdjustsMargins()
            if (adjustsMargins) {
                ViewCompat.getRootWindowInsets(webView)?.let {
                    insets.value = it.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                }
                ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
                    insets.value = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                    // This listener outlives the bars (page reload, JS-side fallback): keyboard avoidance must not go with them.
                    readIme(windowInsets)
                    layout()
                    WindowInsetsCompat.CONSUMED // as Capacitor: do not pass insets to the page
                }
                ViewCompat.requestApplyInsets(webView)
            }
        }
        if (bar == null) {
            val parent = webView.parent as ViewGroup
            val view = ComposeView(activity)
            view.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            view.setContent {
                val current = state.value
                if (current != null && current.visible) NativeChromeBar(current, insets.value) { action -> emit(action) }
            }
            val params = CoordinatorLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0)
            params.gravity = Gravity.TOP
            parent.addView(view, params)
            bar = view
        }
        if (spaceBar == null) {
            val parent = webView.parent as ViewGroup
            val view = ComposeView(activity)
            view.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            view.setContent {
                val current = state.value
                if (current != null && current.spaceBar) NativeSpaceBar(current, insets.value) { id, long -> emitSpace(id, long) }
            }
            // Own listener (the WebView's is only hooked where Capacitor adjusts margins): keyboard up → bar away,
            // and — edge-to-edge only, see layout() — the WebView ends at the keyboard's top edge.
            // ponytail: devices that do not report IME insets keep the bar above the keyboard; wire the Keyboard plugin's events if that shows up.
            ViewCompat.setOnApplyWindowInsetsListener(view) { _, windowInsets ->
                if (readIme(windowInsets)) layout()
                windowInsets
            }
            val params = CoordinatorLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0)
            params.gravity = Gravity.BOTTOM
            parent.addView(view, params)
            spaceBar = view
            ViewCompat.requestApplyInsets(view)
        }
    }

    /** Records the keyboard's state; true when it changed. */
    private fun readIme(windowInsets: WindowInsetsCompat): Boolean {
        val ime = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
        val bottom = if (ime) windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom else 0
        if (ime == imeVisible && bottom == imeBottom) return false
        imeVisible = ime; imeBottom = bottom
        return true
    }

    private fun barPx(): Int = (NATIVE_CHROME_HEIGHT.value * activity.resources.displayMetrics.density).roundToInt()
    private fun spaceBarPx(): Int = (NATIVE_SPACE_BAR_HEIGHT.value * activity.resources.displayMetrics.density).roundToInt()

    /** WebView margins + bar height. Deterministic (no measuring) so there is no layout feedback loop. */
    private fun layout() {
        val webView = bridge.webView ?: return
        val i = insets.value
        val visible = bar != null && state.value?.visible == true
        val top = i.top + if (visible) barPx() else 0
        val spacesVisible = spaceBar != null && state.value?.spaceBar == true && !imeVisible
        // Edge-to-edge (Android 15+, where we own the margins): the window is no longer resized for the keyboard and
        // Capacitor's own handler ignores it too, so the page would keep its full height with the composer underneath
        // the keyboard. Elsewhere the system still resizes the window (adjustResize) — adding the inset would pad twice.
        val bottom = if (imeVisible && adjustsMargins) maxOf(i.bottom, imeBottom) else i.bottom + if (spacesVisible) spaceBarPx() else 0
        (webView.layoutParams as? ViewGroup.MarginLayoutParams)?.let { mlp ->
            if (mlp.leftMargin != i.left || mlp.topMargin != top || mlp.rightMargin != i.right || mlp.bottomMargin != bottom) {
                mlp.setMargins(i.left, top, i.right, bottom)
                webView.layoutParams = mlp
            }
        }
        spaceBar?.let { view ->
            view.visibility = if (spacesVisible) View.VISIBLE else View.GONE
            val height = i.bottom + spaceBarPx()
            if (view.layoutParams.height != height) {
                view.layoutParams = view.layoutParams.apply { this.height = height }
            }
        }
        bar?.let { view ->
            view.visibility = if (visible) View.VISIBLE else View.GONE
            val height = i.top + barPx()
            if (view.layoutParams.height != height) {
                view.layoutParams = view.layoutParams.apply { this.height = height }
            }
        }
    }

    private fun emit(action: String) {
        if (action in ChromeState.ACTIONS) notifyListeners("action", JSObject().apply { put("action", action) })
    }

    private fun emitSpace(id: String, long: Boolean) {
        notifyListeners("action", JSObject().apply { put("action", if (long) "spaceLong" else "space"); put("id", id) })
    }

    /** Remove the bars and give the WebView back the margins Capacitor would have set. */
    private fun teardown() {
        state.value = null
        bar?.let { view -> (view.parent as? ViewGroup)?.removeView(view); view.disposeComposition() }
        bar = null
        spaceBar?.let { view -> (view.parent as? ViewGroup)?.removeView(view); view.disposeComposition() }
        spaceBar = null
        layout()
    }

    override fun handleOnDestroy() {
        bridge.removeWebViewListener(pageListener)
        activity.runOnUiThread { teardown() }
    }
}
