package com.forsion.tangu;

/**
 * 普通系统通知(LiveIslandPlugin.notice)的 tag:同一个 tag 只留最新一条。
 * 带 key(页面那条通知的 dedupeKey)的按「来源 + key」各占一条:有人在等的审批各有自己的键,不会被同一来源后来的普通通知顶掉;
 * 共用一个键的(手机上几件合成的那一张)仍是一条。不带 key 的按来源(event)一条,和以前一样。
 * key 是插件给的串,太长时换成长度 + 哈希,不让一条 tag 无限长。
 */
final class NoticeTag {
    static final int MAX_KEY = 160;

    private NoticeTag() {}

    static String of(String event, String key) {
        String source = event == null || event.isEmpty() ? "app" : event;
        if (key == null || key.isEmpty()) return source;
        String k = key.length() <= MAX_KEY ? key : key.length() + "#" + Integer.toHexString(key.hashCode());
        // 来源 id(NOTIFY_EVENTS 的 id、plugin:<id>)里没有 '|',不会和「没有 key 的另一个来源」撞上
        return source + "|" + k;
    }
}
