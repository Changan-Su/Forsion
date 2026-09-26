package com.forsion.tangu;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;

import androidx.appcompat.app.AlertDialog;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 手机操控 T1(Intent / 深链 / 系统 API,无无障碍)。契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §3、§4、§6。
 *
 * 一条指令的生命周期(全在本插件自己的线程池上,绝不堵 Capacitor 的插件线程):
 *   exec 入参校验 + LRU 去重(不符 → accepted:false,不 claim 不回执)→ claim(引擎签发、仍在等、digest 一致才给 nonce)
 *   → 开关关着 → disabled → 规划 / 分级(PhoneVerbs,纯逻辑)→ 要启动 Activity 但不在前台 → needs_foreground
 *   → 排进执行道(一次只执行一条)→ R3:原生确认框(本地期限到自动关 = declined;迟到的确认永不执行)→ commit → 执行 → result。
 *
 * ⚠️ 引擎的 pending 表是唯一权威:没 claim 到 nonce 就绝不执行。JS 只是搬运工,body 里的任何字段都不决定风险。
 * ⚠️ 开关在原生(SharedPreferences `forsion_phone_control`),开启必须过原生确认框;JS 的开关只展示这里回报的状态。
 * ⚠️ claim 并发、执行串行:一条 R3 确认框最长挂 60s,要是整条生命周期共用一个线程,后面的指令连 claim 都发不出去,
 *    错过引擎 15s 的 claim 窗口。所以 claim 在线程池上各跑各的;确认框 / startActivity / 系统调用走执行道(公平信号量,
 *    一次一条)。排到本地期限还没轮到 → 什么都没做,如实回 error —— 不吭声的话引擎会按 no_report 说「可能已经发生」。
 * ⚠️ 期限与前台在副作用前一刻现查(PhoneVerbs.gate):commit 返回后查一次,主线程里 startActivity / 写剪贴板前再查一次。
 *    过了期限:不执行、不回执(引擎按超时兑现);期限内但不在前台:needs_foreground。
 * 本文件不含用户可见字面量:两个确认框的文案经 configure() 由 JS 按界面语言下发。
 */
@CapacitorPlugin(name = "PhoneControl")
public class PhoneControlPlugin extends Plugin {
    private static final String TAG = "PhoneControl";
    static final int PROTO = 1;
    static final String CAP_INTENTS = "phone.intents";
    static final String CAP_UI = "phone.ui";
    private static final String PREFS = "forsion_phone_control";
    private static final String KEY_ENABLED = "enabled";
    private static final long DEADLINE_MARGIN_MS = PhoneVerbs.DEADLINE_MARGIN_MS;
    private static final int LRU_SIZE = 256;
    /** 同时在途的指令上限。线程会阻塞在 claim(最坏 ~50s)、排执行道(≤ 本地期限)、回执上 —— 给少了就又堵 claim。 */
    private static final int POOL_SIZE = 8;
    private static final int QUEUE_SIZE = 64;

    /** 每条指令一个任务:claim → 排执行道 → 执行 → 回执。 */
    private final ThreadPoolExecutor pool = newPool();
    /** 执行道:确认框、startActivity、系统调用一次只有一条。公平 = 先领到的先做。 */
    private final Semaphore lane = new Semaphore(1, true);
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean foreground;
    private volatile Map<String, String> strings;
    /** 伴随包客户端(T2)。懒建;绑定 / 状态判定都在里面(契约 §9.1)。 */
    private volatile HandsClient hands;
    /** 见过的 ackId(契约 §3.1 的本机 LRU)。校验通过的那一刻就占位 —— 重复转交在 claim 发出之前就被挡掉。 */
    private final PhoneVerbs.SeenAcks seenAcks = new PhoneVerbs.SeenAcks(LRU_SIZE);

    /** start() 的结局。只有 NO_HANDLER 让调用方接着试下一个 Intent。 */
    private enum Started { STARTED, NO_HANDLER, EXPIRED, BACKGROUND }

    /** ⚠️ core = max 且核心线程可超时:ThreadPoolExecutor(0, N, 无界队列) 只会起一个线程,等于又回到单线程。 */
    private static ThreadPoolExecutor newPool() {
        ThreadPoolExecutor p = new ThreadPoolExecutor(POOL_SIZE, POOL_SIZE, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<>(QUEUE_SIZE));
        p.allowCoreThreadTimeOut(true);
        return p;
    }

    // ───────────────────────────── 生命周期:前台标志 ─────────────────────────────

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        foreground = true;
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        foreground = false;
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        pool.shutdown();
    }

    // ───────────────────────────── 插件方法(契约 §6) ─────────────────────────────

    @PluginMethod
    public void status(PluginCall call) {
        boolean on = isEnabled();
        // hands 状态如实报告(与开关无关,契约 §6):没装 / 签名 / 无障碍 / proto。可能懒绑定,故不在主线程调
        //(Capacitor 插件方法默认在线程池上跑,阻塞 ≤1.5s 可接受)。
        HandsClient.State hs = hands().state();
        JSObject r = new JSObject();
        r.put("enabled", on);
        JSArray caps = new JSArray();
        if (on) {
            caps.put(CAP_INTENTS);
            if (hs == HandsClient.State.READY) caps.put(CAP_UI); // §9.1:开关开 ∧ 伴随包就绪
        }
        r.put("capabilities", caps);
        r.put("foreground", foreground);
        r.put("proto", PROTO);
        r.put("hands", HandsClient.stateName(hs));
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    /** 打开系统无障碍设置页(设置页「打开无障碍设置」调用,契约 §6)。 */
    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity a = getActivity();
        try {
            (a != null ? a : getContext()).startActivity(i);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("cannot open accessibility settings");
        }
    }

    private HandsClient hands() {
        HandsClient h = hands;
        if (h == null) {
            synchronized (this) {
                if (hands == null) hands = new HandsClient(getContext());
                h = hands;
            }
        }
        return h;
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean want = call.getBoolean("enabled");
        if (want == null) {
            call.reject("enabled must be a boolean");
            return;
        }
        if (!want) {
            prefs().edit().putBoolean(KEY_ENABLED, false).apply();
            // 关开关 = 连同伴随包的租约一起撤(药丸、事件订阅):否则「已关闭」之后 10 分钟内药丸还挂着、租约还能被沿用。
            hands().cancelAll();
            resolveEnabled(call, false);
            return;
        }
        if (isEnabled()) {
            resolveEnabled(call, true);
            return;
        }
        Map<String, String> s = strings;
        Activity a = getActivity();
        if (s == null) {
            call.reject("not_configured");
            return;
        }
        if (a == null) {
            resolveEnabled(call, false);
            return;
        }
        AtomicBoolean done = new AtomicBoolean(false);
        a.runOnUiThread(() -> {
            try {
                new AlertDialog.Builder(a)
                    .setTitle(s.get("enableTitle"))
                    .setMessage(s.get("enableBody"))
                    .setPositiveButton(s.get("enableConfirm"), (d, w) -> {
                        if (!done.compareAndSet(false, true)) return;
                        prefs().edit().putBoolean(KEY_ENABLED, true).apply();
                        resolveEnabled(call, true);
                    })
                    .setNegativeButton(s.get("cancel"), (d, w) -> {
                        if (done.compareAndSet(false, true)) resolveEnabled(call, false);
                    })
                    .setOnCancelListener((d) -> {
                        if (done.compareAndSet(false, true)) resolveEnabled(call, false);
                    })
                    .show();
            } catch (RuntimeException e) { // Activity 正在结束:BadTokenException
                if (done.compareAndSet(false, true)) resolveEnabled(call, false);
            }
        });
    }

    @PluginMethod
    public void configure(PluginCall call) {
        JSObject in = call.getObject("strings");
        if (in == null) {
            call.reject("strings is required");
            return;
        }
        Map<String, String> s = new HashMap<>();
        for (String k : PhoneVerbs.STRING_KEYS) {
            Object v = in.opt(k);
            if (v instanceof String) s.put(k, (String) v);
        }
        String problem = PhoneVerbs.checkStrings(s);
        if (problem != null) {
            call.reject(problem); // 保留上一份合格的文案
            return;
        }
        strings = Collections.unmodifiableMap(s);
        // T2:把租约浮层 / 药丸文案转交伴随包(§6)。伴随包除无障碍 label/description 外没有用户可见字面量。
        pushHandsStrings(s);
        call.resolve();
    }

    /** 把 T2 文案子集下发给伴随包(缓存于 HandsClient,绑定成功后自动补推)。 */
    private void pushHandsStrings(Map<String, String> s) {
        JSONObject o = new JSONObject();
        for (String k : PhoneVerbs.HANDS_STRING_KEYS) put(o, k, s.get(k));
        hands().configure(o.toString());
    }

    @PluginMethod
    public void exec(PluginCall call) {
        PhoneVerbs.Command cmd = PhoneVerbs.parseCommand(call.getString("runId"), call.getString("ackId"), call.getString("body"));
        boolean accepted = cmd != null && seenAcks.add(cmd.ackId);
        JSObject r = new JSObject();
        r.put("accepted", accepted);
        call.resolve(r);
        if (!accepted) {
            Log.w(TAG, "[phone] exec dropped before claim (invalid or duplicate)");
            return;
        }
        try {
            pool.execute(() -> run(cmd));
        } catch (RuntimeException e) { // 池已关(Activity 销毁中)/ 队列满:不 claim,引擎按 not_picked_up 兑现
            Log.w(TAG, "[phone] exec dropped: " + e.getClass().getSimpleName());
        }
    }

    // ───────────────────────────── 指令主流程(池线程) ─────────────────────────────

    private void run(PhoneVerbs.Command cmd) {
        String apiBase = NativeConfig.apiBase(getContext());
        if (apiBase == null) return;
        PhoneClaim wire = new PhoneClaim(getContext(), apiBase, cmd.runId, cmd.ackId);
        PhoneClaim.Claimed claimed = wire.claim(PhoneVerbs.sha256Hex(cmd.body));
        if (claimed == null) return; // 伪造 / 重放 / 过期 / 他人的 run:不执行、不回执
        // 急停要 abort 的是「正在驱动手机的 run」:claim 成功即记,不随单条 op 清掉 —— 用户多半在两步之间(模型思考时)点停止(§9.5)。
        hands().noteRun(cmd.runId);
        // ⚠️ 锚在成功那次响应的到达时刻,不是第一次发出:丢响应重试时引擎回的是剩余时长(见 PhoneVerbs.localDeadline)。
        long deadline = PhoneVerbs.localDeadline(claimed.receivedAt, claimed.execMs);
        JSONObject result;
        try {
            result = perform(cmd, deadline, wire, claimed.nonce);
        } catch (Throwable t) {
            Log.w(TAG, "[phone] " + cmd.op + " failed: " + t.getClass().getSimpleName());
            result = fail("error", "The phone hit an unexpected error (" + t.getClass().getSimpleName() + ").");
        }
        if (result != null) wire.result(claimed.nonce, result);
    }

    /** 返回 null = 不执行也不回执(过了本地期限 / commit 被引擎拒绝:引擎那边已经兑现了超时或 abort)。 */
    private JSONObject perform(PhoneVerbs.Command cmd, long deadline, PhoneClaim wire, String nonce) throws Exception {
        if (!isEnabled()) return disabled();
        // T2 屏幕操作:转交伴随包(不受前台约束,受租约 + 策略约束)。走 lease → commit → run 两段(契约 §9.5)。
        if (PhoneVerbs.UI_OPS.contains(cmd.op)) return uiOp(cmd, deadline, wire, nonce);
        PhoneVerbs.Plan plan;
        try {
            plan = PhoneVerbs.plan(cmd.op, cmd.args, getContext().getPackageName(), ZoneId.systemDefault());
        } catch (PhoneVerbs.Reject r) {
            return fail(r.code, r.getMessage());
        }
        // 早筛:不在前台就别排队、别弹确认框。真正的判定在主线程 startActivity 前一刻(start)。
        // launch / view 在伴随包就绪时放行:后台由伴随包代劳启动(§9.2);state() 可能懒绑定(≤1.5s),只在需要时问。
        boolean fg = foreground && getActivity() != null;
        boolean handsReady = !fg && PhoneVerbs.DELEGABLE_OPS.contains(plan.op) && hands().state() == HandsClient.State.READY;
        if (PhoneVerbs.mustBeForeground(plan.op, fg, handsReady)) return needsForeground();
        if (expired(deadline)) return null;
        // 执行道:排到本地期限还没轮到 → 什么都没做,如实回执(期限余量正好留给这一枪)。
        // ⚠️ 不能不吭声:引擎会按 no_report 告诉模型「可能已经发生」—— 比修之前 claim 被堵时的 not_picked_up 还失真。
        if (!lane.tryAcquire(Math.max(0, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS)) {
            return fail("busy", "Another phone action was still waiting for the user, so this one ran out of time before it could start. Nothing was done.");
        }
        try {
            // 排队期间状态可能变了:开关、期限、前台都再查一遍。launch / view 不在这里判前台:
            // start() 在主线程现查,后台 → delegateStart(伴随包不就绪时它自己回 needs_foreground)。
            if (!isEnabled()) return disabled();
            boolean needFg = plan.needsForeground() && !PhoneVerbs.DELEGABLE_OPS.contains(plan.op);
            switch (PhoneVerbs.gate(SystemClock.elapsedRealtime(), deadline, needFg, foreground && getActivity() != null)) {
                case EXPIRED: return null;
                case NEEDS_FOREGROUND: return needsForeground();
                default: break;
            }
            switch (plan.op) {
                case "media": return media(plan.choice);
                case "volume": return volume(plan.choice);
                case "torch": return torch(plan.on, deadline);
                case "clip": return clip(plan.text, deadline);
                case "launch": return launch(plan, deadline);
                case "view": return view(plan, deadline, wire, nonce);
                default: return startFirst(plan, deadline);
            }
        } finally {
            lane.release();
        }
    }

    // ── 启动 Activity 的 op ──

    /** sendto / dial / send / insert_event / alarm / timer / settings:按序尝试,第一个能启动的算数。 */
    private JSONObject startFirst(PhoneVerbs.Plan plan, long deadline) throws Exception {
        for (IntentSpec spec : plan.intents) {
            Intent i = toIntent(spec);
            String app = spec.chooser ? "" : appLabel(resolve(i));
            Started s = start(i, deadline);
            if (s == Started.STARTED) return handoff(app, plan.unverified ? Boolean.FALSE : null);
            if (s != Started.NO_HANDLER) return notStarted(s);
        }
        return fail("no_handler", "No app on this phone can handle that.");
    }

    private JSONObject launch(PhoneVerbs.Plan plan, long deadline) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        String pkg = plan.pkg;
        if (pkg == null) {
            List<String[]> apps = new ArrayList<>();
            Intent q = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            for (ResolveInfo ri : pm.queryIntentActivities(q, 0)) {
                apps.add(new String[] {appLabel(ri), ri.activityInfo.packageName});
            }
            List<String[]> m = PhoneVerbs.matchApps(plan.name, apps);
            if (m.isEmpty()) return fail("not_found", "No installed app matches that name.");
            if (m.size() > 1) {
                JSONObject r = fail("ambiguous", "Several apps match that name; retry with one package name.");
                r.put("text", PhoneVerbs.describeCandidates(m));
                return r;
            }
            pkg = m.get(0)[1];
        }
        Intent i = pm.getLaunchIntentForPackage(pkg);
        if (i == null) return fail("not_found", "No launchable app with that package is installed.");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String app = appLabel(resolve(i));
        Started s = start(i, deadline);
        if (s == Started.STARTED) return handoff(app, null);
        if (s == Started.NO_HANDLER) return fail("no_handler", "That app could not be opened.");
        // 后台 + 伴随包就绪 → 委托伴随包启动(§9.2);否则 needs_foreground / null。
        if (s == Started.BACKGROUND) return delegateStart(i, pkg, app, deadline);
        return notStarted(s);
    }

    /**
     * view:逐个候选。http/https/geo 先 resolveActivity,接手的全是浏览器 / 地图白名单 → R1;否则(含其他 App scheme)R3。
     * R3 = 原生确认框(事实由原生填:App 名 + scheme://host)→ 本地期限内确认 → commit → 启动。拒绝即止,不试下一个。
     */
    private JSONObject view(PhoneVerbs.Plan plan, long deadline, PhoneClaim wire, String nonce) throws Exception {
        for (IntentSpec spec : plan.intents) {
            Intent i = toIntent(spec);
            List<ResolveInfo> handlers = handlers(i);
            if (handlers.isEmpty()) continue;
            List<String> pkgs = new ArrayList<>();
            List<String> labels = new ArrayList<>();
            for (ResolveInfo ri : handlers) {
                pkgs.add(ri.activityInfo.packageName);
                labels.add(appLabel(ri));
            }
            // ⚠️ 接手者含 Forsion 自己 → 整条拒绝(不试下一个):深链登录回跳没有 state,模型发来的
            //    tangu://auth-callback?token=<别人的> 一点「打开」就换号(登录 CSRF)。tangu scheme 在规划阶段已拒,
            //    这里兜住以后加的 App Links / 其他自有过滤器。
            if (pkgs.contains(getContext().getPackageName())) {
                return fail("refused", "Links that open Forsion itself are not allowed.");
            }
            // 单一接手者:钉死包名 —— 用户确认的是哪个 App,启动的就是哪个 App。
            if (handlers.size() == 1) i.setPackage(pkgs.get(0));
            String app = joinLabels(labels);
            boolean r3 = PhoneVerbs.tierForView(PhoneVerbs.schemeOf(spec.data), pkgs) == PhoneVerbs.Tier.R3;
            if (r3) {
                if (strings == null) return fail("error", "Phone control is not set up yet; ask the user to reopen Forsion.");
                // R3 的确认框开在 Forsion 里:后台弹不出来(挂在暂停的 Activity 上干等到期),不委托伴随包。
                if (!(foreground && getActivity() != null)) return needsForeground();
                if (!confirm(app, PhoneVerbs.targetOf(spec.data), deadline)) {
                    return SystemClock.elapsedRealtime() > deadline + DEADLINE_MARGIN_MS ? null
                        : fail("declined", "The user did not allow opening " + PhoneVerbs.clean(app, 60) + ".");
                }
                if (expired(deadline)) return null; // 迟到的确认永不执行
                if (!wire.commit(nonce)) return null; // 引擎已 abort / 超时:不执行
                // ⚠️ commit 是阻塞 HTTP(读超时 15s):回来时可能已过本地期限,引擎那边多半已按超时兑现 —— 这时再启动就是迟到执行。
                if (expired(deadline)) return null;
            }
            Started s = start(i, deadline);
            if (s == Started.STARTED) return handoff(app, null);
            // §9.2 委托只给 R1;R3 确认之后用户按了 Home → needs_foreground,不在后台把 App 顶到用户眼前(台架 case 15)。
            // 单一接手者时钉死的包名一并交给伴随包,它据此判「目标真到前台」;多个接手者(系统选择器)时为 null。
            if (s == Started.BACKGROUND) return r3 ? needsForeground() : delegateStart(i, i.getPackage(), app, deadline);
            if (s != Started.NO_HANDLER) return notStarted(s);
            // NO_HANDLER:试下一个候选
        }
        return fail("no_handler", "No app on this phone can open these links.");
    }

    // ───────────────────────────── T2:屏幕操作(转交伴随包,契约 §9) ─────────────────────────────

    /**
     * 一条 T2 op 的两段流程:lease(判租约,首条弹浮层)→(needsCommit 时)commit → run(执行 + 回新 observation)。
     * ⚠️ 只有主包能 claim / commit;伴随包做浮层与执行。deadline(elapsedRealtime)一并传入,两进程同一时钟。
     */
    private JSONObject uiOp(PhoneVerbs.Command cmd, long deadline, PhoneClaim wire, String nonce) throws Exception {
        HandsClient hc = hands();
        switch (hc.state()) {
            case MISSING: return fail("hands_missing", "The companion app (Forsion Hands) is not installed on this phone.");
            case SIGNATURE_MISMATCH: return fail("hands_signature_mismatch", "The installed companion app is not signed by Forsion, so it will not be used.");
            case DISABLED: return fail("hands_disabled", "The companion app's accessibility service is not turned on.");
            case PROTO_MISMATCH: return fail("hands_disabled", "The companion app version does not match this Forsion; ask the user to update both.");
            default: break; // READY
        }
        if (expired(deadline)) return null;
        // 执行道:与 R3 同一条;排到本地期限还没轮到 → 什么都没做,如实回 busy(不能沉默 → no_report)。
        if (!lane.tryAcquire(Math.max(0, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS)) {
            return fail("busy", "Another phone action was still waiting for the user, so this one ran out of time before it could start. Nothing was done.");
        }
        try {
            if (!isEnabled()) return disabled();
            if (expired(deadline)) return null;
            // 账号键(§9.5 / §9.7):伴随包的租约认它,换号后的第一条 T2 op 一定重新弹同意。只给 token 的摘要,不给 token。
            String acct = PhoneVerbs.leaseKey(NativeConfig.token(getContext()));
            if (acct == null) return fail("error", "Forsion is not signed in on this phone.");
            // lease 阶段:租约期内直接放行;否则弹浮层等用户(浮层到期自动关 = declined)。
            JSONObject lease = execHands(hc, stage("lease", cmd, deadline, null, null, null).put("acct", acct));
            if (lease == null) return fail("error", "The companion app did not respond.");
            if (lease.optBoolean("expired", false)) return null;
            if (!lease.optBoolean("granted", false)) {
                String code = lease.optString("code", "lease_declined");
                return fail(code, uiCodeMessage(code));
            }
            if (lease.optBoolean("needsCommit", false)) {
                if (expired(deadline)) return null;
                if (!wire.commit(nonce)) return null; // 引擎已 abort / 超时
                if (expired(deadline)) return null;   // commit 阻塞回来可能已过期
            }
            // ⚠️ 发 run 之前再认一次开关(09-26 评审 P1):等浮层 / commit 的这段时间里用户可能关了开关 ——
            //    关开关会 cancelAll,但那一发可能输给这里;伴随包的撤销代数兜住它那一侧,这里兜住主包这一侧。
            if (!isEnabled()) return disabled();
            // run 阶段
            JSONObject res = execHands(hc, stage("run", cmd, deadline, null, null, null).put("acct", acct));
            if (res == null) return fail("error", "The companion app did not respond.");
            if (res.optBoolean("expired", false)) return null;
            // 截图回填:伴随包只给 token,字节经管道单独拉,base64 成 data URI(引擎按 image 消毒,上限 2.5MB)。
            String token = res.optString("image_pending", "");
            if (!token.isEmpty()) {
                res.remove("image_pending");
                byte[] img = hc.readImage(token);
                if (img != null) put(res, "image", "data:image/jpeg;base64," + Base64.encodeToString(img, Base64.NO_WRAP));
            }
            return res;
        } finally {
            lane.release();
        }
    }

    /** hc.exec 的 JSON 封装:null(绑不上 / binder 死)→ null。 */
    private static JSONObject execHands(HandsClient hc, JSONObject stageJson) {
        String out = hc.exec(stageJson.toString());
        if (out == null) return null;
        try {
            return new JSONObject(out);
        } catch (JSONException e) {
            return null;
        }
    }

    /** 组装转交伴随包的 exec body。intentUri / pkg / app 仅 start 阶段用(§9.2 委托)。 */
    private static JSONObject stage(String stageName, PhoneVerbs.Command cmd, long deadline,
                                    String intentUri, String pkg, String app) {
        JSONObject o = new JSONObject();
        put(o, "stage", stageName);
        if (cmd != null) {
            put(o, "op", cmd.op);
            put(o, "args", cmd.args);
        }
        put(o, "deadline", deadline);
        if (intentUri != null) put(o, "intent", intentUri);
        if (pkg != null) put(o, "pkg", pkg);
        if (app != null) put(o, "app", app);
        return o;
    }

    private static String uiCodeMessage(String code) {
        switch (code) {
            case "lease_declined": return "The user did not allow Tangu to operate the screen.";
            case "locked": return "The phone screen is off or locked.";
            default: return "Screen control could not start (" + code + ").";
        }
    }

    /**
     * §9.2 委托:主包在后台(needs_foreground)且伴随包就绪时,把启动 Activity 交给伴随包(无障碍绑定享后台启动豁免)。
     * 伴随包不就绪 → 保持老行为 needs_foreground。OEM 拦截框 / 起不来 → needs_user(不谎报成功)。
     * pkg = 目标包(已知就给:伴随包按「它到了前台」判成功;null 时只能按「前台换了人」判)。
     */
    private JSONObject delegateStart(Intent i, String pkg, String app, long deadline) {
        HandsClient hc = hands();
        if (hc.state() != HandsClient.State.READY) return needsForeground();
        if (expired(deadline)) return null;
        JSONObject r = execHands(hc, stage("start", null, deadline, i.toUri(Intent.URI_INTENT_SCHEME), pkg, app));
        if (r == null) return needsForeground(); // 连不上伴随包:回落老行为
        if (r.optBoolean("expired", false)) return null;
        if (r.optBoolean("ok", false)) return handoff(app, null);
        String code = r.optString("code", "needs_user");
        return fail(code, r.optString("error", "The app could not be opened from the background."));
    }

    /**
     * 能接这个 Intent 的 Activity:有默认处理者 → 它一个;落到系统选择器(包名 "android")→ 全部候选;没有 → 空。
     * 包可见性:manifest 的 <queries>(LAUNCHER / VIEW https / VIEW geo …)让绝大多数目标 App 可见。
     */
    private List<ResolveInfo> handlers(Intent i) {
        PackageManager pm = getContext().getPackageManager();
        ResolveInfo ri = pm.resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY);
        if (ri == null || ri.activityInfo == null) return Collections.emptyList();
        if (!"android".equals(ri.activityInfo.packageName)) return Collections.singletonList(ri);
        List<ResolveInfo> all = new ArrayList<>();
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        for (ResolveInfo r : pm.queryIntentActivities(i, PackageManager.MATCH_DEFAULT_ONLY)) {
            if (r.activityInfo != null && seen.add(r.activityInfo.packageName)) all.add(r);
        }
        return all;
    }

    private ResolveInfo resolve(Intent i) {
        return getContext().getPackageManager().resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY);
    }

    private String appLabel(ResolveInfo ri) {
        if (ri == null || ri.activityInfo == null) return "";
        try {
            PackageManager pm = getContext().getPackageManager();
            return PhoneVerbs.clean(String.valueOf(pm.getApplicationLabel(ri.activityInfo.applicationInfo)), 60);
        } catch (RuntimeException e) {
            return ri.activityInfo.packageName;
        }
    }

    private static String joinLabels(List<String> labels) {
        StringBuilder b = new StringBuilder();
        for (int k = 0; k < labels.size() && k < 3; k++) {
            if (b.length() > 0) b.append(", ");
            b.append(labels.get(k));
        }
        if (labels.size() > 3) b.append(", …");
        return b.toString();
    }

    /**
     * 在主线程用 Activity 启动;ActivityNotFoundException / SecurityException → NO_HANDLER(调用方试下一个)。
     * ⚠️ 期限与前台在主线程上、startActivity 前一刻现查(PhoneVerbs.gate):主线程可能排队近 10s,用户可能在确认之后
     *    按了 Home —— 更早查过的结论到这里都可能过时。不查的话,后台 startActivity 要么被系统静默拦下(不抛异常 → 谎报
     *    handoff),要么落在宽限期里真把目标 App 顶到用户眼前(模拟器 API 35 实测:确认后按 Home,地图照样被拉起)。
     *    foreground 由 handleOnResume / handleOnPause 在主线程写,这里在主线程读 = 当下的真值。
     */
    private Started start(Intent i, long deadline) throws Exception {
        return onMain(() -> {
            Activity a = getActivity();
            switch (PhoneVerbs.gate(SystemClock.elapsedRealtime(), deadline, true, foreground && a != null)) {
                case EXPIRED: return Started.EXPIRED;
                case NEEDS_FOREGROUND: return Started.BACKGROUND;
                default: break;
            }
            try {
                a.startActivity(i);
                return Started.STARTED;
            } catch (ActivityNotFoundException | SecurityException e) {
                Log.i(TAG, "[phone] start failed: " + e.getClass().getSimpleName());
                return Started.NO_HANDLER;
            }
        });
    }

    /** 没交接成功、也不该再试下一个:过了期限 → null(不回执);不在前台 → needs_foreground。 */
    private static JSONObject notStarted(Started s) {
        return s == Started.EXPIRED ? null : needsForeground();
    }

    static Intent toIntent(IntentSpec spec) {
        Intent i = new Intent(spec.action);
        Uri data = spec.data == null ? null : Uri.parse(spec.data);
        if (data != null && spec.type != null) i.setDataAndType(data, spec.type);
        else if (data != null) i.setData(data);
        else if (spec.type != null) i.setType(spec.type);
        if (spec.category != null) i.addCategory(spec.category);
        i.addFlags(spec.flags);
        for (Map.Entry<String, Object> e : spec.extras.entrySet()) {
            Object v = e.getValue();
            if (v instanceof String) i.putExtra(e.getKey(), (String) v);
            else if (v instanceof Boolean) i.putExtra(e.getKey(), (Boolean) v);
            else if (v instanceof Integer) i.putExtra(e.getKey(), (Integer) v);
            else if (v instanceof Long) i.putExtra(e.getKey(), (Long) v);
            else if (v instanceof ArrayList) {
                ArrayList<Integer> list = new ArrayList<>();
                for (Object x : (ArrayList<?>) v) list.add((Integer) x);
                i.putIntegerArrayListExtra(e.getKey(), list);
            }
        }
        if (!spec.chooser) return i;
        Intent c = Intent.createChooser(i, null);
        c.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return c;
    }

    // ── R3 确认框 ──

    /**
     * 原生确认框。到本地期限自动关闭 = 拒绝;超时后的点击被 future 的「先到先得」吃掉,且调用方再查一次期限。
     */
    private boolean confirm(String app, String target, long deadline) {
        Map<String, String> s = strings;
        Activity a = getActivity();
        if (s == null || a == null) return false;
        CompletableFuture<Boolean> answer = new CompletableFuture<>();
        AtomicReference<AlertDialog> shown = new AtomicReference<>();
        a.runOnUiThread(() -> {
            if (answer.isDone()) return;
            try {
                AlertDialog d = new AlertDialog.Builder(a)
                    .setTitle(s.get("confirmTitle"))
                    .setMessage(PhoneVerbs.fill(s.get("confirmBody"), app, target))
                    .setPositiveButton(s.get("confirmAllow"), (di, w) -> answer.complete(true))
                    .setNegativeButton(s.get("confirmDeny"), (di, w) -> answer.complete(false))
                    .setOnCancelListener((di) -> answer.complete(false))
                    .create();
                shown.set(d);
                d.show();
            } catch (RuntimeException e) {
                answer.complete(false);
            }
        });
        boolean yes;
        try {
            yes = answer.get(Math.max(0, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS);
        } catch (TimeoutException | InterruptedException | ExecutionException e) {
            yes = false;
        }
        answer.complete(false); // 从此刻起任何点击都无效
        main.post(() -> {
            AlertDialog d = shown.get();
            if (d != null && d.isShowing()) {
                try { d.dismiss(); } catch (RuntimeException ignored) { /* Activity 已销毁 */ }
            }
        });
        return yes && SystemClock.elapsedRealtime() <= deadline;
    }

    // ── 后台可用的直接系统调用 ──

    private JSONObject media(String key) {
        int code = "next".equals(key) ? KeyEvent.KEYCODE_MEDIA_NEXT
            : "previous".equals(key) ? KeyEvent.KEYCODE_MEDIA_PREVIOUS : KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
        AudioManager am = getContext().getSystemService(AudioManager.class);
        am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
        am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
        return ok(); // 发出去了;有没有 App 接(是否真在放)这边看不到,不报 verified
    }

    private JSONObject volume(String dir) throws Exception {
        AudioManager am = getContext().getSystemService(AudioManager.class);
        int adj = "up".equals(dir) ? AudioManager.ADJUST_RAISE : "down".equals(dir) ? AudioManager.ADJUST_LOWER : AudioManager.ADJUST_MUTE;
        try {
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, adj, AudioManager.FLAG_SHOW_UI);
        } catch (SecurityException e) { // 勿扰模式下个别机型
            return fail("error", "The phone did not allow changing the volume.");
        }
        JSONObject r = ok();
        r.put("text", am.isStreamMute(AudioManager.STREAM_MUSIC) ? "Media volume is muted."
            : "Media volume is now " + am.getStreamVolume(AudioManager.STREAM_MUSIC) + " of " + am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) + ".");
        return r;
    }

    /** 手电筒:CameraManager.setTorchMode 不需要 CAMERA 权限(AOSP 源码文档无权限要求),不开相机设备。 */
    private JSONObject torch(boolean on, long deadline) throws Exception {
        CameraManager cm = getContext().getSystemService(CameraManager.class);
        String id = null;
        for (String c : cm.getCameraIdList()) {
            CameraCharacteristics ch = cm.getCameraCharacteristics(c);
            if (!Boolean.TRUE.equals(ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE))) continue;
            Integer facing = ch.get(CameraCharacteristics.LENS_FACING);
            if (id == null || (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK)) id = c;
        }
        if (id == null) return fail("unsupported", "This phone has no flashlight.");
        if (expired(deadline)) return null; // 枚举相机夹在上一道闸与副作用之间
        try {
            cm.setTorchMode(id, on);
        } catch (CameraAccessException e) {
            return fail("error", "The flashlight is in use by another app.");
        }
        JSONObject r = ok();
        r.put("verified", true);
        return r;
    }

    /** 写剪贴板在主线程:同 start,期限在主线程上、写之前一刻现查(剪贴板后台可写,不看前台)。 */
    private JSONObject clip(String text, long deadline) throws Exception {
        boolean done = onMain(() -> {
            if (expired(deadline)) return false;
            ClipboardManager cm = getContext().getSystemService(ClipboardManager.class);
            cm.setPrimaryClip(ClipData.newPlainText("text", text));
            return true;
        });
        return done ? ok() : null;
    }

    // ───────────────────────────── 工具 ─────────────────────────────

    /**
     * 主线程执行,最多等 10s。⚠️ 超时时没开跑的任务会被撤掉(PhoneVerbs.callBounded):否则主线程卡过 10s 后
     * 它照样迟到执行 startActivity / 写剪贴板,而引擎早已按 error 告诉模型「没做成」,模型一重试就做了两遍。
     */
    private <T> T onMain(Callable<T> fn) throws Exception {
        return PhoneVerbs.callBounded(main::post, fn, 10_000);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean isEnabled() {
        return prefs().getBoolean(KEY_ENABLED, false);
    }

    private void resolveEnabled(PluginCall call, boolean on) {
        JSObject r = new JSObject();
        r.put("enabled", on);
        call.resolve(r);
    }

    /** 过了本地期限(与 start 里主线程那道闸同一个判定)。 */
    private static boolean expired(long deadline) {
        return PhoneVerbs.gate(SystemClock.elapsedRealtime(), deadline, false, true) == PhoneVerbs.Gate.EXPIRED;
    }

    private static JSONObject disabled() {
        return fail("disabled", "Phone control is turned off in Forsion's settings on this phone.");
    }

    private static JSONObject needsForeground() {
        return fail("needs_foreground", "Forsion is not in the foreground on the phone, so it cannot open another app right now.");
    }

    private static JSONObject ok() {
        JSONObject r = new JSONObject();
        put(r, "ok", true);
        return r;
    }

    private static JSONObject handoff(String app, Boolean verified) {
        JSONObject r = ok();
        put(r, "handoff", true);
        if (app != null && !app.isEmpty()) put(r, "app", app);
        if (verified != null) put(r, "verified", verified);
        return r;
    }

    private static JSONObject fail(String code, String error) {
        JSONObject r = new JSONObject();
        put(r, "ok", false);
        put(r, "code", code);
        if (error != null) put(r, "error", error);
        return r;
    }

    private static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Exception ignored) {
            // 只在 key 为 null / 数值 NaN 时抛
        }
    }
}
