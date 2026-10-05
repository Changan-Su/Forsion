package com.forsion.tangu;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;

import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;

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

import java.util.concurrent.atomic.AtomicInteger;

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
 *
 * 2026-10-05 加两样:岛上待批审批的「拒绝 / 允许」按钮(addAnswers),和 App 在后台时的普通系统通知(notice)。
 */
@CapacitorPlugin(
    name = "LiveIsland",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class LiveIslandPlugin extends Plugin {
    static final int ID = 7201;
    private static final String CHANNEL = "agent_live";
    /** 普通系统通知(notice):每类事件一个 tag,共用这一个 id。 */
    private static final int EVENT_ID = 7202;
    /** 「已完成 / 运行出错 / 已停止」那条:自己一个 id,不借常驻那条的(原因见 post 的收尾分支)。 */
    private static final int DONE_ID = 7203;
    private static final String EVENTS = "events";
    private static final String ACTION_ANSWER = "com.forsion.tangu.island.ANSWER";

    private boolean askedPermission;
    /** 收尾 / 重置各记一笔。等通知权限回执的那一发若跨过了一笔,就是过期的:再贴会把已经结束的 run 的岛贴回来一直挂着。 */
    private final AtomicInteger epoch = new AtomicInteger();
    private volatile int askedAt;
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
    /**
     * 通知按钮(addAnswers)点下去落到这里,原样转给 JS(事件 answer);认不认、发不发由 JS 照当时的 store 判。
     * 动态注册 + 不导出:只有本应用自己的 PendingIntent 送得进来;页面不在了(Activity 销毁)也就没人能答,一并注销。
     */
    private final BroadcastReceiver answers = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Uri u = intent.getData();
            if (u == null) return;
            // 锁着的设备不认。按钮本身要求解锁(setAuthenticationRequired),但那一查是系统通知栏在点击时做的:
            // 有「通知使用权」的应用(手表的伴侣应用之类)能直接触发按钮背后的意图,绕过它。解锁状态下这类应用仍能触发 ——
            // 那是用户亲手授出的系统级权限(读全部通知、代点任何通知按钮),这里拦不住也不该假装拦得住。
            KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
            if (keyguard != null && keyguard.isDeviceLocked()) return;
            JSObject o = new JSObject();
            for (String key : new String[] { "sessionId", "messageId", "approvalId", "action" }) o.put(key, u.getQueryParameter(key));
            notifyListeners("answer", o);
        }
    };

    @Override
    public void load() {
        IntentFilter filter = new IntentFilter(ACTION_ANSWER);
        filter.addDataScheme("tangu");
        ContextCompat.registerReceiver(getContext(), answers, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        try { getContext().unregisterReceiver(answers); } catch (IllegalArgumentException e) { /* 没注册上 */ }
    }

    /** 回到前台:后台时贴的那些普通通知(notice)在应用内都有同一条,系统通知栏里的撤掉。 */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        NotificationManager nm = getContext().getSystemService(NotificationManager.class);
        for (StatusBarNotification s : nm.getActiveNotifications()) {
            if (s.getId() == EVENT_ID) nm.cancel(s.getTag(), EVENT_ID);
        }
    }

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
     * sessionId(点击跳回的会话)、sub(副标题)、channelName;done=true 收尾,quiet=true 收尾时直接撤掉不留「已完成」;
     * ask + allowLabel / denyLabel = 待批审批上的按钮(见 addAnswers)。
     */
    @PluginMethod
    public void show(PluginCall call) {
        // Android 13+ 通知是运行时权限:先贴后问 = 第一轮被系统静默丢掉。首次用到时问一次,答完再贴;
        // 拒了也照走 —— 前台服务照样保活 run,只是通知不显示。
        if (Build.VERSION.SDK_INT >= 33 && !askedPermission && getPermissionState("notifications") != PermissionState.GRANTED) {
            askedPermission = true;
            askedAt = epoch.get();
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        post(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        // 用户答权限框的这几秒里 run 已经结束(或页面重载过):这一发是旧的,不贴
        if (askedAt != epoch.get()) { call.resolve(); return; }
        post(call);
    }

    /**
     * 新的 JS 上下文(冷启 / WebView 重载 / Activity 重建)不认识之前贴的岛:常驻的那条一律撤掉、前台服务停掉。
     * run 若还在跑,store 连上后会原样再贴回来;「已完成」这类非常驻的留着。
     * 不撤的后果:退化路径(后台起不了前台服务时贴的普通常驻通知)在进程死后会一直挂着「正在执行…」。
     */
    @PluginMethod
    public void reset(PluginCall call) {
        epoch.incrementAndGet();
        LiveIslandService.finish(false);
        NotificationManager nm = getContext().getSystemService(NotificationManager.class);
        for (StatusBarNotification s : nm.getActiveNotifications()) {
            if (s.getId() == ID && (s.getNotification().flags & Notification.FLAG_ONGOING_EVENT) != 0) nm.cancel(ID);
        }
        call.resolve();
    }

    /**
     * 应用内通知的系统通知出口(JS:window.tangu.notify)。入参:title、text、tag(哪类事件,同类只留最新一条)、channelName。
     * 只在 App 不在前台时贴:页面那侧的「失焦」在原生半屏盖着时也成立,而那时用户正看着 App。点通知 = 回到 App。
     * ponytail: 通知权限只在第一次上岛(agent 开跑)时问,这里不问(后台问不了);没权限时系统自己丢掉。
     *   从不跑 agent 的用户因此收不到这类通知,真有人要,再在设置 → 通知里加一个去申请权限的入口。
     */
    @PluginMethod
    public void notice(PluginCall call) {
        call.resolve();
        String channelName = call.getString("channelName", "Forsion");
        String title = call.getString("title", "");
        String text = call.getString("text", "");
        String tag = call.getString("tag", "app");
        // 在主线程判前后台并贴:与 handleOnResume 的清理排在同一条线上,不会出现「刚判完在后台 → 回到前台清过了 → 这条才贴上」
        getActivity().runOnUiThread(() -> {
            if (getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) return;
            Context ctx = getContext();
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel(EVENTS, channelName, NotificationManager.IMPORTANCE_DEFAULT));
            Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            Notification.Builder b = new Notification.Builder(ctx, EVENTS)
                .setSmallIcon(R.drawable.ic_stat_forsion)
                .setContentTitle(title == null || title.isEmpty() ? "Forsion" : title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                // 自己一组:系统只把「没分组」的通知自动叠成一摞,这几条不进去,岛就不会被叠进组里(叠进去之后「拒绝 / 允许」要多点两下才看得到)
                .setGroup(EVENTS)
                .setAutoCancel(true);
            if (open != null) b.setContentIntent(PendingIntent.getActivity(ctx, 2, open, PendingIntent.FLAG_IMMUTABLE));
            nm.notify(tag, EVENT_ID, b.build());
        });
    }

    /**
     * 待批审批上的「拒绝 / 允许」。放不放、放哪个由 JS 定(liveIslandDerive.shadeAsk):入参 ask = { messageId, approvalId,
     * allow, detail },外加两个按钮的文案 denyLabel / allowLabel。
     *  - 两个按钮都要求设备已解锁(setAuthenticationRequired,API 31 才有;接收器那头另查一遍,见 answers)。
     *    更老的系统不放按钮:锁屏上谁都能点的「允许」不能有,那里照旧点通知进会话答。
     *  - 「允许」只在这次请求的内容(detail)能整段显示时才有:内容进 BigTextStyle —— 按钮只在通知展开时可见,
     *    展开态显示的正是全文,不会出现「看着半句就批了」。BigTextStyle 不影响上岛(Live Update 允许的样式之一)。
     *  - 每张审批、每个动作各自一个 PendingIntent(data 参与判等):同一条通知原地换成下一张审批时,
     *    旧按钮上的意图不会被悄悄改成答新的那张。
     */
    private static void addAnswers(Context ctx, Notification.Builder b, PluginCall call) {
        JSObject ask = call.getObject("ask");
        if (ask == null || Build.VERSION.SDK_INT < 31) return;
        String detail = ask.getString("detail");
        boolean allow = ask.getBoolean("allow", false) && detail != null && !detail.isEmpty();
        if (allow) b.setStyle(new Notification.BigTextStyle().bigText(call.getString("text", "") + "\n" + detail));
        addAnswer(ctx, b, call, ask, "reject", call.getString("denyLabel", ""));
        if (allow) addAnswer(ctx, b, call, ask, "approve", call.getString("allowLabel", ""));
    }

    private static void addAnswer(Context ctx, Notification.Builder b, PluginCall call, JSObject ask, String action, String label) {
        if (label == null || label.isEmpty()) return;
        Uri data = new Uri.Builder().scheme("tangu").authority("answer")
            .appendQueryParameter("sessionId", call.getString("sessionId", ""))
            .appendQueryParameter("messageId", ask.getString("messageId"))
            .appendQueryParameter("approvalId", ask.getString("approvalId"))
            .appendQueryParameter("action", action)
            .build();
        PendingIntent tap = PendingIntent.getBroadcast(ctx, 0, new Intent(ACTION_ANSWER, data).setPackage(ctx.getPackageName()), PendingIntent.FLAG_IMMUTABLE);
        b.addAction(new Notification.Action.Builder(null, label, tap).setAuthenticationRequired(true).build());
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
            // 收尾:常驻那条连同服务一起撤,完成态另用一个 id 贴。
            // 原先是「把通知从服务上摘下来(DETACH),再用同一 id 覆盖成完成态」。摘的时候系统会把服务手里那份旧通知
            // 异步再贴一遍,落在我们这一发之后就把「已完成」盖回「思考中…」,而且一直挂着 —— run 在后台结束时
            // API 35 模拟器 6 轮里 3 轮如此(台架 native-shell-emu.cjs 的 island 那条连跑 6 轮钉住)。两个 id 就没有先后可争。
            epoch.incrementAndGet();
            LiveIslandService.dismissed = false;
            LiveIslandService.finish(false);
            nm.cancel(ID); // 退化路径(没起成服务、贴的是普通常驻通知)没有服务替它撤
            if (!call.getBoolean("quiet", false)) nm.notify(DONE_ID, b.setAutoCancel(true).build());
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
        addAnswers(ctx, b, call);
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
            nm.cancel(DONE_ID); // 新一轮开跑:上一轮留下的完成态让位
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
