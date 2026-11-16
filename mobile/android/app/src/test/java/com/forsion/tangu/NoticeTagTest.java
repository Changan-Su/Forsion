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
        assertNotEquals(NoticeTag.of("plugin:biz", "business:approval:7"), NoticeTag.of("plugin:biz", "business:phone"));
        // 同一来源、同一个键:仍是一条(后一条顶掉前一条)
        assertEquals(NoticeTag.of("plugin:biz", "business:phone"), NoticeTag.of("plugin:biz", "business:phone"));
        // 同一个键、不同来源:不同条
        assertNotEquals(NoticeTag.of("plugin:a", "k"), NoticeTag.of("plugin:b", "k"));
    }

    @Test
    public void withoutKeyOneNoticePerSourceAsBefore() {
        assertEquals("inbox.message", NoticeTag.of("inbox.message", null));
        assertEquals("inbox.message", NoticeTag.of("inbox.message", ""));
        assertEquals("app", NoticeTag.of(null, null));
        assertEquals("app", NoticeTag.of("", null));
        assertNotEquals(NoticeTag.of("plugin:biz", null), NoticeTag.of("plugin:biz", "business:phone"));
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
}
