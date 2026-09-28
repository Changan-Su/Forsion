package com.forsion.tangu;

import java.io.IOException;
import java.net.CookieHandler;
import java.net.URI;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * 让身份面(UnitHttp)与中继(UnitRelay)的 HttpURLConnection 不碰进程全局的 cookie 罐(P1-K8,评审 P2)。
 *
 * 为什么需要:Capacitor 的 CapacitorCookies 插件在 load() 里**无条件** `CookieHandler.setDefault(CapacitorCookieManager)`
 * (不看 enabled),于是本进程里每个 HttpURLConnection 都会带上 WebView cookie 罐里 apiBase 主机的 cookie、并把响应的
 * Set-Cookie 存回去 —— 比如「打开设备界面」经 /units/session 种下的 HttpOnly forsion_unit_session(可能是上一个账号的 token)。
 * 中继「头从零重建」这条不变量在真机上就对 Cookie 失效了,JVM 单测(没有全局 CookieHandler)还照样绿。
 *
 * 做法:把全局 CookieHandler 包一层 {@link Guard};当前线程处在 {@link #enter()} / {@link #exit} 之间时 get 回空、put 丢弃,
 * 其余线程原样转给被包的那个(WebView、CapacitorHttp 照旧)。两种运行时都在**调用线程**上问 CookieHandler
 * (Android 的 OkHttp 分支在 networkRequest / receiveHeaders,JDK 在 setCookieHeader),且在 openConnection 时取默认值,
 * 所以「连之前确保装上 + 线程标记」是可靠的。
 */
final class NoCookieJar {
    private static final ThreadLocal<Boolean> ACTIVE = new ThreadLocal<>();

    private NoCookieJar() {
    }

    static final class Guard extends CookieHandler {
        final CookieHandler inner;

        Guard(CookieHandler inner) {
            this.inner = inner;
        }

        @Override
        public Map<String, List<String>> get(URI uri, Map<String, List<String>> requestHeaders) throws IOException {
            if (Boolean.TRUE.equals(ACTIVE.get()) || inner == null) return Collections.emptyMap();
            return inner.get(uri, requestHeaders);
        }

        @Override
        public void put(URI uri, Map<String, List<String>> responseHeaders) throws IOException {
            if (Boolean.TRUE.equals(ACTIVE.get()) || inner == null) return;
            inner.put(uri, responseHeaders);
        }
    }

    /** 全局 CookieHandler 必须是 Guard(别处后来又 setDefault 了就再包一层)。每次 openConnection 之前经 enter() 调到。 */
    static synchronized void ensureInstalled() {
        CookieHandler cur = CookieHandler.getDefault();
        if (!(cur instanceof Guard)) CookieHandler.setDefault(new Guard(cur));
    }

    /** 标记当前线程:接下来的连接不带、不存 cookie。返回之前的标记,交给 {@link #exit} 还原(可嵌套)。 */
    static boolean enter() {
        boolean prev = Boolean.TRUE.equals(ACTIVE.get());
        ACTIVE.set(Boolean.TRUE);
        ensureInstalled();
        return prev;
    }

    static void exit(boolean prev) {
        if (prev) ACTIVE.set(Boolean.TRUE);
        else ACTIVE.remove();
    }
}
