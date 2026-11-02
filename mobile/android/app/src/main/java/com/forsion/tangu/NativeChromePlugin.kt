package com.forsion.tangu

import android.content.Context
import android.os.Build
import android.util.TypedValue
import android.view.HapticFeedbackConstants
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityManager
import android.webkit.WebView
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.coordinatorlayout.widget.CoordinatorLayout
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Native top chrome and Space dock around the Capacitor WebView (`lcl/engine/nativeChrome.ts` → `mobile/src/nativeChrome.ts`).
 *
 * Layout: the top chrome is a ComposeView added to the WebView's parent (CoordinatorLayout, gravity TOP), reaching
 * from the screen's top edge down past the status bar; the dock (Spaces) is a second one at gravity BOTTOM, reaching
 * down to the screen edge behind the system navigation inset. It is shown in shell mode with two or more Spaces, and
 * never while the keyboard is up (it would sit on top of the keyboard and eat the composer's room).
 * The keyboard coming up (where we own the margins, see `imeMoving`): the WebView keeps its height until the keyboard
 * has arrived, and the page is told how far and how fast (`ime` event) so what stands at its bottom edge travels with
 * the keyboard instead of jumping to where it is going.
 * The dock holds a handful of Spaces; with more than fit, its last cell reports `spacesAll` and JS shows the rest.
 * Going to a detail page and back, the dock sinks and fades instead of vanishing (`dockMotion`): the view stays up until
 * it has gone, takes no touches on the way, and the page moves the blur behind it along (`motion` on the dock's plate).
 * Wide windows (2026-10-20, mock-up A2; the page's own wide line, judged here on the whole window): the same view is a
 * rail at the left edge instead (gravity START, full height, opaque), the WebView starts right of it, and it stays up
 * while the keyboard is (it is beside the keyboard, not on it). The verdict goes to the page with every `layout` event
 * (`wide`): judged on the WebView, the rail's own width would flip a 4:3 tablet back to narrow and the rail away again.
 *
 * Two arrangements (2026-10-09):
 *  - floating — shell pages that ask for it (`floating`): the WebView runs under both (top margin 0; bottom margin 0
 *    while the dock shows, the navigation inset otherwise), the views are see-through around their capsules, and the
 *    page is told where everything is (`layout` event, in dp: how much to keep clear at the top / bottom, and each
 *    capsule's rectangle, where it draws the blur a native view cannot). Touches that miss a capsule fall through to
 *    the WebView: a ComposeView only takes what one of its pointer inputs was hit by.
 *  - strips — pages (settings, market), covering overlays, and shells that did not ask: the WebView is laid out
 *    between the two, which paint their strip. Nothing in such a page has to know about the capsules.
 * On Android 15 Capacitor (`adjustMarginsForEdgeToEdge: 'auto'`) installs a window-insets listener on the WebView that
 * copies the system-bar insets into its margins — after plugins load. We replace that listener lazily on the first
 * `setState` with one that sets the margins described above, so nothing is padded twice.
 * Actions are emitted as `action` events; JS owns all state. A page reload removes the chrome (the next page
 * pushes state again if it has a shell).
 */
@CapacitorPlugin(name = "NativeChrome")
class NativeChromePlugin : Plugin() {
    private var bar: ComposeView? = null
    private var spaceBar: ComposeView? = null
    private var imeVisible = false
    private var imeBottom = 0
    /** The keyboard is sliding (in, out, or to another height). While it is coming up or growing, the WebView's bottom
     *  margin stays what it was (layout()): a page made shorter at the first frame would jump its bottom edge ahead of
     *  the keyboard. Going away or getting smaller needs no holding — the page gets the height back at once and has
     *  room to let things slide down by itself. */
    private var imeMoving = false
    private val imeSettled = Runnable { if (imeMoving) { imeMoving = false; layout() } }
    private val imeCallback = object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_STOP) {
        private fun ime(animation: WindowInsetsAnimationCompat) = animation.typeMask and WindowInsetsCompat.Type.ime() != 0
        override fun onPrepare(animation: WindowInsetsAnimationCompat) {
            if (!ime(animation)) return
            imeMoving = true
            // onEnd is the normal way out; a view detached mid-animation never gets one, and a page left at full height
            // under the keyboard is not a state to stay in
            bridge.webView?.let { it.removeCallbacks(imeSettled); it.postDelayed(imeSettled, animation.durationMillis + 500) }
        }
        // the new insets were applied between onPrepare and here (layout() ran and held the margin)
        override fun onStart(animation: WindowInsetsAnimationCompat, bounds: WindowInsetsAnimationCompat.BoundsCompat): WindowInsetsAnimationCompat.BoundsCompat {
            if (ime(animation)) reportIme(animation)
            return bounds
        }
        override fun onProgress(windowInsets: WindowInsetsCompat, running: MutableList<WindowInsetsAnimationCompat>) = windowInsets
        override fun onEnd(animation: WindowInsetsAnimationCompat) {
            if (!ime(animation)) return
            bridge.webView?.removeCallbacks(imeSettled)
            imeSettled.run()
        }
    }
    private val state = mutableStateOf<ChromeState?>(null)
    private val insets = mutableStateOf(Insets.NONE)
    private var observingPages = false
    private var insetsHooked = false
    private var adjustsMargins = false
    /** Where the capsules are (window px), as their composables report it. Sent on with the next `layout` event. */
    private val plates = LinkedHashMap<String, Rect>()
    private var layoutPosted = false
    private var lastLayout = ""
    /** A screen reader (touch exploration: TalkBack and its kind) going on / off is reported with the layout, see reportLayout. */
    private var readerHooked = false
    /** The last wide verdict (see wideWindow); kept while the window has no size yet. */
    private var wide = false
    private var parentHooked = false
    /** The window changed size (rotation, split screen): the verdict and the margins follow. Posted: this runs inside a layout pass. */
    private val parentListener = View.OnLayoutChangeListener { v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
        if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) v.post { layout() }
    }
    /** The dock is on its way out ("out") or back ("in"); null at rest. Only for a change of page: see dockChange. */
    private var dockMotion: String? = null
    /** The Spaces stand in the rail (wide windows) rather than the dock; read by the views' content. */
    private val rail = mutableStateOf(false)
    private val readerListener = AccessibilityManager.TouchExplorationStateChangeListener { scheduleLayoutReport() }
    private fun accessibility() = activity.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
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
            dockChange(state.value, parsed)
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
        if (!readerHooked) { readerHooked = true; accessibility()?.addTouchExplorationStateChangeListener(readerListener) }
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
                // Only here: elsewhere the system resizes the window itself, at the animation's first frame.
                ViewCompat.setWindowInsetsAnimationCallback(webView, imeCallback)
                ViewCompat.requestApplyInsets(webView)
            }
        }
        if (bar == null) {
            val parent = webView.parent as ViewGroup
            val view = ComposeView(activity)
            view.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            view.setContent {
                val current = state.value
                if (current != null && current.visible) NativeChromeBar(current, insets.value, ::onPlate, { action -> emit(action) }, rail = rail.value)
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
                if (rail.value) {
                    if (current != null && current.spaceBar) NativeSpaceRail(current, insets.value, onAll = { emit("spacesAll") }, onAccount = { emit("account") }) { id, long -> emitSpace(id, long) }
                } else NativeDockHost(
                    current, insets.value, ::onPlate, onAll = { emit("spacesAll") }, onSpace = { id, long -> emitSpace(id, long) },
                    animated = { dockMotion != null }, onSettled = ::dockSettled,
                )
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
        if (!parentHooked) { parentHooked = true; (webView.parent as View).addOnLayoutChangeListener(parentListener) }
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
    private fun railPx(): Int = (NATIVE_RAIL_WIDTH.value * activity.resources.displayMetrics.density).roundToInt()

    /**
     * The page's wide line (lcl SingleColumnHost WIDE_QUERY: aspect ≥ 4:3 and ≥ 520dp wide — keep the numbers equal),
     * judged on the whole window (the WebView's parent) minus the side cutouts: the rail does not change it.
     */
    private fun wideWindow(): Boolean {
        val parent = bridge.webView?.parent as? View ?: return wide
        if (parent.width <= 0 || parent.height <= 0) return wide
        val density = activity.resources.displayMetrics.density
        val w = (parent.width - insets.value.left - insets.value.right) / density
        val h = parent.height / density
        wide = w >= 520f && w * 3f >= h * 4f
        return wide
    }

    /**
     * Does this state change take the dock away or bring it back, and is that one to play? Not with the keyboard up
     * (where the system resizes the window the dock would ride up on it) and not without the frosted page behind it
     * (a strip's WebView is laid out around the dock at once); those stay a cut, as does the first state of all.
     */
    private fun dockChange(before: ChromeState?, after: ChromeState) {
        if (before == null || before.spaceBar == after.spaceBar) return
        val floats = if (after.spaceBar) after.floating else before.floating
        dockMotion = if (!floats || imeVisible || wideWindow()) null else if (after.spaceBar) "in" else "out"
    }

    private fun dockSettled() {
        if (dockMotion == null) return
        dockMotion = null
        layout()
    }

    private fun barVisible() = bar != null && state.value?.visible == true
    private fun spacesShown() = spaceBar != null && state.value?.spaceBar == true
    /** The rail: wide windows, keyboard or not. */
    private fun railVisible() = spacesShown() && wideWindow()
    /** The dock: never while the keyboard is up (it would ride on it and eat the composer's room). */
    private fun spacesVisible() = spacesShown() && !imeVisible && !wideWindow()
    /** The page runs under the chrome (see the class comment). Only a shell state can carry `floating`. */
    private fun floating() = barVisible() && state.value?.floating == true

    /** WebView margins + bar height. Deterministic (no measuring) so there is no layout feedback loop. */
    private fun layout() {
        val webView = bridge.webView ?: return
        val i = insets.value
        val visible = barVisible()
        val floating = floating()
        val top = if (floating) 0 else i.top + if (visible) barPx() else 0
        val spacesVisible = spacesVisible()
        val railOn = railVisible()
        rail.value = railOn
        val left = i.left + if (railOn) railPx() else 0
        // Edge-to-edge (Android 15+, where we own the margins): the window is no longer resized for the keyboard and
        // Capacitor's own handler ignores it too, so the page would keep its full height with the composer underneath
        // the keyboard. Elsewhere the system still resizes the window (adjustResize) — adding the inset would pad twice.
        // Floating: the page reaches the screen's bottom edge only where the dock is (a first-level page keeps its
        // content clear of it anyway); one level down it ends at the navigation inset as before, so nothing that sits
        // at the bottom of a detail page (the composer, an editor's toolbar) has to learn about the gesture bar.
        val held = (webView.layoutParams as? ViewGroup.MarginLayoutParams)?.bottomMargin ?: 0
        val bottom = when {
            imeVisible && adjustsMargins && imeMoving && imeRoom() > held -> held // see imeMoving
            imeVisible && adjustsMargins -> imeRoom()
            floating -> if (spacesVisible) 0 else i.bottom
            else -> i.bottom + if (spacesVisible) spaceBarPx() else 0
        }
        (webView.layoutParams as? ViewGroup.MarginLayoutParams)?.let { mlp ->
            if (mlp.leftMargin != left || mlp.topMargin != top || mlp.rightMargin != i.right || mlp.bottomMargin != bottom) {
                mlp.setMargins(left, top, i.right, bottom)
                webView.layoutParams = mlp
            }
        }
        spaceBar?.let { view ->
            if ((imeVisible || railOn) && dockMotion != null) dockMotion = null // nothing rides on the keyboard; the rail took over
            view.visibility = if (spacesVisible || railOn || dockMotion == "out") View.VISIBLE else View.GONE
            // the same view is the dock (a strip at the bottom) or the rail (a column at the left edge, past the side cutout)
            val params = view.layoutParams as CoordinatorLayout.LayoutParams
            val gravity = if (railOn) Gravity.START else Gravity.BOTTOM
            val width = if (railOn) i.left + railPx() else ViewGroup.LayoutParams.MATCH_PARENT
            val height = if (railOn) ViewGroup.LayoutParams.MATCH_PARENT else i.bottom + spaceBarPx()
            if (params.gravity != gravity || params.width != width || params.height != height) {
                view.layoutParams = params.apply { this.gravity = gravity; this.width = width; this.height = height }
            }
        }
        bar?.let { view ->
            view.visibility = if (visible) View.VISIBLE else View.GONE
            val height = i.top + barPx()
            if (view.layoutParams.height != height) {
                view.layoutParams = view.layoutParams.apply { this.height = height }
            }
        }
        scheduleLayoutReport()
    }

    private fun onPlate(id: String, bounds: Rect?) {
        if (plates[id] == bounds) return
        if (bounds == null) plates.remove(id) else plates[id] = bounds
        scheduleLayoutReport()
    }

    /** One report per frame at most: a state change moves several capsules and the margins together. */
    private fun scheduleLayoutReport() {
        if (layoutPosted) return
        val webView = bridge.webView ?: return
        layoutPosted = true
        webView.post { layoutPosted = false; reportLayout() }
    }

    /**
     * Tells the page where the chrome is, in dp (= CSS px at the WebView's own scale; the page divides by its zoom):
     * `top` / `bottom` = how much of its own top / bottom edge lies under the chrome, `status` = the status-bar part of
     * `top`, `plates` = each capsule's rectangle relative to the WebView. Everything is zero / empty unless floating.
     */
    private fun reportLayout() {
        val webView = bridge.webView ?: return
        val floating = floating()
        val density = activity.resources.displayMetrics.density
        val i = insets.value
        val origin = IntArray(2).also { webView.getLocationInWindow(it) }
        fun dp(px: Float) = Math.round(px / density * 100f) / 100.0
        val data = JSObject()
        data.put("floating", floating)
        // Not about the chrome, but the page needs it at the same moments (first paint, every reload): what it marks for a
        // screen reader costs a rebuild of that part of the accessibility tree, which it only pays while one is listening.
        // Touch exploration, not AccessibilityManager.isEnabled: that one is also true for password fillers and auto-clickers.
        data.put("reader", accessibility()?.isTouchExplorationEnabled == true)
        data.put("wide", wideWindow()) // the page lays itself out wide on this verdict, not on its own width (see wideWindow)
        data.put("status", if (floating) dp(i.top.toFloat()) else 0.0)
        data.put("top", if (floating) dp(i.top.toFloat()) + NATIVE_CHROME_HEIGHT.value else 0.0)
        data.put("bottom", if (floating && spacesVisible()) dp(i.bottom.toFloat()) + NATIVE_SPACE_BAR_HEIGHT.value else 0.0)
        val list = JSArray()
        if (floating) for ((id, r) in plates) {
            // the dock's plate outlives the dock while the keyboard is up (the view is only hidden, not disposed)
            val leaving = id == "dock" && dockMotion == "out"
            if (id == "dock" && !spacesVisible() && !leaving) continue
            list.put(JSObject().apply {
                put("id", id); put("x", dp(r.left - origin[0])); put("y", dp(r.top - origin[1])); put("w", dp(r.width)); put("h", dp(r.height))
                if (id == "dock") dockMotion?.let { put("motion", it) }
            })
        }
        data.put("plates", list)
        val key = data.toString()
        if (key == lastLayout) return
        lastLayout = key
        notifyListeners("layout", data, true)
    }

    private fun imeRoom() = maxOf(insets.value.bottom, imeBottom)

    /**
     * The keyboard starts coming up (or growing): how far the page's bottom edge will have moved once the WebView is
     * resized (`rise`, dp), how long the keyboard takes and along which curve (`ease`, sampled into a CSS `linear()`),
     * and when this was said (`at`, wall clock — the page starts its own motion that much into it).
     * Going away is said too, as `rise` 0: a keyboard dismissed before it had arrived never made the page shorter, so
     * the page sees no change of height and would leave what was riding up there. Getting smaller is not said: the
     * page sees its own height grow.
     */
    private fun reportIme(animation: WindowInsetsAnimationCompat) {
        if (!adjustsMargins) return
        val held = (bridge.webView?.layoutParams as? ViewGroup.MarginLayoutParams)?.bottomMargin ?: return
        val rise = if (imeVisible) imeRoom() - held else 0
        if (imeVisible && rise <= 0) return
        val data = JSObject()
        data.put("rise", Math.round(rise / activity.resources.displayMetrics.density * 100f) / 100.0)
        data.put("ms", animation.durationMillis)
        data.put("at", System.currentTimeMillis())
        animation.interpolator?.let { curve ->
            data.put("ease", (0..20).joinToString(", ", "linear(", ")") { String.format(Locale.US, "%.4f", curve.getInterpolation(it / 20f)) })
        }
        notifyListeners("ime", data)
    }

    private fun emit(action: String) {
        if (action in ChromeState.ACTIONS) notifyListeners("action", JSObject().apply { put("action", action) })
    }

    private fun emitSpace(id: String, long: Boolean) {
        notifyListeners("action", JSObject().apply { put("action", if (long) "spaceLong" else "space"); put("id", id) })
    }

    /** Remove the bars and give the WebView back the margins Capacitor would have set. */
    private fun teardown() {
        dockMotion = null
        state.value = null
        bar?.let { view -> (view.parent as? ViewGroup)?.removeView(view); view.disposeComposition() }
        bar = null
        spaceBar?.let { view -> (view.parent as? ViewGroup)?.removeView(view); view.disposeComposition() }
        spaceBar = null
        plates.clear()
        rail.value = false
        if (parentHooked) { parentHooked = false; (bridge.webView?.parent as? View)?.removeOnLayoutChangeListener(parentListener) }
        lastLayout = "" // the next page starts from nothing: whatever is reported next must reach it, also when it equals the last report
        layout()
    }

    override fun handleOnDestroy() {
        bridge.removeWebViewListener(pageListener)
        accessibility()?.removeTouchExplorationStateChangeListener(readerListener)
        readerHooked = true // a setState still queued for the UI thread runs attach() after this: it must not hook the listener back on (nothing would take it off again)
        bridge.webView?.removeCallbacks(imeSettled)
        activity.runOnUiThread { teardown() }
    }
}
