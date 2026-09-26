package com.forsion.tangu;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.os.RemoteException;
import android.provider.Settings;
import android.util.Log;

import com.forsion.tangu.hands.IHands;
import com.forsion.tangu.hands.IHandsListener;

import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 主包对伴随包(com.forsion.tangu.hands)的客户端(手机操控 T2,契约 §9.1)。
 *
 * 职责:判 hands 状态(装没装 / 签名 / 无障碍 / proto)、懒绑定 bridge、转交 T2 指令、拉截图字节、
 * 收急停回调后用主包自持 token 直接 abort(不依赖 JS 活着)。
 *
 * ⚠️ 绑定前先 checkSignatures(主包, hands):签名不符绝不绑(否则等于把 T2 指令喂给冒名伴随包)。
 * ⚠️ token / apiBase 仍由主包 NativeConfig 自取;伴随包永不联网、永不见 token。
 * ⚠️ 租约是伴随包进程内状态、跨 run 延续:登出 / 换号(CapacitorStorage 的 forsion_token 变了)与关开关时必须撤掉,
 *    否则另一个账号 10 分钟内的 run 会沿用这份同意、跳过浮层(09-26 评审)。两道:
 *    ① 撤销没绑上时不丢:记账(PendingCancel),绑上后**公开 binder 之前**先还,每次转交指令前也先还(二轮评审 P1);
 *    ② 每条 lease / run 都带账号键(PhoneVerbs.leaseKey,token 摘要,不是 token),伴随包的租约认它 —— 就算 ① 的那发
 *       因为 HandsClient 还没建(tokenWatch 没挂上)而根本没发出,换了账号的第一条 T2 op 也一定重新弹同意。
 */
final class HandsClient {
    private static final String TAG = "PhoneControl";
    static final String HANDS_PKG = "com.forsion.tangu.hands";
    private static final String BRIDGE = HANDS_PKG + ".HandsBridgeService";
    private static final String A11Y_COMPONENT = HANDS_PKG + "/" + HANDS_PKG + ".HandsAccessibilityService";

    /** 与 §6 status.hands 的取值一一对应。 */
    enum State { MISSING, SIGNATURE_MISMATCH, DISABLED, PROTO_MISMATCH, READY }

    private final Context ctx;
    private volatile IHands binder;
    private volatile Integer cachedProto;
    private volatile String configureJson; // 最近一次 T2 文案(绑定成功后补推)
    /**
     * 最近一条驱动手机的 run(急停 abort 用)。claim 成功即记,**不随单条 op 清掉**:用户多半在两步之间(模型思考时)点停止,
     * 按「只在 op 执行中才有」的旧口径那时拿不到 run、abort 根本不发(09-26 评审 P1)。对已结束的 run 发 abort 无害。
     */
    private volatile String driverRunId;
    private CountDownLatch bindLatch;
    /** 欠伴随包的 cancelAll(没绑上时记账,绑上 / 转交前先还)。 */
    private final PhoneVerbs.PendingCancel pendingCancel = new PhoneVerbs.PendingCancel();

    /** ⚠️ 必须强引用持有:SharedPreferences 只弱引用监听器,局部 lambda 会被 GC 掉、从此不再回调。 */
    private final SharedPreferences.OnSharedPreferenceChangeListener tokenWatch = (prefs, key) -> {
        if (key == null || NativeConfig.TOKEN_KEY.equals(key)) {
            new Thread(this::cancelAll, "hands-cancel").start(); // 回调在主线程,binder 调用挪出去
        }
    };

    HandsClient(Context context) {
        this.ctx = context.getApplicationContext();
        // 登出(Preferences.remove)/ 换号 / 启动续期换新 token 都会写这个键 → 撤租约(下一条 T2 op 重新征得同意)。
        ctx.getSharedPreferences(NativeConfig.PREFS_GROUP, Context.MODE_PRIVATE)
            .registerOnSharedPreferenceChangeListener(tokenWatch);
    }

    // ───────────────────────────── 状态判定(§9.1) ─────────────────────────────

    /** 判定顺序即契约 §6:没装 → 签名不符 → 无障碍没开 → proto 不一致 → 就绪。 */
    State state() {
        if (!installed()) return State.MISSING;
        if (!signatureMatches()) return State.SIGNATURE_MISMATCH;
        if (!a11yEnabled()) return State.DISABLED;
        Integer proto = ensureProto();
        if (proto == null) return State.DISABLED; // 装了、无障碍开了,但 bridge 连不上 = 当前不可用
        if (proto != PhoneControlPlugin.PROTO) return State.PROTO_MISMATCH;
        return State.READY;
    }

    static String stateName(State s) {
        switch (s) {
            case MISSING: return "missing";
            case SIGNATURE_MISMATCH: return "signature_mismatch";
            case DISABLED: return "disabled";
            case PROTO_MISMATCH: return "proto_mismatch";
            default: return "ready";
        }
    }

    private boolean installed() {
        try {
            ctx.getPackageManager().getPackageInfo(HANDS_PKG, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private boolean signatureMatches() {
        return ctx.getPackageManager().checkSignatures(ctx.getPackageName(), HANDS_PKG) == PackageManager.SIGNATURE_MATCH;
    }

    private boolean a11yEnabled() {
        try {
            if (Settings.Secure.getInt(ctx.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) {
                return false;
            }
            String enabled = Settings.Secure.getString(ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (enabled == null) return false;
            for (String part : enabled.split(":")) {
                if (part.equalsIgnoreCase(A11Y_COMPONENT)) return true;
            }
            return false;
        } catch (RuntimeException e) {
            return false;
        }
    }

    // ───────────────────────────── 绑定 ─────────────────────────────

    private final ServiceConnection conn = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            IHands b = IHands.Stub.asInterface(service);
            cachedProto = null;
            try {
                b.registerListener(listener);
                if (configureJson != null) b.configure(configureJson);
            } catch (RemoteException e) {
                Log.w(TAG, "[hands] register/configure on connect failed");
            }
            // ⚠️ 欠着的 cancelAll 先还,**再**公开 binder:ensureBound 见 binder 非空就放行 exec,先公开就有指令抢在撤租约前面。
            //    还不上 → 不公开(exec 一律回 null = error),等下次重连再还。
            if (pendingCancel.settle(() -> sendCancel(b))) {
                binder = b;
            } else {
                Log.w(TAG, "[hands] pending cancelAll failed on connect; bridge withheld");
                dropBinder(); // 解绑,下次 ensureBound 重新绑、重新还
            }
            CountDownLatch l = bindLatch;
            if (l != null) l.countDown();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            binder = null;
            cachedProto = null;
        }
    };

    private final IHandsListener listener = new IHandsListener.Stub() {
        @Override
        public void onStop() {
            String run = driverRunId;
            driverRunId = null;
            if (run != null) abortRun(run);
        }
    };

    /** 懒绑定,最多等 timeoutMs。签名不符绝不绑。 */
    private boolean ensureBound(long timeoutMs) {
        if (binder != null) return true;
        if (!installed() || !signatureMatches()) return false;
        synchronized (this) {
            if (binder != null) return true;
            bindLatch = new CountDownLatch(1);
            try {
                Intent i = new Intent().setComponent(new ComponentName(HANDS_PKG, BRIDGE));
                boolean requested = ctx.bindService(i, conn, Context.BIND_AUTO_CREATE);
                if (!requested) {
                    try { ctx.unbindService(conn); } catch (RuntimeException ignored) { /* not bound */ }
                    return false;
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "[hands] bind failed: " + e.getClass().getSimpleName());
                return false;
            }
        }
        try {
            bindLatch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return binder != null;
    }

    private Integer ensureProto() {
        Integer p = cachedProto;
        if (p != null) return p;
        if (!ensureBound(1500)) return null;
        IHands b = binder;
        if (b == null) return null;
        if (!pendingCancel.settle(() -> sendCancel(b))) { // 报 READY 之前先把欠的撤销还上
            dropBinder();
            return null;
        }
        try {
            JSONObject st = new JSONObject(b.status());
            int proto = st.optInt("proto", -1);
            cachedProto = proto;
            return proto;
        } catch (Exception e) {
            return null;
        }
    }

    // ───────────────────────────── 转交指令 ─────────────────────────────

    /** 转交一条 exec(lease / run / start)。绑不上 / binder 死 → null(调用方回 error)。 */
    String exec(String json) {
        if (!ensureBound(2000)) return null;
        IHands b = binder;
        if (b == null) return null;
        if (!pendingCancel.settle(() -> sendCancel(b))) { // 转交任何指令之前,欠的撤销先还;还不上就不转交
            dropBinder();
            return null;
        }
        try {
            return b.exec(json);
        } catch (RemoteException e) {
            Log.w(TAG, "[hands] exec RemoteException: " + e.getClass().getSimpleName());
            dropBinder();
            return null;
        }
    }

    /**
     * binder 不能用了:清掉并**解绑**。⚠️ 只置 null 不解绑的话,连接其实还挂着,下次 bindService(同一个 conn)不会再回调
     * onServiceConnected,ensureBound 每次干等到超时 —— T2 从此一直不可用。解绑后伴随包的 bridge 随之销毁,租约一并没了(fail closed)。
     */
    private void dropBinder() {
        binder = null;
        cachedProto = null;
        try {
            ctx.unbindService(conn);
        } catch (RuntimeException ignored) {
            // 没绑着
        }
    }

    private static boolean sendCancel(IHands b) {
        try {
            b.cancelAll();
            return true;
        } catch (RemoteException e) {
            Log.w(TAG, "[hands] cancelAll failed");
            return false;
        }
    }

    /** 拉 observe 时截好的图字节(经管道);token 对不上 / 无图 → null。 */
    byte[] readImage(String token) {
        IHands b = binder;
        if (b == null) return null;
        try {
            JSONObject o = new JSONObject();
            o.put("token", token);
            ParcelFileDescriptor pfd = b.readImage(o.toString());
            if (pfd == null) return null;
            try (ParcelFileDescriptor.AutoCloseInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd)) {
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) {
                    bos.write(buf, 0, n);
                    if (bos.size() > 3 * 1024 * 1024) return null; // 引擎上限 2.5MB,超了直接弃
                }
                return bos.toByteArray();
            }
        } catch (Exception e) {
            Log.w(TAG, "[hands] readImage failed: " + e.getClass().getSimpleName());
            return null;
        }
    }

    /** T2 文案:缓存并(已绑定则)立即下发。 */
    void configure(String json) {
        configureJson = json;
        IHands b = binder;
        if (b != null) {
            try {
                b.configure(json);
            } catch (RemoteException e) {
                Log.w(TAG, "[hands] configure failed");
            }
        }
    }

    /** 记下正在驱动手机的 run(每条 claim 成功的指令都记;见 driverRunId)。 */
    void noteRun(String runId) {
        driverRunId = runId;
    }

    /**
     * 撤销伴随包的租约(药丸、事件订阅)并忘掉 run。不为此去绑,但**记账**:没绑着 / 发失败时,下次绑上(公开 binder 之前)
     * 与每次转交指令之前先还(09-26 二轮评审 P1:原来没绑上就直接 return,这发撤销就丢了)。
     */
    void cancelAll() {
        driverRunId = null;
        pendingCancel.owe();
        IHands b = binder;
        if (b != null && !pendingCancel.settle(() -> sendCancel(b))) dropBinder();
    }

    /** 急停:药丸「停止」→ onStop → 用主包自持 token 直接 abort(不经 JS,契约 §9.5)。 */
    private void abortRun(String runId) {
        new Thread(() -> {
            String apiBase = NativeConfig.apiBase(ctx);
            if (apiBase != null) PhoneClaim.abort(ctx, apiBase, runId);
        }, "hands-abort").start();
    }
}
