package com.forsion.tangu;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * 普通系统通知(LiveIslandPlugin.notice)的 tag:同一个 tag 只留最新一条。
 * 带 key(页面那条通知的 dedupeKey)的按「来源 + key」各占一条:有人在等的审批各有自己的键,不会被同一来源后来的普通通知顶掉。
 * 页面只给有人在等的(urgent)卡带 key(notificationStore 的 postOs),其余不带。不带 key 的按来源(event)一条,和以前一样。
 *
 * 格式(2026-11-16 起):不带 key = 来源;带 key = 来源 + '|' + ('k' + key,或 key 太长时 'h' + key 的 SHA-256 十六进制)。
 *  - 来源里的 '\' 与 '|' 转义成 "\\" 与 "\|":第一个没转义的 '|' 之前是来源、之后是 key 那段,不同的(来源, key)拼不成同一串。
 *  - 'k' / 'h' 把原样的 key 和摘要分开:短 key 恰好长得像某个摘要也不会撞。摘要按 UTF-16 码元算,孤立的代理字符也不会被并成同一个。
 *  - 以前长 key 用「长度 + 32 位哈希」,长度相同、String.hashCode 相同的两个 key(比如只差末尾 "Aa" / "BB")会拼成同一个 tag,
 *    后一条审批顶掉前一条。换格式只影响升级那一刻还挂在通知栏里的旧通知:它们不会被同 key 的新通知顶掉,回到前台时一起清掉
 *    (插件的 handleOnResume 按 id 清,不看 tag)。
 */
final class NoticeTag {
    static final int MAX_KEY = 160;

    private NoticeTag() {}

    static String of(String event, String key) {
        String source = escape(event == null || event.isEmpty() ? "app" : event);
        if (key == null || key.isEmpty()) return source;
        return source + "|" + (key.length() <= MAX_KEY ? "k" + key : "h" + sha256(key));
    }

    private static String escape(String s) {
        if (s.indexOf('\\') < 0 && s.indexOf('|') < 0) return s;
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' || c == '|') b.append('\\');
            b.append(c);
        }
        return b.toString();
    }

    private static String sha256(String s) {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // Java 与 Android 都必带 SHA-256
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            md.update((byte) (c >> 8));
            md.update((byte) c);
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte x : md.digest()) hex.append(Character.forDigit((x >> 4) & 0xF, 16)).append(Character.forDigit(x & 0xF, 16));
        return hex.toString();
    }
}
