package com.forsion.tangu;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 灵动岛的保活半身(2026-09-18)。只做一件事:agent 跑着的时候把进程钉在前台服务档,通知本体见 LiveIslandPlugin。
 *
 * 为什么非有不可:岛的价值全在「app 退到后台之后」。而后台进程在 Android 14+ 进 cached 档十来秒就被冻结
 * (小米/OPPO/vivo 自家的冻结器更快),Doze 下非前台服务进程还直接断网 —— 冻住了 SSE 就停了:岛上的计时器
 * 由系统渲染照走不误,「待审批」「已完成」却永远推不上去 = 一个会骗人的岛。(Capacitor 的 KeepRunning=true
 * 只管 WebView 的 JS 定时器,管不了进程冻结。)前台服务档不被冻、Doze 也放行网络;顺带进程死了系统会一并
 * 收走它的通知,不会留下一个过期的岛。
 *
 * 类型 dataSync(与云端之间收 run 事件)。Android 15 起它**每 24h 累计**限 6h(所有 run 加起来,不是每个 run),
 * 到点走 onTimeout 自停;当天余下的 run 起不了前台服务,插件退化为普通常驻通知(照样上岛,只是不保活)。
 */
public class LiveIslandService extends Service {
    static final String ACTION_DISMISSED = "com.forsion.tangu.island.DISMISSED";

    /** 前台服务通知的载荷:插件先放进来再起服务,onStartCommand 取用。 */
    static volatile Notification pending;
    /** 已经在前台档 = 插件改走 notify() 更新同一条通知。 */
    static volatile LiveIslandService instance;
    /** 用户把岛划掉了:本轮 run 内不再贴回去(Live Updates 规范:被划掉的别反复重贴)。新一轮 run 清零。 */
    static volatile boolean dismissed;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_DISMISSED.equals(intent.getAction())) {
            dismissed = true;
            if (instance == null) stopSelf(startId); // 服务已停时被划掉的回执:别为一个标记把服务留着
            return START_NOT_STICKY;
        }
        // 经 startForegroundService 起的必须立刻 startForeground,否则系统直接判崩。
        // ponytail: 插件两次调用至少隔 1s(JS 侧节流),stop 抢在这里之前的竞态实际碰不到;真碰到了最多多挂一条岛到下一轮。
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(LiveIslandPlugin.ID, pending, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(LiveIslandPlugin.ID, pending);
        }
        instance = this;
        return START_NOT_STICKY;
    }

    /** 收尾。keepNotification=true:通知脱离服务留下来(插件随后用同一 id 覆盖成「已完成」);false:连通知一起撤。 */
    static void finish(boolean keepNotification) {
        LiveIslandService s = instance;
        instance = null;
        if (s == null) return;
        s.stopForeground(keepNotification ? STOP_FOREGROUND_DETACH : STOP_FOREGROUND_REMOVE);
        s.stopSelf();
    }

    /** Android 15:dataSync 用满当日额度。必须几秒内自停,否则系统判崩。 */
    @Override
    public void onTimeout(int startId, int fgsType) {
        finish(true);
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
