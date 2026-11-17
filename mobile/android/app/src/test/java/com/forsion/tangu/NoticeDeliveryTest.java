package com.forsion.tangu;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.NotificationManager;

import org.junit.Test;

/** 普通系统通知贴没贴出去(NoticeDelivery):跑法 cd mobile/android && ./gradlew :app:testDebugUnitTest --tests '*NoticeDeliveryTest' */
public class NoticeDeliveryTest {
    @Test
    public void postsOnlyInTheBackgroundWithNotificationsAndChannelOn() {
        assertTrue(NoticeDelivery.posts(false, true, NotificationManager.IMPORTANCE_DEFAULT));
        assertTrue(NoticeDelivery.posts(false, true, NotificationManager.IMPORTANCE_MIN)); // 最低档也进通知栏
        assertFalse("App 在前台:不贴", NoticeDelivery.posts(true, true, NotificationManager.IMPORTANCE_DEFAULT));
        assertFalse("通知整体被关 / 没给通知权限", NoticeDelivery.posts(false, false, NotificationManager.IMPORTANCE_DEFAULT));
        assertFalse("渠道被用户关了", NoticeDelivery.posts(false, true, NotificationManager.IMPORTANCE_NONE));
        assertFalse("读不到渠道", NoticeDelivery.posts(false, true, null));
    }
}
