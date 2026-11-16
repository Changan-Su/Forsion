package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 普通系统通知的分条(NoticeTag):跑法 cd mobile/android && ./gradlew :app:testDebugUnitTest --tests '*NoticeTagTest' */
public class NoticeTagTest {
    @Test
    public void keyedNoticesOfOneSourceAreSeparate() {
        // 有人在等的审批(自己的键)和同一来源后来的普通消息(合成那张的键)各占一条,后者顶不掉前者
        assertNotEquals(NoticeTag.of("plugin:biz", "demo:approval:7"), NoticeTag.of("plugin:biz", "demo:merged"));
        // 同一来源、同一个键:仍是一条(后一条顶掉前一条)
        assertEquals(NoticeTag.of("plugin:biz", "demo:merged"), NoticeTag.of("plugin:biz", "demo:merged"));
        // 同一个键、不同来源:不同条
        assertNotEquals(NoticeTag.of("plugin:a", "k"), NoticeTag.of("plugin:b", "k"));
    }

    @Test
    public void withoutKeyOneNoticePerSourceAsBefore() {
        assertEquals("inbox.message", NoticeTag.of("inbox.message", null));
        assertEquals("inbox.message", NoticeTag.of("inbox.message", ""));
        assertEquals("app", NoticeTag.of(null, null));
        assertEquals("app", NoticeTag.of("", null));
        assertNotEquals(NoticeTag.of("plugin:biz", null), NoticeTag.of("plugin:biz", "demo:merged"));
    }

    @Test
    public void longKeysStayBoundedAndDistinct() {
        String a = "x".repeat(5000) + "a";
        String b = "x".repeat(5000) + "b";
        String ta = NoticeTag.of("plugin:biz", a);
        assertTrue(ta.length() < 200);
        assertNotEquals(ta, NoticeTag.of("plugin:biz", b));
        assertEquals(ta, NoticeTag.of("plugin:biz", a));
    }

    @Test
    public void longKeysWithEqualStringHashesStayApart() {
        // Codex 第五轮:64 字符的插件 id + 两个 100 字符的 key,只差末尾 "Aa" / "BB"(String.hashCode 相同、长度相同)。
        // 宿主拼成的 dedupeKey 是 plugin:<id>:<key>(172 字符,超过 MAX_KEY),旧写法「长度 + 32 位哈希」把两条审批拼成同一个 tag
        String id = "p" + "x".repeat(63);
        String source = "plugin:" + id;
        String a = source + ":" + "x".repeat(98) + "Aa";
        String b = source + ":" + "x".repeat(98) + "BB";
        assertEquals(a.hashCode(), b.hashCode());
        assertEquals(a.length(), b.length());
        assertTrue(a.length() > NoticeTag.MAX_KEY);
        assertNotEquals(NoticeTag.of(source, a), NoticeTag.of(source, b));
        assertEquals(NoticeTag.of(source, a), NoticeTag.of(source, a));
        assertTrue(NoticeTag.of(source, a).length() < 200);
    }

    @Test
    public void sourceAndKeyNeverSpliceIntoTheSameTag() {
        // 来源里带 '|':不能和「来源 + key」拼成同一串(P3)
        assertNotEquals(NoticeTag.of("a|b", null), NoticeTag.of("a", "b"));
        assertNotEquals(NoticeTag.of("a|kb", null), NoticeTag.of("a", "b"));
        assertNotEquals(NoticeTag.of("a|b", "c"), NoticeTag.of("a", "b|c"));
        assertNotEquals(NoticeTag.of("a\\", "b"), NoticeTag.of("a\\|kb", null));
        // 短 key 恰好长得像长 key 的摘要那一段:也不撞
        String longKey = "y".repeat(NoticeTag.MAX_KEY + 1);
        String hashed = NoticeTag.of("s", longKey);
        String tail = hashed.substring(hashed.indexOf('|') + 1);
        assertNotEquals(hashed, NoticeTag.of("s", tail));
    }
}
