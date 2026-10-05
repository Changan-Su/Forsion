package com.forsion.tangu

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.IntentCompat
import com.getcapacitor.JSArray
import com.getcapacitor.Plugin
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * "Share → Forsion": the app is a target of the system share sheet (ACTION_SEND / ACTION_SEND_MULTIPLE filters on
 * MainActivity). What arrives is handed to the page as one `shared` event —
 * `{ text, files: [{ uri, name, type, size }], skipped: [name] }` — and the page asks where it goes: a chat's message
 * box (text into the draft, documents as attachments) or a note (mobile/src/shareInbox.tsx). Nothing is sent on the
 * user's behalf.
 *
 * The intent comes from another app, so it is untrusted input:
 *  - only `content:` URIs of other apps are accepted ([SharedContent.foreignContent]); a `file:` URI or one of our
 *    own providers would make this app attach its private files to a draft. Refused ones are named in `skipped`;
 *  - text is clipped ([SharedContent.MAX_TEXT]) and the number of documents bounded before any provider is queried;
 *  - no bytes cross the bridge: the page streams each document through Capacitor's local server under the read
 *    grant the share gave this activity, exactly like a picked file (see [DocList], NativeFilePickerPlugin).
 *    The page refuses an address that would leave its own provider once the browser normalises it
 *    (`content://x/../../_capacitor_file_/…` = this app's private files): `staysInItsProvider`, pickedFiles.ts.
 *
 * Delivery: the event is retained until the page listens (a cold start gets here long before the page does).
 * A share is acted on once. BridgeActivity replays the launch intent on every create, and a task reopened from
 * Recents is started with its last intent again — both would bring an old share back (same rule as LiveIslandPlugin).
 */
@CapacitorPlugin(name = "ShareInbox")
class ShareInboxPlugin : Plugin() {
    override fun handleOnNewIntent(intent: Intent?) {
        super.handleOnNewIntent(intent)
        if (intent == null) return
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
        if (!LiveIslandPlugin.freshLaunch && intent === activity.intent) return skipped("the launch intent again (activity recreated)")
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return skipped("the task's last intent again (from Recents)")
        val shared = try { read(intent) } catch (_: Exception) { null } ?: return
        // Provider queries can block (remote documents): off the main thread.
        Thread {
            val out = try { DocList.describe(context, shared.uris) } catch (_: Exception) { DocList.answer(JSArray(), JSArray()) }
            val skipped = out.optJSONArray("skipped") ?: JSArray().also { out.put("skipped", it) }
            shared.refused.forEach { skipped.put(it) }
            // On the thread plugin calls run on: retaining an event and the page's addListener both touch the
            // plugin's unsynchronised listener maps, and a cold start has the two arrive close together.
            bridge.execute { notifyListeners("shared", out.put("text", shared.text), true) }
        }.start()
    }

    private fun skipped(why: String) { Log.d("ShareInbox", "not a new share: $why") }

    private class Shared(val text: String, val uris: List<Uri>, val refused: List<String>)

    private fun read(intent: Intent): Shared? {
        val streams: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> return null
        }
        val own = context.packageName
        // Past the cap nothing is asked of any provider; those are still named as not added (by their path, bounded).
        val (uris, refused) = streams.take(SharedContent.MAX_URIS).partition { SharedContent.foreignContent(it.scheme, it.authority, own) }
        val over = streams.drop(SharedContent.MAX_URIS).take(SharedContent.MAX_REPORTED)
        val text = SharedContent.clip(SharedContent.withSubject(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()))
        if (text.isEmpty() && streams.isEmpty()) return null
        return Shared(text, uris, (refused + over).map(DocList::fallbackName))
    }
}

/** The decisions about a share that need no Android classes (unit-tested: SharedContentTest). */
internal object SharedContent {
    const val MAX_TEXT = 100_000
    const val MAX_URIS = FilePickPlan.MAX_FILES
    const val MAX_REPORTED = 200

    /**
     * Only another app's content. The provider is named by what follows the last `@` of the authority — that is how
     * ContentResolver itself reads it (`content://10@media/…` = "media" for user 10), so comparing the raw authority
     * would let `0@<our provider>` through. Anything after the name (a port) keeps it ours.
     */
    fun foreignContent(scheme: String?, authority: String?, ownPackage: String): Boolean {
        val provider = authority?.substringAfterLast('@')
        return scheme == "content" && !provider.isNullOrEmpty() && provider != ownPackage && !provider.startsWith("$ownPackage.")
    }

    /**
     * A page shared from a browser comes as its address in the text and its title in the subject: both are kept,
     * title first — unless the text already opens with it or has it as a line of its own. (Not "contains": a title
     * can be a word of the address.) A subject on its own (some apps name the shared file there) is not text.
     */
    fun withSubject(subject: String?, text: String?): String {
        val s = subject?.trim().orEmpty()
        val t = text?.trim().orEmpty()
        return if (s.isEmpty() || t.isEmpty() || t.startsWith(s) || t.lineSequence().any { it.trim() == s }) t else "$s\n$t"
    }

    /** Trimmed and at most [MAX_TEXT] chars, never ending on half a surrogate pair. */
    fun clip(text: String?): String {
        val t = (text ?: "").trim()
        if (t.length <= MAX_TEXT) return t
        val cut = if (Character.isHighSurrogate(t[MAX_TEXT - 1])) MAX_TEXT - 1 else MAX_TEXT
        return t.substring(0, cut)
    }
}
