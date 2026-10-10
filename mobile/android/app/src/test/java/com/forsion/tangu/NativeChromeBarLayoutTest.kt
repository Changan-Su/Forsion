package com.forsion.tangu

import android.app.Application
import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertTouchHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.width
import androidx.core.graphics.Insets
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
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
 * what a screen reader is told, which Spaces the dock holds. No emulator; a few seconds. From mobile/: `npm run test:nativebar`.
 *
 * The emulator suite (scripts/native-shell-emu.cjs) is about the bars and the page fitting together; change
 * NativeChromeBar.kt and this is the first thing to run. Seen to fail with the code under test broken (2026-10-09):
 * the dock taking every pinned Space instead of four, "all" never being the selected cell, its dot taken from the
 * first Space behind it instead of the most pressing one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w1000dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
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
    private val icon = """{"kind":"vector","viewBox":[0,0,24,24],"strokeWidth":2,"paths":[{"d":"M18 6 6 18","fill":false,"stroke":true}]}"""
    private fun shell(tabCount: Int = 2, spaces: String = "[]", extra: String = "") = ChromeState.parse(JSONObject("""{
      "mode":"shell","title":"Chat","left":true,"right":true,"tabCount":$tabCount,"floating":true,"frosted":true,
      "labels":{"left":"Left","right":"Right","tabs":"Tabs","more":"More"},"theme":$theme,"spaces":$spaces,
      "allLabel":"All","icons":{"all":$icon,"search":$icon,"titleMore":$icon}$extra
    }"""))
    /** [count] Spaces s0…, [active] the one you are in; [pinned] = the ones the user keeps in the dock, [badges] = id → kind. */
    private fun spaces(count: Int, active: Int, pinned: Set<Int> = emptySet(), badges: Map<Int, String> = emptyMap()) =
        (0 until count).joinToString(",", "[", "]") {
            val badge = badges[it]?.let { kind -> ""","badge":{"kind":"$kind","label":"$kind!"}""" } ?: ""
            """{"id":"s$it","label":"Space $it","active":${it == active},"pinned":${it in pinned}$badge}"""
        }

    private fun top(state: ChromeState, onAction: (String) -> Unit = {}) = compose.setContent {
        Box(Modifier.width(400.dp).height(NATIVE_CHROME_HEIGHT)) { NativeChromeBar(state, Insets.NONE, { _, _ -> }, onAction) }
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

    @Test fun searchButtonAndTheTitlesSecondPartAreThereOnlyWhenThePageAsks() {
        top(shell())
        compose.onNodeWithTag("nativeChrome.search").assertDoesNotExist()
        compose.onNodeWithTag("nativeChrome.titleSub").assertDoesNotExist()
    }

    @Test fun pageWithSomethingToSearchGetsASearchButtonAndATitleThatIsAButton() {
        val asked = mutableListOf<String>()
        top(shell(extra = ""","search":"Search notes","titleSub":"Cloud vault","titleTap":true""")) { asked += it }
        compose.onNodeWithTag("nativeChrome.search").assertContentDescriptionEquals("Search notes")
            .assertWidthIsEqualTo(40.dp).assertTouchHeightIsEqualTo(48.dp).performClick()
        // one button for a screen reader ("Chat, Cloud vault"); the two parts are still there to be looked up
        compose.onNodeWithTag("nativeChrome.titleButton").assertTextEquals("Chat", "Cloud vault").assertHeightIsEqualTo(40.dp).assertTouchHeightIsEqualTo(48.dp).performClick()
        compose.onNodeWithTag("nativeChrome.titleSub", useUnmergedTree = true).assertTextEquals("Cloud vault")
        assertEquals(listOf("search", "title"), asked)
    }

    private fun dock(width: Int, state: () -> ChromeState, asked: MutableList<String> = mutableListOf()) = compose.setContent {
        Box(Modifier.width(width.dp).height(NATIVE_SPACE_BAR_HEIGHT)) {
            NativeSpaceBar(state(), Insets.NONE, { _, _ -> }, onAll = { asked += "all" }) { id, _ -> asked += id }
        }
    }
    private fun dock(width: Int, state: ChromeState, asked: MutableList<String> = mutableListOf()) = dock(width, { state }, asked)
    /** Whole dp on this screen (mdpi): a fifth of the dock rounds to a pixel either way. */
    private val pixel = 1f
    private fun left(tag: String) = compose.onNodeWithTag(tag).getUnclippedBoundsInRoot().left
    private fun widthOf(tag: String) = compose.onNodeWithTag(tag).getUnclippedBoundsInRoot().width

    @Test fun cellIsAnIconOverItsNameAndTheOneYouAreInIsSelected() {
        dock(400, shell(spaces = spaces(3, 1)))
        compose.onNodeWithTag("nativeChrome.dock").assertHeightIsEqualTo(68.dp)
        // few Spaces: cells at their widest, the dock as wide as they are (not the screen's width)
        compose.onNodeWithTag("nativeChrome.dock").assertWidthIsEqualTo(84.dp * 3 + 12.dp)
        for (i in 0..2) compose.onNodeWithTag("nativeChrome.space.s$i").assertWidthIsEqualTo(84.dp).assertHeightIsEqualTo(56.dp).assertTextEquals("Space $i")
        compose.onNodeWithTag("nativeChrome.space.s0").assertIsNotSelected()
        compose.onNodeWithTag("nativeChrome.space.s1").assertIsSelected()
        compose.onNodeWithTag("nativeChrome.spacesAll").assertDoesNotExist() // everything is in the dock already
    }

    @Test fun fiveSpacesFillTheDockAndNeedNoAllCell() {
        dock(400, shell(spaces = spaces(5, 0)))
        for (i in 0..4) compose.onNodeWithTag("nativeChrome.space.s$i").assertExists()
        compose.onNodeWithTag("nativeChrome.spacesAll").assertDoesNotExist()
        assertEquals("five equal cells in what the dock has inside its 12dp margins and 6dp padding", (400f - 24f - 12f) / 5f, widthOf("nativeChrome.space.s4").value, pixel)
    }

    @Test fun withMoreSpacesThanCellsTheDockHoldsThePinnedFourAndAnAllCell() {
        val asked = mutableListOf<String>()
        // six pinned: the dock still has four cells for Spaces — the first four in list order
        dock(400, shell(spaces = spaces(9, 4, pinned = setOf(0, 1, 4, 6, 7, 8))), asked)
        for (i in listOf(0, 1, 4, 6)) compose.onNodeWithTag("nativeChrome.space.s$i").assertExists()
        for (i in listOf(2, 3, 5, 7, 8)) compose.onNodeWithTag("nativeChrome.space.s$i").assertDoesNotExist()
        compose.onNodeWithTag("nativeChrome.spacesAll").assertTextEquals("All").assertIsNotSelected().assertHeightIsEqualTo(56.dp)
        compose.onNodeWithTag("nativeChrome.space.s4").assertIsSelected()
        val w = (400f - 24f - 12f) / 5f
        assertEquals(w, widthOf("nativeChrome.space.s0").value, pixel)
        assertEquals(w, widthOf("nativeChrome.spacesAll").value, pixel)
        assertEquals("cells stand in list order, 'all' last", 12f + 6f + 4 * w, left("nativeChrome.spacesAll").value, 2 * pixel)
        compose.onNodeWithTag("nativeChrome.spacesAll").assertTouchHeightIsEqualTo(56.dp)
        compose.onNodeWithTag("nativeChrome.space.s6").performClick()
        compose.onNodeWithTag("nativeChrome.spacesAll").performClick()
        assertEquals(listOf("s6", "all"), asked)
    }

    @Test fun inASpaceThatIsNotInTheDockTheAllCellIsTheSelectedOne() {
        dock(400, shell(spaces = spaces(9, 7, pinned = setOf(0, 1, 2, 3))))
        compose.onNodeWithTag("nativeChrome.spacesAll").assertIsSelected()
        for (i in 0..3) compose.onNodeWithTag("nativeChrome.space.s$i").assertIsNotSelected()
    }

    @Test fun cellsStayWhereTheyAreWhateverSpaceYouAreIn() {
        var active by mutableStateOf(0)
        dock(360, { shell(spaces = spaces(9, active, pinned = setOf(0, 1, 2, 3))) })
        fun places() = (0..3).map { left("nativeChrome.space.s$it") } + left("nativeChrome.spacesAll")
        val before = places()
        for (next in listOf(2, 8)) { // another cell of the dock, then a Space behind "all"
            active = next
            compose.waitForIdle()
            assertEquals("in Space $next", before, places())
        }
    }

    @Test fun allCellCarriesTheMostPressingDotOfTheSpacesBehindIt() {
        // s1 is in the dock with its own dot; behind "all": s5 unread, s7 waiting for the user, s8 running
        dock(400, shell(spaces = spaces(9, 0, pinned = setOf(0, 1, 2, 3), badges = mapOf(1 to "running", 5 to "unread", 7 to "attention", 8 to "running"))))
        fun state(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().config.getOrNull(SemanticsProperties.StateDescription)
        assertEquals("running!", state("nativeChrome.space.s1"))
        assertEquals("attention!", state("nativeChrome.spacesAll"))
        assertEquals(null, state("nativeChrome.space.s2"))
    }
}
