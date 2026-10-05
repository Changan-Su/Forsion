package com.forsion.tangu

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedContentTest {
    private val own = "com.forsion.tangu"

    @Test
    fun onlyOtherAppsContentUrisAreAccepted() {
        assertTrue(SharedContent.foreignContent("content", "media", own))
        assertTrue(SharedContent.foreignContent("content", "com.android.providers.downloads.documents", own))
        // a file path, or one of this app's own providers, would attach the app's private files
        assertFalse(SharedContent.foreignContent("file", null, own))
        assertFalse(SharedContent.foreignContent("file", "", own))
        assertFalse(SharedContent.foreignContent("content", own, own))
        assertFalse(SharedContent.foreignContent("content", "$own.fileprovider", own))
        // … however the authority is dressed up: a user prefix (ContentResolver strips it), a port
        assertFalse(SharedContent.foreignContent("content", "0@$own.fileprovider", own))
        assertFalse(SharedContent.foreignContent("content", "media@$own.fileprovider", own))
        assertFalse(SharedContent.foreignContent("content", "$own.fileprovider:80", own))
        assertTrue(SharedContent.foreignContent("content", "10@media", own))
        assertFalse(SharedContent.foreignContent("content", "", own))
        assertFalse(SharedContent.foreignContent("content", null, own))
        assertFalse(SharedContent.foreignContent("http", "example.com", own))
        assertFalse(SharedContent.foreignContent(null, "media", own))
        // a different app whose name merely starts with ours is another app
        assertTrue(SharedContent.foreignContent("content", "com.forsion.tanguy.provider", own))
    }

    @Test
    fun aSharedPageKeepsItsTitleAheadOfItsAddress() {
        assertEquals("Forsion\nhttps://forsion.net", SharedContent.withSubject(" Forsion ", "https://forsion.net"))
        assertEquals("plain text", SharedContent.withSubject(null, " plain text "))
        assertEquals("Forsion — https://forsion.net", SharedContent.withSubject("Forsion", "Forsion — https://forsion.net")) // the text opens with it
        assertEquals("see below\nForsion\nhttps://forsion.net", SharedContent.withSubject("Forsion", "see below\nForsion\nhttps://forsion.net")) // a line of its own
        assertEquals("news\nhttps://example.org/news", SharedContent.withSubject("news", "https://example.org/news")) // a word of the address is not the title
        assertEquals("", SharedContent.withSubject("photo.jpg", null)) // a subject alone is not text
    }

    @Test
    fun textIsTrimmedAndClippedWithoutSplittingASurrogatePair() {
        assertEquals("", SharedContent.clip(null))
        assertEquals("hi", SharedContent.clip("  hi \n"))
        val long = "a".repeat(SharedContent.MAX_TEXT + 5)
        assertEquals(SharedContent.MAX_TEXT, SharedContent.clip(long).length)
        val emojiAtTheCut = "a".repeat(SharedContent.MAX_TEXT - 1) + "\uD83D\uDE00"
        assertEquals(SharedContent.MAX_TEXT - 1, SharedContent.clip(emojiAtTheCut).length)
    }
}
