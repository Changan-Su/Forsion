package com.forsion.tangu.localengine;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import com.forsion.tangu.R;

/**
 * Keeps the app in the foreground-service tier while the local engine runs. Without it, Doze cut the app's network
 * (loopback included) about 2 minutes after the screen went off, although the processes stayed alive (probe 5a);
 * with it, 10 minutes and a forced deep idle stayed reachable (5b). Type specialUse: an on-device agent engine fits
 * none of the predefined types (dataSync is capped at 6 h a day on Android 15).
 *
 * The notification cannot be swiped away while the engine runs, and carries Stop.
 */
public class LocalEngineService extends Service {
    private static final String TAG = "LocalEngine";
    static final String CHANNEL = "local_engine";
    static final int ID = 0x10CA1;
    static final String ACTION_STOP = "com.forsion.tangu.localengine.STOP";
    static final String PREFS = "forsion_local_engine";

    static void start(Context c) {
        Intent i = new Intent(c, LocalEngineService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (RuntimeException e) {
            // e.g. started from the background on Android 12+: the engine still runs, only without the keep-alive tier
            Log.w(TAG, "foreground service not started: " + e);
        }
    }

    static void stop(Context c) {
        try { c.stopService(new Intent(c, LocalEngineService.class)); } catch (RuntimeException ignored) {}
    }

    /** Texts in the page's current language (ForsionLocalEngine.configure); resources are the system-language fallback. */
    static void saveStrings(Context c, String channel, String title, String text, String stop) {
        SharedPreferences.Editor e = c.getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        if (channel != null) e.putString("channel", channel);
        if (title != null) e.putString("title", title);
        if (text != null) e.putString("text", text);
        if (stop != null) e.putString("stop", stop);
        e.apply();
    }

    private String str(String key, int res) {
        String v = getSharedPreferences(PREFS, MODE_PRIVATE).getString(key, null);
        return v == null || v.isEmpty() ? getString(res) : v;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            // Stop from the notification: stop the engine off the main thread (it waits up to ~6 s for a clean exit)
            new Thread(() -> LocalEngine.get(getApplicationContext()).stopEngine("notification"), "local-engine-stop").start();
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, str("channel", R.string.local_engine_channel), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent stop = new Intent(this, LocalEngineService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = open == null ? null : PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_forsion)
                .setContentTitle(str("title", R.string.local_engine_running))
                .setContentText(str("text", R.string.local_engine_running_text))
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, str("stop", R.string.local_engine_stop), stopPi).build());
        if (openPi != null) b.setContentIntent(openPi);
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(ID, b.build());
        } catch (RuntimeException e) {
            Log.w(TAG, "startForeground failed: " + e);
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
