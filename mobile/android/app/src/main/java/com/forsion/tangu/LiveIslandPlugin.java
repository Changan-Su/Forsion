package com.forsion.tangu;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 各家灵动岛(2026-09-18):agent 在跑时贴一条 **Android 16 Live Update**(「推广的常驻通知」)。
 *
 * 各家的岛都吃这同一份标准接口,不用逐家适配:
 *   Pixel(Android 16 QPR1+)状态栏胶囊 · 三星 One UI 8 Now Bar · OPPO/一加/realme ColorOS 16 流体云 ·
 *   小米/红米 HyperOS 3.1 超级岛(据报道,未实测) · vivo/iQOO OriginOS 6 原子岛。系统不支持时退化成普通常驻通知。
 * 小米另挂一层自家协议(xiaomiIsland):HyperOS 3.0 及更早只认它,但要过小米鉴权才上岛,见该方法注释。
 *
 * 能被系统「推广」上岛的硬条件(AOSP android16-qpr1 的 hasPromotableCharacteristics,缺一条就只是普通通知):
 * 请求推广 + ongoing + 有标题 + 无 Style / 自定义视图 + 不是组摘要 + **不能 colorized** + 渠道重要性高于 MIN。
 * 文案一律由 JS 传入(跟界面语言走),本文件不含任何用户可见字面量。
 */
@CapacitorPlugin(
    name = "LiveIsland",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class LiveIslandPlugin extends Plugin {
    static final int ID = 7201;
    private static final String CHANNEL = "agent_live";

    private boolean askedPermission;
    /** MainActivity 在插件装载前写入:本次是全新启动(不是重建)。 */
    static boolean freshLaunch;

    /**
     * 点岛 → `tangu://session?id=`。自己发 openSession 事件,不借 App 插件的 appUrlOpen:进程已死而任务还在时,
     * 系统用**原来的**启动 intent 重建 Activity、再经 onNewIntent 送来这条,那时 JS 还没挂监听,appUrlOpen 被暂存
     * 且只投给**第一个**挂上的监听(登录模块的,它忽略掉)—— 模拟器实测冷启点岛落在主页。自家事件只有我们一个监听,
     * 暂存的正好投给它。
     *
     * BridgeActivity 每次创建(含重建)都会把启动 intent 当 onNewIntent 回放一遍 —— 全新启动时这正是点岛那条;
     * 重建(配置变更 / 进程被杀后从最近任务回来)时那次回放是旧事,再跳一次会话就是凭空把用户拽走。
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (!freshLaunch && intent == getActivity().getIntent()) return;
        emitOpen(intent);
    }

    private void emitOpen(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u == null || !"tangu".equals(u.getScheme()) || !"session".equals(u.getHost())) return;
        String id = u.getQueryParameter("id");
        if (id == null || id.isEmpty()) return;
        JSObject o = new JSObject();
        o.put("id", id);
        notifyListeners("openSession", o, true);
    }

    /**
     * 贴 / 更新 / 收尾同一条岛。入参:title、text、chip(状态栏胶囊短字,空=显示计时器)、since(run 起点,毫秒)、
     * sessionId(点击跳回的会话)、sub(副标题)、channelName;done=true 收尾,quiet=true 收尾时直接撤掉不留「已完成」。
     */
    @PluginMethod
    public void show(PluginCall call) {
        // Android 13+ 通知是运行时权限:先贴后问 = 第一轮被系统静默丢掉。首次用到时问一次,答完再贴;
        // 拒了也照走 —— 前台服务照样保活 run,只是通知不显示。
        if (Build.VERSION.SDK_INT >= 33 && !askedPermission && getPermissionState("notifications") != PermissionState.GRANTED) {
            askedPermission = true;
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        post(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        post(call);
    }

    /**
     * 新的 JS 上下文(冷启 / WebView 重载 / Activity 重建)不认识之前贴的岛:常驻的那条一律撤掉、前台服务停掉。
     * run 若还在跑,store 连上后会原样再贴回来;「已完成」这类非常驻的留着。
     * 不撤的后果:退化路径(后台起不了前台服务时贴的普通常驻通知)在进程死后会一直挂着「正在执行…」。
     */
    @PluginMethod
    public void reset(PluginCall call) {
        LiveIslandService.finish(false);
        NotificationManager nm = getContext().getSystemService(NotificationManager.class);
        for (StatusBarNotification s : nm.getActiveNotifications()) {
            if (s.getId() == ID && (s.getNotification().flags & Notification.FLAG_ONGOING_EVENT) != 0) nm.cancel(ID);
        }
        call.resolve();
    }

    /**
     * 只读诊断:这台机器上岛能不能上、卡在哪(scripts/live-island-emu.cjs 里调)。各家行为只能真机看,
     * 16 的接口用反射调(compileSdk 仍是 35);小米的 canShowFocus 会校验「被查的包属于调用方」,只能在 app 内问。
     */
    @PluginMethod
    public void probe(PluginCall call) {
        Context ctx = getContext();
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        JSObject r = new JSObject();
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("notificationsEnabled", nm.areNotificationsEnabled());
        try { r.put("canPostPromoted", nm.getClass().getMethod("canPostPromotedNotifications").invoke(nm)); } catch (Exception e) { r.put("canPostPromoted", "n/a: " + e.getClass().getSimpleName()); }
        for (StatusBarNotification s : nm.getActiveNotifications()) {
            if (s.getId() != ID) continue;
            Notification n = s.getNotification();
            r.put("flags", Integer.toHexString(n.flags));
            r.put("promoted", (n.flags & 0x00040000) != 0); // Notification.FLAG_PROMOTED_ONGOING(API 36)
            try { r.put("promotable", n.getClass().getMethod("hasPromotableCharacteristics").invoke(n)); } catch (Exception e) { r.put("promotable", "n/a: " + e.getClass().getSimpleName()); }
        }
        r.put("focusProtocol", android.provider.Settings.System.getInt(ctx.getContentResolver(), "notification_focus_protocol", 0));
        try {
            Bundle in = new Bundle();
            in.putString("package", ctx.getPackageName());
            Bundle out = ctx.getContentResolver().call(Uri.parse("content://miui.statusbar.notification.public"), "canShowFocus", null, in);
            r.put("canShowFocus", out == null ? null : out.getBoolean("canShowFocus"));
        } catch (Exception e) {
            r.put("canShowFocus", "n/a: " + e.getClass().getSimpleName());
        }
        call.resolve(r);
    }

    private void post(PluginCall call) {
        Context ctx = getContext();
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        // 同 id 重建只会更新显示名(随界面语言),不会动用户改过的渠道设置。LOW:更新不响不震;MIN 会失去上岛资格。
        NotificationChannel ch = new NotificationChannel(CHANNEL, call.getString("channelName", "Agent"), NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);

        boolean done = call.getBoolean("done", false);
        String title = call.getString("title", "");
        Notification.Builder b = new Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_forsion)
            .setContentTitle(title == null || title.isEmpty() ? "Forsion" : title) // 没标题就不会被推广
            .setContentText(call.getString("text", ""))
            .setSubText(call.getString("sub"))
            .setContentIntent(openSession(ctx, call.getString("sessionId", "")))
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_PROGRESS);

        if (done) {
            boolean quiet = call.getBoolean("quiet", false);
            LiveIslandService.dismissed = false;
            LiveIslandService.finish(!quiet); // 先把通知从服务上摘下来,再用同一 id 覆盖成完成态(反过来会被 REMOVE 连带撤掉)
            if (quiet) nm.cancel(ID);
            else nm.notify(ID, b.setAutoCancel(true).build());
            call.resolve();
            return;
        }

        Bundle live = new Bundle();
        // ponytail: 用原始 extras 键请求推广(与 android.app.Notification 的常量同名同值,平台直接从 extras 读),
        //   免得为两个 setter 升 compileSdk 36 / androidx.core 1.17;哪天升了再换成 NotificationCompat 的 setter。
        live.putBoolean("android.requestPromotedOngoing", true);
        String chip = call.getString("chip", "");
        if (chip != null && !chip.isEmpty()) live.putString("android.shortCriticalText", chip); // 不设 = 胶囊里显示计时器
        long since = call.getLong("since", System.currentTimeMillis());
        int focus = android.provider.Settings.System.getInt(ctx.getContentResolver(), "notification_focus_protocol", 0);
        if (focus > 0) xiaomiIsland(ctx, live, focus, title, call.getString("text", ""), chip == null ? "" : chip, since);
        // Android 12+ 默认把前台服务的通知压后最多 10s 才显示(刚装好的首轮实测:开跑 5s 仍不在通知列表里),岛要开跑即现。
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        Notification n = b.setOngoing(true)
            .setWhen(since)
            .setShowWhen(true)
            .setUsesChronometer(true)
            // 刻意不挂不定进度条:折叠态里它会顶掉正文,「等你批准:bash」就看不见了(API 35 实测);在跑的信号靠计时器。
            .setDeleteIntent(PendingIntent.getService(ctx, 1,
                new Intent(ctx, LiveIslandService.class).setAction(LiveIslandService.ACTION_DISMISSED),
                PendingIntent.FLAG_IMMUTABLE))
            .addExtras(live)
            .build();

        if (LiveIslandService.instance != null) {
            if (!LiveIslandService.dismissed) nm.notify(ID, n); // 更新前台服务的通知 = 同 id notify
        } else {
            LiveIslandService.dismissed = false;
            LiveIslandService.pending = n;
            try {
                ctx.startForegroundService(new Intent(ctx, LiveIslandService.class));
            } catch (Exception e) {
                // 后台起前台服务被拒(Android 12+;run 在 app 退后台后才冒出来的少数情况):退化为普通常驻通知,
                // 照样能上岛,只是不保活。
                nm.notify(ID, n);
            }
        }
        call.resolve();
    }

    /**
     * 小米超级岛(澎湃 OS 自家的焦点通知协议)。3.0 的超级岛不吃 Android 16 标准接口(真机实测:小米 14 Pro、
     * OS3.0.4.0 国行、Android 16 首发版底子 BP2A.250605,canPostPromotedNotifications=false),只认 `miui.focus.param`。
     * 字段照开源库 HyperIsland-ToolKit 的模型:左侧图标 + 文字,右侧正计时;要你动手时文字换成短字并主动弹开一次。
     * ⚠️ 同机实测:SystemUI 的 FocusPlugin 能渲染这份参数(onInflateSuccess),但 AuthManager 鉴权返回 -200 → onAuthFailed,
     *    不上岛、退回普通通知。canShowFocus=true 只是用户侧开关,不等于授权。要生效得在小米开发者平台建应用、过超级岛场景审核,
     *    把拿到的 APP_ID 写进 manifest 的 `com.xiaomi.xms.APP_ID` meta-data。没授权时这层参数无害(照常显示为普通通知)。
     */
    private static void xiaomiIsland(Context ctx, Bundle extras, int protocol, String title, String text, String chip, long since) {
        try {
            JSONObject pic = new JSONObject().put("type", 1).put("pic", "miui.focus.pic_forsion");
            JSONObject timer = new JSONObject().put("timerType", 1).put("timerWhen", since).put("timerTotal", since).put("timerSystemCurrent", since);
            JSONObject island = new JSONObject()
                .put("islandProperty", 1)
                .put("bigIslandArea", new JSONObject()
                    .put("imageTextInfoLeft", new JSONObject().put("type", 1).put("picInfo", pic)
                        .put("textInfo", new JSONObject().put("title", chip.isEmpty() ? text : chip)))
                    .put("sameWidthDigitInfo", new JSONObject().put("timerInfo", timer)))
                .put("smallIslandArea", new JSONObject().put("picInfo", pic));
            JSONObject v2 = new JSONObject()
                .put("protocol", protocol)
                .put("business", "agent")
                .put("updatable", true)
                .put("enableFloat", !chip.isEmpty()) // 等你批准时弹开一次提醒;平常更新不打扰
                .put("islandFirstFloat", false)
                .put("ticker", text)
                .put("aodTitle", title)
                .put("baseInfo", new JSONObject().put("type", 2).put("title", title).put("content", text))
                .put("param_island", island);
            Bundle pics = new Bundle();
            pics.putParcelable("miui.focus.pic_forsion", Icon.createWithResource(ctx, R.drawable.ic_stat_forsion));
            extras.putBundle("miui.focus.pics", pics);
            extras.putString("miui.focus.param", new JSONObject().put("param_v2", v2).toString());
        } catch (JSONException e) {
            // 只是少了小米那层装饰,标准通知照贴
        }
    }

    /** 点岛 = 回到那个会话。显式 Intent 直指 MainActivity(同 SpaceShortcutsPlugin,不用动 intent-filter),见 emitOpen。 */
    private static PendingIntent openSession(Context ctx, String sessionId) {
        Intent i = new Intent(ctx, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse("tangu://session?id=" + Uri.encode(sessionId == null ? "" : sessionId)))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
