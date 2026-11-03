package com.forsion.tangu;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 语音通话切到后台接着打(2026-11-02):start 起 CallKeepService(microphone 前台服务)+「通话中」常驻通知,stop 撤掉。
 * 页面侧 mobile/src/callKeep.ts → realtimeCall.ts 的 setCallKeepHost。文案一律由 JS 传入,本文件不含用户可见字面量。
 *
 * start 返回 ok=false(没麦克风权限 / 不在前台起不了服务)时,页面照旧「离开前台即挂断」。
 */
@CapacitorPlugin(name = "CallKeep")
public class CallKeepPlugin extends Plugin {
    static final int ID = 7301;
    private static final String CHANNEL = "voice_call";

    @Override
    public void load() {
        CallKeepService.onHangup = () -> notifyListeners("hangup", new JSObject());
    }

    /** 页面没了(Activity 销毁 / 重载前)通话也就没了:服务一并撤,不留假的「通话中」。 */
    @Override
    protected void handleOnDestroy() {
        CallKeepService.onHangup = null;
        CallKeepService.finish();
    }

    /** 入参:title、text、hangup(按钮字)、channelName。 */
    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        JSObject r = new JSObject();
        // 14+ 没授麦克风就起 microphone 前台服务 = 服务里 SecurityException 崩进程。页面是拿到麦克风后才调的,这里只是兜底。
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.resolve(r.put("ok", false));
            return;
        }
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, call.getString("channelName", "Voice call"), NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);

        Intent open = new Intent(ctx, AppActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent hangup = PendingIntent.getService(ctx, 0,
            new Intent(ctx, CallKeepService.class).setAction(CallKeepService.ACTION_HANGUP), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = new Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_forsion)
            .setContentTitle(call.getString("title", "Forsion"))
            .setContentText(call.getString("text", ""))
            .setContentIntent(PendingIntent.getActivity(ctx, 3, open, PendingIntent.FLAG_IMMUTABLE))
            .addAction(new Notification.Action.Builder(Icon.createWithResource(ctx, R.drawable.ic_stat_forsion), call.getString("hangup", "Hang up"), hangup).build())
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        Notification n = b.build();

        CallKeepService.wanted = true;
        if (CallKeepService.instance != null) {
            nm.notify(ID, n); // 新通话顶掉旧通话:服务还在,换通知
            call.resolve(r.put("ok", true));
            return;
        }
        CallKeepService.pending = n;
        // 等服务真正提升到前台档再回(见 CallKeepService 顶部);上一发没回执的作废(回 false,别让它的 promise 悬着)。
        CallKeepService.reply(false);
        CallKeepService.onStarted = (ok) -> call.resolve(new JSObject().put("ok", ok));
        try {
            ctx.startForegroundService(new Intent(ctx, CallKeepService.class));
        } catch (Exception e) {
            CallKeepService.onStarted = null;
            CallKeepService.wanted = false;
            call.resolve(r.put("ok", false)); // 12+ 后台起前台服务被拒:页面退回「离开前台即挂断」
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        CallKeepService.finish();
        call.resolve();
    }
}
