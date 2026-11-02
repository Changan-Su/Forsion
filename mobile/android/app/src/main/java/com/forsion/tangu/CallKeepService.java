package com.forsion.tangu;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 语音通话的保活半身(2026-11-02):通话期间把进程钉在 microphone 类型的前台服务档,通知本体由 CallKeepPlugin 组好塞进来。
 *
 * 为什么非有不可:Android 9+ 会把后台应用的麦克风静音(录到的全是 0),11+ 起只有「使用期间」授出的麦克风权限,
 * 离开前台就失效 —— 唯一的例外是**在前台时**起好的 microphone 类型前台服务。没有它,通话一切走就成了对面听不见、
 * 时长照计,所以页面以前是离开前台就挂断(realtimeCall.ts 的 CALL_ENDED_BACKGROUND)。
 * 冻结 / Doze 断网同灵动岛(LiveIslandService 顶部注释):前台服务档一并免掉。
 *
 * microphone 类型没有 dataSync 那种每日 6h 限额;但 14+ 只能在前台时起,所以 JS 在拿到麦克风后(用户刚点通话)当场起。
 *
 * 起服务是两步(startForegroundService 排队 → onStartCommand 里真正 startForeground),所以:
 *  - 插件的 start 等这里回执(onStarted)才告诉 JS 成没成,提升失败 JS 照旧离开前台即挂断;
 *  - wanted 是「还要不要」:排队期间就被 stop 了(秒挂 / 页面没了),轮到这里时就地撤掉,不留僵尸通知。
 */
public class CallKeepService extends Service {
    static final String ACTION_HANGUP = "com.forsion.tangu.call.HANGUP";
    static volatile Notification pending;
    static volatile CallKeepService instance;
    /** 通知上的「挂断」:服务先自己停,再由插件转给 JS 收尾通话。 */
    static volatile Runnable onHangup;
    static volatile boolean wanted;
    /** 本次 start 的结果回执(插件挂上,这里调一次)。 */
    static volatile java.util.function.Consumer<Boolean> onStarted;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_HANGUP.equals(intent.getAction())) {
            // 先撤服务再告诉页面:页面没了 / 正在重载时按钮照样把通知撤掉。
            finish();
            stopSelf(startId);
            Runnable h = onHangup;
            if (h != null) h.run();
            return START_NOT_STICKY;
        }
        // 经 startForegroundService 起的必须立刻 startForeground,否则系统直接判崩。
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(CallKeepPlugin.ID, pending, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(CallKeepPlugin.ID, pending);
            }
        } catch (RuntimeException e) {
            // 14+:起服务的那一刻已不在前台 / 麦克风权限刚被收回 → SecurityException。别带崩进程,回执失败。
            stopSelf(startId);
            reply(false);
            return START_NOT_STICKY;
        }
        if (!wanted) { // 排队期间已被 stop:前台契约已满足,就地撤
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
            reply(false);
            return START_NOT_STICKY;
        }
        instance = this;
        reply(true);
        return START_NOT_STICKY;
    }

    static void reply(boolean ok) {
        java.util.function.Consumer<Boolean> r = onStarted;
        onStarted = null;
        if (r != null) r.accept(ok);
    }

    static void finish() {
        wanted = false;
        reply(false);
        CallKeepService s = instance;
        instance = null;
        if (s == null) return;
        s.stopForeground(STOP_FOREGROUND_REMOVE);
        s.stopSelf();
    }

    /** 从最近任务里划掉:WebView 随 Activity 一起没了,通话已死,别留一个「通话中」的服务。 */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        finish();
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
