package com.forsion.tangu

import android.app.Application
import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertLeftPositionInRootIsEqualTo
import androidx.compose.ui.test.assertTopPositionInRootIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
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
 * The phone's notification banner (NativeBanner.kt) on the JVM: what the bridge accepts, where the card sits, what a tap,
 * the × and a swipe report, and what a screen reader gets. From mobile/: `npm run test:nativebar`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w412dp-h915dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NativeBannerTest {
    @get:Rule(order = 0) val activity = object : ExternalResource() {
        override fun before() {
            val app = ApplicationProvider.getApplicationContext<Application>()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app.packageName, ComponentActivity::class.java.name))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val theme = """{"dark":false,"background":"#FFF8F7F6","surface":"#FFFFFFFF","text":"#FF202124","muted":"#FF6E7076","border":"#1A000000","accent":"#FF4D8794","onAccent":"#FFFFFFFF","danger":"#FFD04040"}"""
    private fun banner(extra: String = "") = JSONObject("""{"banner":{"id":"ntf-1","source":"Business · Waiting on you","text":"3 items need you","action":"Open workbench","level":"info","dismiss":"Dismiss","hint":"Swipe up","theme":$theme$extra}}""")

    @Test fun parsesTheCardAndToleratesWhatIsNotWorthLosingANotificationOver() {
        val b = BannerSpec.parse(banner())!!
        assertEquals("ntf-1", b.id)
        assertEquals("Business · Waiting on you: 3 items need you", b.spoken)
        assertEquals(BannerSpec.Level.INFO, b.level)
        // a page older than float / accentInk: the card surface and the accent
        assertEquals(b.theme.surface, b.theme.float)
        assertEquals(b.theme.accent, b.theme.accentInk)
        // null = no banner
        assertNull(BannerSpec.parse(JSONObject("""{"banner":null}""")))
        assertNull(BannerSpec.parse(JSONObject("{}")))
        // too long is cut, an unknown level is info, a missing label has a fallback
        val long = BannerSpec.parse(JSONObject("""{"banner":{"id":"x","text":"${"a".repeat(900)}","level":"shout","theme":$theme}}"""))!!
        assertEquals(BannerSpec.MAX_TEXT, long.text.length)
        assertEquals(BannerSpec.Level.INFO, long.level)
        assertEquals("", long.action)
        assertEquals("Dismiss", long.dismiss)
        // the new colours when the page sends them
        val tinted = BannerSpec.parse(JSONObject("""{"banner":{"id":"x","text":"t","theme":${theme.dropLast(1)},"float":"#FF101010","accentInk":"#FF202020"}}}"""))!!
        assertEquals(0xFF101010.toInt(), tinted.theme.float)
        assertEquals(0xFF202020.toInt(), tinted.theme.accentInk)
        // what JS cannot recover from by itself: no id, a bad theme → the call is refused (the page draws the banner)
        assertThrows(Exception::class.java) { BannerSpec.parse(JSONObject("""{"banner":{"id":"","text":"t","theme":$theme}}""")) }
        assertThrows(Exception::class.java) { BannerSpec.parse(JSONObject("""{"banner":{"text":"t","theme":$theme}}""")) }
        assertThrows(Exception::class.java) { BannerSpec.parse(JSONObject("""{"banner":{"id":"x","text":"t","theme":{"dark":false}}}""")) }
    }

    @Test fun aSwipeOrAFlickUpwardsSendsItAway() {
        assertTrue(bannerFlungAway(-24f, 0f))
        assertTrue(bannerFlungAway(-30f, 0f))
        assertFalse(bannerFlungAway(-23f, 0f))
        assertTrue(bannerFlungAway(-8f, -900f)) // a flick
        assertFalse(bannerFlungAway(-8f, -300f))
        assertFalse(bannerFlungAway(0f, -2000f)) // never moved up
        assertFalse(bannerFlungAway(10f, 0f))
    }

    private fun show(spec: BannerSpec?, inset: Int = 0, onAction: (String) -> Unit = {}, onDismiss: (String) -> Unit = {}) =
        compose.setContent { Box(Modifier.width(412.dp)) { NativeBanner(spec, inset, onAction, onDismiss) } }

    @Test fun sitsUnderTheStatusBarAcrossTheWidthOneLineHigh() {
        show(BannerSpec.parse(banner()), inset = 24) // mdpi: 24px = 24dp of status bar
        compose.onNodeWithTag("nativeBanner.card")
            .assertHeightIsEqualTo(54.dp).assertWidthIsEqualTo(392.dp) // 412 − 10 − 10
            .assertTopPositionInRootIsEqualTo(28.dp).assertLeftPositionInRootIsEqualTo(10.dp)
        compose.onNodeWithTag("nativeBanner.action", useUnmergedTree = true).assertHeightIsEqualTo(30.dp)
        compose.onNodeWithTag("nativeBanner.close").assertWidthIsEqualTo(40.dp)
    }

    @Test fun tapIsTheActionAndTheCrossIsTheUsersOwnDismiss() {
        val said = mutableListOf<String>()
        show(BannerSpec.parse(banner()), onAction = { said += "action:$it" }, onDismiss = { said += "dismiss:$it" })
        compose.onNodeWithTag("nativeBanner.card").performClick()
        compose.onNodeWithTag("nativeBanner.action", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("nativeBanner.close").performClick()
        compose.waitForIdle()
        assertEquals(listOf("action:ntf-1", "action:ntf-1", "dismiss:ntf-1"), said)
        // gone after its exit, and the × a second time says nothing more
        compose.mainClock.advanceTimeBy(400)
        compose.onNodeWithTag("nativeBanner.card").assertDoesNotExist()
    }

    @Test fun withoutAnActionATapDoesNothing() {
        val said = mutableListOf<String>()
        show(BannerSpec.parse(JSONObject("""{"banner":{"id":"n","text":"Synced","level":"success","dismiss":"Dismiss","theme":$theme}}""")), onAction = { said += it })
        compose.onNodeWithTag("nativeBanner.card").performClick()
        compose.onNodeWithTag("nativeBanner.action", useUnmergedTree = true).assertDoesNotExist()
        assertTrue(said.isEmpty())
    }

    @Test fun swipingUpFarEnoughDismissesAShortOneSpringsBack() {
        val said = mutableListOf<String>()
        show(BannerSpec.parse(banner()), onDismiss = { said += it })
        compose.mainClock.advanceTimeBy(400)
        // 10dp, slowly: back where it was
        compose.onNodeWithTag("nativeBanner.card").performTouchInput { swipeUp(startY = centerY, endY = centerY - 10f, durationMillis = 600) }
        compose.mainClock.advanceTimeBy(400)
        assertTrue(said.isEmpty())
        compose.onNodeWithTag("nativeBanner.card").assertTopPositionInRootIsEqualTo(4.dp)
        // 40dp: gone, reported as the user's own
        compose.onNodeWithTag("nativeBanner.card").performTouchInput { swipeUp(startY = centerY, endY = centerY - 40f, durationMillis = 600) }
        compose.mainClock.advanceTimeBy(400)
        assertEquals(listOf("ntf-1"), said)
        compose.onNodeWithTag("nativeBanner.card").assertDoesNotExist()
    }

    @Test fun aScreenReaderHearsSourceAndTextPolitelyAndGetsOpenAndDismissAsActions() {
        val said = mutableListOf<String>()
        show(BannerSpec.parse(banner()), onAction = { said += "action" }, onDismiss = { said += "dismiss" })
        val card = compose.onNodeWithTag("nativeBanner.card").assertContentDescriptionEquals("Business · Waiting on you: 3 items need you")
        val config = card.fetchSemanticsNode().config
        assertEquals(LiveRegionMode.Polite, config.getOrNull(SemanticsProperties.LiveRegion))
        val actions = config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        assertEquals(listOf("Open workbench", "Dismiss"), actions.map { it.label })
        compose.runOnUiThread { actions.forEach { it.action() } }
        assertEquals(listOf("action", "dismiss"), said)
    }

    @Test fun theSameCardWithNewWordsIsUpdatedInPlaceANewOneReplacesIt() {
        var spec by mutableStateOf(BannerSpec.parse(banner()))
        compose.setContent { Box(Modifier.width(412.dp)) { NativeBanner(spec, 0, {}, {}) } }
        compose.mainClock.advanceTimeBy(400)
        spec = BannerSpec.parse(JSONObject(banner().toString().replace("3 items need you", "4 items need you")))
        compose.waitForIdle()
        compose.onNodeWithTag("nativeBanner.text", useUnmergedTree = true).assertExists()
        assertEquals("4 items need you", compose.onNodeWithTag("nativeBanner.text", useUnmergedTree = true).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text })
        spec = null
        compose.mainClock.advanceTimeBy(400)
        compose.onNodeWithTag("nativeBanner.card").assertDoesNotExist()
    }
}
