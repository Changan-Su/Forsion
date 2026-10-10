package com.forsion.tangu

import android.app.Application
import android.content.ComponentName
import android.graphics.Rect
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertTouchHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.core.graphics.Insets
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The native bars by themselves — the two capsules at the top and the dock — laid out on the JVM (Robolectric): sizes,
 * what a screen reader is told, the dock's scrolling. No emulator; a few seconds. From mobile/: `npm run test:nativebar`.
 *
 * The emulator suite (scripts/native-shell-emu.cjs) is about the bars and the page fitting together; change
 * NativeChromeBar.kt and this is the first thing to run. Each of the last two tests was seen to fail with its fix
 * taken out (2026-10-09): `lane` as a key of the dock's bring-into-view, `zIndex` on the pinned cell.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w1000dp-h800dp-mdpi") // wide: the dock is tried at two widths
@GraphicsMode(GraphicsMode.Mode.NATIVE) // a real android.graphics.Region: what a screen reader is given is worked out with one
class NativeChromeBarLayoutTest {
    /** createComposeRule opens a ComponentActivity; the app's manifest does not list one (and a debug build should not get one for this). */
    @get:Rule(order = 0) val activity = object : ExternalResource() {
        override fun before() {
            val app = ApplicationProvider.getApplicationContext<Application>()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app.packageName, ComponentActivity::class.java.name))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val theme = """{"dark":false,"background":"#FFF8F7F6","surface":"#FFFFFFFF","text":"#FF202124","muted":"#FF6E7076","border":"#1A000000","accent":"#FF4D8794","onAccent":"#FFFFFFFF","danger":"#FFD04040"}"""
    private fun shell(tabCount: Int = 2, spaces: String = "[]") = ChromeState.parse(JSONObject("""{
      "mode":"shell","title":"Chat","left":true,"right":true,"tabCount":$tabCount,"floating":true,"frosted":true,
      "labels":{"left":"Left","right":"Right","tabs":"Tabs","more":"More"},"theme":$theme,"spaces":$spaces
    }"""))
    /** [count] Spaces s0…; s0 is the pinned first cell (Home). */
    private fun spaces(count: Int, active: Int) = (0 until count).joinToString(",", "[", "]") { """{"id":"s$it","label":"Space $it","active":${it == active}}""" }

    private fun top(state: ChromeState) = compose.setContent {
        Box(Modifier.width(400.dp).height(NATIVE_CHROME_HEIGHT)) { NativeChromeBar(state, Insets.NONE, { _, _ -> }) {} }
    }

    @Test fun capsulesAndTheirButtonsHaveTheirSizes() {
        top(shell())
        compose.onNodeWithTag("nativeChrome.capLeft").assertHeightIsEqualTo(46.dp)
        compose.onNodeWithTag("nativeChrome.capRight").assertHeightIsEqualTo(46.dp)
        // a 40dp disc in the capsule, a 48dp target for the finger
        for (id in listOf("left", "right", "tabs", "more")) {
            compose.onNodeWithTag("nativeChrome.$id").assertWidthIsEqualTo(40.dp).assertHeightIsEqualTo(40.dp).assertTouchHeightIsEqualTo(48.dp)
        }
    }

    @Test fun topBarTellsAScreenReaderWhatEachButtonIs() {
        top(shell())
        compose.onNodeWithTag("nativeChrome.left").assertContentDescriptionEquals("Left")
        compose.onNodeWithTag("nativeChrome.right").assertContentDescriptionEquals("Right")
        compose.onNodeWithTag("nativeChrome.more").assertContentDescriptionEquals("More")
        compose.onNodeWithTag("nativeChrome.tabs").assertContentDescriptionEquals("Tabs").assertTextEquals("2") // "Tabs, 2"
        compose.onNodeWithTag("nativeChrome.title").assertTextEquals("Chat")
    }

    @Test fun oneTabNeedsNoCountButton() {
        top(shell(tabCount = 1))
        compose.onNodeWithTag("nativeChrome.tabs").assertDoesNotExist()
        compose.onNodeWithTag("nativeChrome.more").assertExists()
    }

    private fun dock(width: () -> Dp, state: ChromeState, onSpace: (String) -> Unit = {}) = compose.setContent {
        Box(Modifier.width(width()).height(NATIVE_SPACE_BAR_HEIGHT)) { NativeSpaceBar(state, Insets.NONE, { _, _ -> }) { id, _ -> onSpace(id) } }
    }

    @Test fun dockIsOneCapsuleOfIconsAndOnlyTheActiveSpaceShowsItsName() {
        dock({ 400.dp }, shell(spaces = spaces(3, 1)))
        compose.onNodeWithTag("nativeChrome.dock").assertHeightIsEqualTo(56.dp)
        compose.onNodeWithTag("nativeChrome.space.s0").assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(42.dp)
            .assertIsNotSelected().assertContentDescriptionEquals("Space 0") // no name on screen: the label is spoken
        val active = compose.onNodeWithTag("nativeChrome.space.s1").assertHeightIsEqualTo(42.dp)
            .assertIsSelected().assertTextEquals("Space 1") // the name is on screen: nothing else to say
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.ContentDescription))
        assertTrue("the active cell is no wider than an icon", active.getUnclippedBoundsInRoot().width > 48.dp)
    }

    /** Is the last of nine Spaces — the active one — inside the lane, and Home still at the dock's left? */
    private fun assertLastInViewAndHomePinned(why: String) {
        compose.waitForIdle()
        val dock = compose.onNodeWithTag("nativeChrome.dock").getUnclippedBoundsInRoot()
        val home = compose.onNodeWithTag("nativeChrome.space.s0").getUnclippedBoundsInRoot()
        val last = compose.onNodeWithTag("nativeChrome.space.s8").getUnclippedBoundsInRoot()
        assertEquals("$why: Home is not at the dock's left", (dock.left + 7.dp).value, home.left.value, 0.5f)
        assertTrue("$why: the active Space (${last.left}..${last.right}) is not inside the lane (${home.right}..${dock.right - 7.dp})",
            last.left >= home.right - 0.5.dp && last.right <= dock.right - 7.dp + 0.5.dp)
    }

    @Test fun activeSpaceIsBroughtIntoViewAndAgainWhenTheDockGetsNarrower() {
        var width by mutableStateOf(360.dp)
        dock({ width }, shell(spaces = spaces(9, 8)))
        assertLastInViewAndHomePinned("nine Spaces in a phone's width")
        // A rotation: in landscape everything fits and nothing is scrolled; back in portrait the active cell is the
        // size it was, in a lane that no longer shows it.
        width = 900.dp
        compose.waitForIdle()
        width = 360.dp
        assertLastInViewAndHomePinned("after the dock got narrower again")
    }

    /** The rectangle a screen reader (and `uiautomator dump`) is given for [tag]: what no node above it covers. */
    private fun spokenBounds(tag: String): Rect {
        val node = compose.onNodeWithTag(tag).fetchSemanticsNode()
        val info = (node.root as ViewRootForTest).view.accessibilityNodeProvider.createAccessibilityNodeInfo(node.id)
        return Rect().also { info!!.getBoundsInScreen(it) }
    }

    @Test fun pinnedFirstCellKeepsItsWholeCellOnceTheOthersSlideUnderIt() {
        val asked = mutableListOf<String>()
        dock({ 360.dp }, shell(spaces = spaces(9, 8))) { asked += it }
        compose.waitForIdle() // scrolled to the last Space: the others have slid under the pinned cell
        // 2026-10-09 on a device: the right half of Home read as its neighbour, Home itself was a sliver
        assertEquals("the width a screen reader is given for Home (px = dp here)", 48, spokenBounds("nativeChrome.space.s0").width())
        compose.onNodeWithTag("nativeChrome.space.s0").performTouchInput { click(Offset(width - 4f, height / 2f)) }
        compose.waitForIdle()
        assertEquals(listOf("s0"), asked)
    }
}
