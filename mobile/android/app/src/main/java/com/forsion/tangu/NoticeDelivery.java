package com.forsion.tangu;

import android.app.NotificationManager;

/**
 * 普通系统通知(LiveIslandPlugin.notice)这一条真贴出去了没有,原样回给页面(`{ posted }`)。页面(notificationStore)据此判那张卡
 * 还欠不欠系统通知:没贴出去的一直欠着,回到前台时不丢(以前桥一律先回成功,没权限 / 渠道关了的卡回来时会被同来源后来的顶掉)。
 * 不贴:App 在前台(页面那侧的「失焦」在原生半屏盖着时也成立,而那时用户正看着 App)、通知整体被关(含 13+ 没给通知权限)、
 * 这个渠道被用户关了(重要性 NONE)、读不到渠道。
 */
final class NoticeDelivery {
    private NoticeDelivery() {}

    static boolean posts(boolean appInForeground, boolean notificationsEnabled, Integer channelImportance) {
        return !appInForeground && notificationsEnabled && channelImportance != null
            && channelImportance != NotificationManager.IMPORTANCE_NONE;
    }
}
