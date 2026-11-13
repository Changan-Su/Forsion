package com.forsion.tangu;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 手机首次引导第 3 屏「想让 Forsion 帮你做哪些事」与 设置 › 设备权限 的原生半身:通知、麦克风两项系统权限的读 / 问 / 去系统设置。
 * (「操作这台手机」不是系统权限,在 PhoneControlPlugin 里。)
 *
 * - status():只读,从不弹框。
 * - ask():已允许就直接回;否则弹系统框,答完回和 status() 同样的形状。
 * - openSettings():被系统记成「不再询问」后唯一的回头路。
 *
 * 通知只问一次:这里真的弹出过通知权限框,就记一笔(notificationsAsked),LiveIslandPlugin.show() 见到这笔就不再在首次上岛时问 ——
 * 同一个系统框不弹两次。没在引导里问过的人,照旧在第一次上岛时问。
 *
 * 麦克风别名只放 RECORD_AUDIO:MODIFY_AUDIO_SETTINGS 是安装即得的普通权限,放进同一个别名会要求两项都「允许」才算允许。
 * 本文件不含用户可见字面量(文案全在 JS)。
 */
@CapacitorPlugin(
    name = "PhonePermissions",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class PhonePermissionsPlugin extends Plugin {
    private static final String PREFS = "forsion_phone_permissions";
    private static final String KEY_NOTIFICATIONS_ASKED = "notificationsAskedInstall";

    /**
     * 这次安装的身份(首次安装时间)。记「问过」时连它一起记:应用数据会随系统备份还原到新手机(allowBackup),
     * 而新手机上通知权限框一次都没弹过 —— 只记一个布尔的话,还原过来的那笔会让首次上岛也不问,岛就一直不出来。
     * 读不到返回 0 = 当没问过(照旧在首次上岛时问)。
     */
    private static long installStamp(Context ctx) {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).firstInstallTime;
        } catch (Exception e) {
            return 0L;
        }
    }

    /** 这次安装里,引导已经弹过通知权限框(持久,跨进程)。LiveIslandPlugin.show() 据此不再问第二次。 */
    public static boolean notificationsAsked(Context ctx) {
        long stamp = installStamp(ctx);
        return stamp != 0L && ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_NOTIFICATIONS_ASKED, 0L) == stamp;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(snapshot());
    }

    /** 入参 what:'notifications' | 'microphone'。 */
    @PluginMethod
    public void ask(PluginCall call) {
        String what = call.getString("what", "");
        if ("notifications".equals(what)) {
            // Android 13 以下通知没有运行时权限、也没有框可弹:只回现状,不记「问过」。
            if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
                call.resolve(snapshot());
                return;
            }
            // 只在真的发起系统请求时记(之后 LiveIsland 不再问);被系统记成「不再询问」时系统不弹框,也算问过 —— 再问也弹不出来。
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_NOTIFICATIONS_ASKED, installStamp(getContext())).apply();
            requestPermissionForAlias("notifications", call, "afterAsk");
            return;
        }
        if ("microphone".equals(what)) {
            if (getPermissionState("microphone") == PermissionState.GRANTED) {
                call.resolve(snapshot());
                return;
            }
            requestPermissionForAlias("microphone", call, "afterAsk");
            return;
        }
        call.reject("unknown_permission");
    }

    @PermissionCallback
    private void afterAsk(PluginCall call) {
        // 界面只认答完之后重读的状态,不认按了哪个钮
        call.resolve(snapshot());
    }

    /** 入参 what:'notifications' 打开本应用的通知设置页;'microphone' 打开本应用的详情页(权限在里面)。 */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String what = call.getString("what", "");
        String pkg = getContext().getPackageName();
        Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null));
        Intent intent = details;
        if ("notifications".equals(what)) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
        }
        try {
            getActivity().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            // 个别厂商系统没有通知设置页的入口:退到应用详情页,通知开关也在那里
            try {
                getActivity().startActivity(details);
            } catch (ActivityNotFoundException e2) {
                call.reject("no_settings_activity");
                return;
            }
        }
        call.resolve();
    }

    /**
     * { notifications, microphone: 'granted'|'prompt'|'denied', notificationsEnabled }。
     * Android 13 以下:通知没有运行时权限,按系统通知总开关报 granted / denied。
     * 13 起 notifications 只是运行时权限;用户在系统设置里关掉了本应用的通知(权限仍在)看 notificationsEnabled。
     */
    private JSObject snapshot() {
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        JSObject o = new JSObject();
        o.put("notifications", Build.VERSION.SDK_INT < 33 ? (enabled ? "granted" : "denied") : plain(getPermissionState("notifications")));
        o.put("microphone", plain(getPermissionState("microphone")));
        o.put("notificationsEnabled", enabled);
        return o;
    }

    /** 四态收成三态:「要先讲理由再问」对我们没有区别,都还能问。 */
    private static String plain(PermissionState s) {
        if (s == PermissionState.GRANTED) return "granted";
        if (s == PermissionState.DENIED) return "denied";
        return "prompt";
    }
}
