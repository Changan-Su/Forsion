package com.forsion.tangu.hands;

import android.app.KeyguardManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.graphics.Region;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.PowerManager;
import android.os.Process;
import android.os.RemoteException;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import com.forsion.tangu.hands.TreeSerializer.Sig;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机操控 T2 的跨进程门面(伴随包,契约 §9)。导出、signature 权限保护,每次调用再 checkSignatures + 认主包。
 * 只接受主包在 claim 成功后转来的指令;所有策略(§9.4)、租约(§9.5)、期限、锁屏检查都在这里 fail closed。
 *
 * ⚠️ 不联网、不持 token —— 急停只经 IHandsListener.onStop 通知主包,由主包用自持 token 去 abort。
 *    租约认主包下发的**账号键**(token 摘要,LeaseState):换号后的第一条 T2 op 一定重新弹同意。
 * ⚠️ 句柄解析绝不复用上一轮的 AccessibilityNodeInfo(跨 binder 调用后多半已失效):每次变更类 op **现读**当前树,
 *    按存下的签名(按 obs)解析后再动手(§9.3,TreeSerializer.resolve)。
 * ⚠️ 每条 op 只取**一份** getWindows() 快照(Snap),策略与序列化同源 —— 先判策略、再现读树,中间切进脱敏 App 就会漏一棵树。
 *    策略按**目标所在窗口**判,不只看前台窗口(分屏 / 通知栏盖在别的 App 上,§9.4)。
 * ⚠️ 手势(坐标点、节点动作失败后的兜底点、滑动)在**派发前一刻**另取一份快照重判(checkGesture):按下点由哪个窗口接、
 *    那个窗口过不过策略、它整棵树里落点处是不是提交类控件 —— 节点动作与手势之间界面可能已经换了(09-26 评审 P1)。
 */
public final class HandsBridgeService extends Service {
    private static final String TAG = "Hands";
    static final int PROTO = HandsVerbs.PROTO;
    private static final String OWN = Policy.OWN;
    /** 截图回调之后等窗口事件送达再重取快照(> 无障碍配置的 notificationTimeout=100ms)。 */
    private static final long SHOT_SETTLE_MS = 250;

    private static volatile HandsBridgeService instance;

    private final Overlay overlay = new Overlay();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable leaseExpiry = this::expireLease;
    private volatile Map<String, String> strings;
    private volatile IHandsListener listener;
    /** 租约(在期 / 属主账号 / 撤销代数),纯状态,见 LeaseState。效果(药丸、事件订阅、到期定时)一律在主线程做。 */
    private final LeaseState lease = new LeaseState();

    // obs 状态(单进程单实例):currentObs 对应最近一次 observe 序列化出的签名表;历史保留最近 8 个 obs 供重绑。
    private int obsCounter;
    private int currentObs = -1;
    private final LinkedHashMap<Integer, List<Sig>> obsHistory = new LinkedHashMap<Integer, List<Sig>>(16, 0.75f, false) {
        @Override protected boolean removeEldestEntry(Map.Entry<Integer, List<Sig>> e) {
            return size() > 8;
        }
    };

    // 截图缓冲:observe 截好放这儿,主包随后经 readImage 拉走。
    private volatile byte[] lastShot;
    private volatile String lastShotToken;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) instance = null;
        lease.revoke();
        main.removeCallbacks(leaseExpiry);
        overlay.dismissAll();
    }

    /** 无障碍服务销毁时(用户在设置里关了服务)→ 撤租约、清浮层。 */
    static void onServiceGone() {
        HandsBridgeService s = instance;
        if (s != null) s.revokeLease();
    }

    /** 租约期内有无障碍事件时顺手核一次到期(深睡醒来 postDelayed 还没到点,药丸别多挂)。只读锁内字段,够便宜。 */
    static void checkLeaseExpiry() {
        HandsBridgeService s = instance;
        if (s != null && s.lease.until() != 0 && !s.lease.active(SystemClock.elapsedRealtime())) s.main.post(s.leaseExpiry);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    private final IHands.Stub binder = new IHands.Stub() {
        @Override
        public String exec(String json) {
            checkCaller();
            return HandsBridgeService.this.exec(json);
        }

        @Override
        public ParcelFileDescriptor readImage(String json) {
            checkCaller();
            return HandsBridgeService.this.readImage(json);
        }

        @Override
        public void configure(String stringsJson) {
            checkCaller();
            HandsBridgeService.this.configure(stringsJson);
        }

        @Override
        public String status() {
            checkCaller();
            return HandsBridgeService.this.status();
        }

        @Override
        public void cancelAll() {
            checkCaller();
            HandsBridgeService.this.revokeLease();
        }

        @Override
        public void registerListener(IHandsListener l) {
            checkCaller();
            listener = l;
        }
    };

    /** 每次调用:签名一致 + 调用方确为主包。不满足直接抛 SecurityException(binder 回给主包 → 映射成 hands_signature_mismatch)。 */
    private void checkCaller() {
        int uid = Binder.getCallingUid();
        PackageManager pm = getPackageManager();
        if (pm.checkSignatures(uid, Process.myUid()) != PackageManager.SIGNATURE_MATCH) {
            throw new SecurityException("signature mismatch");
        }
        String[] pkgs = pm.getPackagesForUid(uid);
        if (pkgs != null) {
            for (String p : pkgs) if (OWN.equals(p)) return;
        }
        throw new SecurityException("caller is not the Forsion app");
    }

    // ───────────────────────────── configure / status ─────────────────────────────

    private void configure(String stringsJson) {
        try {
            JSONObject o = new JSONObject(stringsJson);
            Map<String, String> s = new HashMap<>();
            for (String k : HandsVerbs.STRING_KEYS) {
                Object v = o.opt(k);
                if (v instanceof String) s.put(k, (String) v);
            }
            String problem = HandsVerbs.checkStrings(s);
            if (problem != null) {
                Log.w(TAG, "configure rejected: " + problem);
                return; // 保留上一份合格文案
            }
            strings = Collections.unmodifiableMap(s);
        } catch (JSONException e) {
            Log.w(TAG, "configure bad json");
        }
    }

    private String status() {
        JSONObject o = new JSONObject();
        try {
            o.put("proto", PROTO);
            o.put("a11yEnabled", HandsAccessibilityService.getInstance() != null);
            o.put("leased", lease.active(SystemClock.elapsedRealtime()));
        } catch (JSONException ignored) {
            // 固定键,不会抛
        }
        return o.toString();
    }

    // ───────────────────────────── exec 分派 ─────────────────────────────

    private String exec(String json) {
        HandsVerbs.Cmd cmd = HandsVerbs.parse(json);
        if (cmd == null) return err("error", "The companion app got a malformed request.");
        HandsAccessibilityService svc = HandsAccessibilityService.getInstance();
        if (svc == null) return err("hands_disabled", "The accessibility service is not running.");
        switch (cmd.stage) {
            case "lease": return leaseStage(cmd, svc);
            case "run": return runStage(cmd, svc);
            case "start": return startStage(cmd, svc);
            default: return err("error", "Unknown stage.");
        }
    }

    // ── lease 阶段(§9.5):判租约,必要时弹浮层等用户 ──
    private String leaseStage(HandsVerbs.Cmd cmd, HandsAccessibilityService svc) {
        long now = SystemClock.elapsedRealtime();
        if (now >= cmd.deadline) return expired(); // 已过期:别弹一个 wait=0 的浮层
        if (locked()) return leaseJson(false, false, "locked");
        if (cmd.acct == null) return leaseJson(false, false, "error"); // 主包没给账号键:不认(fail closed)
        if (lease.valid(now, cmd.acct)) {
            renewLease(cmd.acct);
            return leaseJson(true, false, null); // 租约期内:无需再 commit
        }
        // 在期但属于别的账号(换号后主包那发 cancelAll 丢了 / HandsClient 还没建):先撤掉(药丸一并撤),再重新征得同意。
        if (lease.active(now)) revokeLease();
        Map<String, String> s = strings;
        if (s == null) return leaseJson(false, false, "error"); // 未配置文案:不弹无字浮层
        // ⚠️ 弹浮层之前记下撤销代数:等用户的这段时间里 cancelAll / 急停 / 关服务跑过,这次「允许」作废(09-26 评审 P1)。
        long gen = lease.gen();
        String title = s.get("leaseTitle");
        String body = HandsVerbs.fillMinutes(s.get("leaseBody"), (int) (LeaseState.LEASE_MS / 60000));
        boolean granted = overlay.showLeaseConsent(title, body, s.get("leaseAllow"), s.get("leaseDeny"), cmd.deadline);
        if (!granted) return leaseJson(false, false, "lease_declined");
        long after = SystemClock.elapsedRealtime();
        if (!lease.grantIf(gen, after, cmd.deadline, cmd.acct)) {
            return after >= cmd.deadline ? expired() : leaseJson(false, false, "lease_declined");
        }
        applyLeaseEffects();
        return leaseJson(true, true, null); // 首次同意:主包随后 commit 再执行
    }

    // ── run 阶段:执行 op,回一份新的 observation ──
    private String runStage(HandsVerbs.Cmd cmd, HandsAccessibilityService svc) {
        String op = cmd.op;
        if (op == null || !HandsVerbs.OPS.contains(op)) return err("error", "Unsupported screen op.");
        if (locked()) return err("locked", "The screen is off or locked.");
        // 本条 op 开始时的撤销代数:之后每个闸都比它,被撤过(哪怕随即又同意了)就停。
        long gen = lease.gen();
        String g = gate(cmd, gen);
        if (g != null) return g;
        try {
            if ("observe".equals(op)) return observe(cmd, svc, gen);
            return mutate(cmd, svc, gen);
        } catch (RuntimeException e) {
            Log.w(TAG, "run " + op + " failed: " + e.getClass().getSimpleName());
            return err("error", "The screen action hit an unexpected error.");
        } finally {
            renewLease(cmd.acct);
        }
    }

    /**
     * 执行前与每个副作用前一刻现查:过了本地期限 → expired(主包不回执);租约已撤 / 已到期 / 不属本账号 / 本条 op 开始后被撤过
     * → lease_declined。
     * ⚠️ 急停不能只靠主包 abort:abort 是异步 POST,可能输给 commit;run 阶段自己不认租约的话,
     *    点了「停止」之后已过 lease 阶段的这一下照样点下去(09-26 评审 P1)。
     */
    private String gate(HandsVerbs.Cmd cmd, long gen) {
        long now = SystemClock.elapsedRealtime();
        if (now >= cmd.deadline) return expired();
        if (!lease.valid(now, cmd.acct, gen)) {
            return err("lease_declined", "Screen control was stopped or has lapsed, so nothing was done.");
        }
        return null;
    }

    /** gate 的布尔版(输入链每一步用)。 */
    private boolean live(HandsVerbs.Cmd cmd, long gen) {
        long now = SystemClock.elapsedRealtime();
        return now < cmd.deadline && lease.valid(now, cmd.acct, gen);
    }

    private String observe(HandsVerbs.Cmd cmd, HandsAccessibilityService svc, long gen) {
        Snap snap = snapshot(svc);
        String block = Policy.observeBlock(snap.front.policy.pkg);
        if (block != null) return err(block, "This app is hidden from Tangu for privacy.");
        TreeSerializer.Result r = capture(svc, snap);
        JSONObject out = ok();
        put(out, "text", r.text);
        if (HandsVerbs.boolArg(cmd.args, "screenshot")) {
            byte[] shot = screenshotChecked(svc, snap);
            // 截图最长 ~3s:这期间用户点了「停止」/ 租约到期 / 过了期限 → 图不交出去(文本树是截之前读的,照回)。
            if (shot != null && live(cmd, gen)) {
                lastShot = shot;
                lastShotToken = "img_" + SystemClock.elapsedRealtime() + "_" + shot.length;
                put(out, "image_pending", lastShotToken);
            }
        }
        return out.toString();
    }

    /**
     * 截图(整屏)的脱敏守卫(§9.3,09-26 评审 P1):截图是异步的(最长 ~3s),只凭截之前那一份快照判「没有脱敏窗口」是 TOCTOU。
     * 截前:窗口列不出(getWindows 空 / 取失败)、前台认不出、任一可见窗口属脱敏包 → 不截(fail closed)。
     * 截后:等窗口事件送达,重取快照;窗口集合 / 前台包变了、期间来过窗口变化事件、或出现脱敏窗口 → 整张丢弃。
     * 截不到 / 被丢弃都只是没图(observe 仍回文本树),不报错。
     */
    private byte[] screenshotChecked(HandsAccessibilityService svc, Snap before) {
        List<ShotGuard.Key> keysBefore = before.keys();
        String frontBefore = before.front.policy.pkg;
        if (!ShotGuard.mayCapture(before.listed, keysBefore, frontBefore)) return null;
        long events = svc.windowsChangedCount();
        byte[] shot = svc.screenshotJpeg();
        if (shot == null) return null;
        sleep(SHOT_SETTLE_MS);
        Snap after = snapshot(svc);
        boolean quiet = svc.windowsChangedCount() == events;
        if (ShotGuard.keep(keysBefore, frontBefore, after.listed, after.keys(), after.front.policy.pkg, quiet)) return shot;
        Log.i(TAG, "screenshot discarded: the window set changed while capturing");
        return null;
    }

    private String mutate(HandsVerbs.Cmd cmd, HandsAccessibilityService svc, long gen) {
        String op = cmd.op;
        Snap snap = snapshot(svc);
        // ⚠️ 全局键 home / notifications / recents 不作用于前台 App 的界面(§9.4):即便前台是保护 / 脱敏 / 只读包也放行
        //(用户发指令那刻 Forsion 恰在前台,「看通知栏」第一步就是 key notifications)。back 与 tap/type/scroll 仍走策略。
        String key = "key".equals(op) ? HandsVerbs.key(cmd.args) : null;
        boolean globalNav = key != null && ("home".equals(key) || "notifications".equals(key) || "recents".equals(key));
        if (!globalNav) {
            // 认不出前台是谁(切换过渡中)→ fail closed,不按「没命中名单」放行。
            if (snap.front.policy.pkg.isEmpty()) return unknownScreen();
            String block = Policy.mutateBlock(snap.front.policy);
            if (block != null) return blocked(block);
        }

        if ("key".equals(op)) {
            if (key == null) return err("invalid_args", "key must be back|home|recents|notifications.");
            String g = gate(cmd, gen);
            if (g != null) return g;
            if (!svc.globalKey(key)) return err("error", "The phone did not accept that key.");
            return afterAction(svc, null);
        }

        // tap / type / scroll:同一份快照现读树,按句柄定位目标;目标所在窗口再过一遍策略。
        DisplayMetrics dm = svc.getResources().getDisplayMetrics();
        TreeSerializer.Result fresh = serialize(svc, snap, currentObs < 0 ? 0 : currentObs);
        int handle = HandsVerbs.handle(cmd.args);
        if (handle == -1) return err("invalid_args", "node handle is out of range.");
        NodeView target = null;
        String note = null;
        if (handle > 0) {
            TreeSerializer.Resolution res = TreeSerializer.resolve(obsHistory, currentObs, handle, HandsVerbs.obs(cmd.args), fresh.sigs);
            if (res.stale) {
                JSONObject out = errObj("stale_handle", "That handle is stale; here is a fresh screen.");
                // ⚠️ 附的树必须登记为新的 current obs:模型接着按这棵树的句柄重试时,resolve 才查得到它的签名。
                put(out, "text", capture(svc, snapshot(svc)).text);
                return out.toString();
            }
            target = fresh.nodes.get(res.index);
            note = res.note;
            String block = nodeBlock(snap, raw(target));
            if (block != null) return blocked(block);
        }
        AccessibilityNodeInfo node = target == null ? null : raw(target);

        switch (op) {
            case "tap": {
                boolean longPress = HandsVerbs.boolArg(cmd.args, "long");
                int x, y, expectWin;
                AccessibilityNodeInfo actor = null;
                if (target != null) {
                    // 提交词表按**实际被点的节点**判(自身或最近可点祖先 + 子树短标签),见 TapGuard。
                    if (TapGuard.commitForNode(target, longPress)) return commitTarget();
                    NodeView act = TapGuard.actor(target, longPress);
                    if (act != null) actor = raw(act);
                    x = target.centerX();
                    y = target.centerY();
                    expectWin = target.windowId(); // 兜底手势必须仍落在目标所在的窗口上
                } else {
                    Integer xi = HandsVerbs.intOrNull(cmd.args, "x"), yi = HandsVerbs.intOrNull(cmd.args, "y");
                    if (xi == null || yi == null) return err("invalid_args", "tap needs a node handle or x/y.");
                    x = xi;
                    y = yi;
                    if (x < 0 || y < 0 || x >= dm.widthPixels || y >= dm.heightPixels) {
                        return err("invalid_args", "x/y is outside the screen.");
                    }
                    if (overlay.isInsidePill(x, y)) return err("refused", "That point is on Tangu's own control, so it was ignored.");
                    expectWin = -1; // 坐标点:派发前按落点所在的最上层窗口判
                }
                if (actor != null) {
                    String g = gate(cmd, gen);
                    if (g != null) return g;
                    if (Actions.performClick(actor, longPress)) return afterAction(svc, note);
                }
                // 手势(坐标点 / 句柄点的兜底):落在药丸上不点;派发前一刻现取快照重判窗口 + 策略 + 满树提交词表。
                if (overlay.isInsidePill(x, y)) return err("error", "Could not tap that element.");
                String why = checkGesture(cmd, gen, svc, new int[] {x, y}, expectWin);
                if (why != null) return why;
                if (!svc.tap(x, y, longPress)) return err("error", "Could not tap that element.");
                return afterAction(svc, note);
            }
            case "type": {
                String text = HandsVerbs.text(cmd.args);
                if (text == null) return err("invalid_args", "text is required.");
                AccessibilityNodeInfo field = node;
                if (field == null) {
                    // 无句柄:只认当前输入焦点所在的可编辑控件(§9.2)。没有焦点 → 要句柄,不猜「第一个输入框」(09-26 评审 P2)。
                    NodeView f = TypeChain.focusedEditable(snap.allowedViews());
                    if (f == null) {
                        return err("invalid_args", "No text field has focus; pass the node handle of the field to type into.");
                    }
                    field = raw(f);
                }
                // ⚠️ 只往可编辑控件里打字:输入链会先 ACTION_CLICK —— 指向「支付」按钮的 type 就是一次绕过提交词表的点击。
                if (!field.isEditable()) return err("invalid_args", "That element is not a text field.");
                if (field.isPassword()) return err("redacted", "Tangu will not type into a password field.");
                if (node == null) {
                    String block = nodeBlock(snap, field); // 焦点框可能在别的窗口里
                    if (block != null) return blocked(block);
                }
                String g = gate(cmd, gen);
                if (g != null) return g;
                // 输入链的每一步(聚焦 / 点 / 清空 / 重试 / 写剪贴板 / 粘贴)之前都再过闸(09-26 评审 P1)。
                TypeChain.Outcome o = Actions.setText(getApplicationContext(), field, text,
                    HandsVerbs.boolArg(cmd.args, "append"), () -> live(cmd, gen));
                if (o == TypeChain.Outcome.STOPPED) {
                    if (SystemClock.elapsedRealtime() >= cmd.deadline) return expired(); // 过了期限:不回执(同 gate)
                    return err("lease_declined", "Screen control was stopped while typing, so Tangu stopped; the field may be partly filled.");
                }
                if (o != TypeChain.Outcome.DONE) return err("error", "Could not enter text.");
                return afterAction(svc, note);
            }
            case "scroll": {
                String dir = HandsVerbs.scrollDir(cmd.args);
                if (dir == null) return err("invalid_args", "direction must be up|down|left|right.");
                if (node != null) {
                    String g = gate(cmd, gen);
                    if (g != null) return g;
                    if (Actions.scrollAction(node, dir)) return afterAction(svc, note);
                }
                // 滑动手势兜底(09-26 评审 P1):先按「被批准的窗口」(有句柄:目标所在窗口;无句柄:前台窗口,已过策略)的可见区算路径,
                // 按下点与路径都必须在它里面 —— 原来按屏幕中心判策略、却从中心偏 1/3 屏处起手,能落进分屏另一半的受保护 App 或输入法里。
                Win approved = target != null ? snap.byId(target.windowId()) : snap.front;
                if (approved == null || approved == Win.NONE) return err("error", "Nothing scrolled.");
                Rect area = new Rect(0, 0, dm.widthPixels, dm.heightPixels);
                if (target != null) area.set(target.left(), target.top(), target.right(), target.bottom());
                if (!area.intersect(0, 0, dm.widthPixels, dm.heightPixels)) area.set(0, 0, dm.widthPixels, dm.heightPixels);
                int[] vis = GestureGuard.uncovered(snap.wins, approved, area.left, area.top, area.right, area.bottom);
                int[] path = vis == null ? null : GestureGuard.swipePath(vis[0], vis[1], vis[2], vis[3], dir);
                if (path == null) return err("error", "Nothing scrolled: that part of the screen is covered by another window.");
                if (overlay.isInsidePill(path[0], path[1])) return err("error", "Nothing scrolled.");
                String why = checkGesture(cmd, gen, svc, path, approved.id);
                if (why != null) return why;
                if (!svc.swipe(path[0], path[1], path[2], path[3], 300)) return err("error", "Nothing scrolled.");
                return afterAction(svc, note);
            }
            default:
                return err("error", "Unsupported screen op.");
        }
    }

    /**
     * 手势派发前一刻的现查(09-26 评审 P1:坐标点的提交词表绕过 / 节点动作失败后的陈旧兜底 / 滑动起手点):
     * 另取一份快照,按**按下点**所在的最上层窗口判 —— 须仍是当初核过的窗口(expectWin ≥ 0 时)、过策略、
     * 点击在该窗口**整棵树**里过提交词表、滑动路径不出该窗口(GestureGuard);再比一次窗口集合(判的这段时间里没换窗口),
     * 最后过闸(期限 / 租约 / 撤销代数)。任一不过 → 返回结果 JSON,手势不发。
     * @param path 点击 {x,y};滑动 {x1,y1,x2,y2}
     */
    private String checkGesture(HandsVerbs.Cmd cmd, long gen, HandsAccessibilityService svc, int[] path, int expectWin) {
        Snap now = snapshot(svc);
        if (!now.listed) return unknownScreen(); // 列不出窗口就不知道谁接这次触摸
        String v = path.length == 2
            ? GestureGuard.checkTap(now.wins, path[0], path[1], expectWin)
            : GestureGuard.checkSwipe(now.wins, path, expectWin);
        if (v != null) return gestureRefusal(v);
        if (!now.keys().equals(windowKeys(svc))) return screenChanged();
        return gate(cmd, gen);
    }

    private static String gestureRefusal(String v) {
        switch (v) {
            case GestureGuard.COMMIT: return commitTarget();
            case GestureGuard.WINDOW_CHANGED: return screenChanged();
            case GestureGuard.OVERLAY:
                return err("refused", "Another accessibility service's overlay covers that spot, so Tangu did not touch it.");
            case GestureGuard.OFF_WINDOW:
                return err("error", "That swipe would leave the app's window, so nothing was done.");
            case GestureGuard.UNKNOWN:
                return err("error", "Could not tell what is at that spot on screen, so nothing was done; observe again and use a node handle.");
            default:
                return blocked(v); // protected_app / redacted / read_only_app
        }
    }

    /** 动作后:等界面稳定,回一份新的 observation(§9.2);note 为重绑说明,置于首行。 */
    private String afterAction(HandsAccessibilityService svc, String note) {
        settle(svc);
        Snap snap = snapshot(svc);
        JSONObject out = ok();
        if (Policy.observeBlock(snap.front.policy.pkg) != null) {
            put(out, "text", "app: (" + snap.front.policy.pkg + ") · hidden");
            return out.toString();
        }
        String text = capture(svc, snap).text;
        if (note != null) text = note + "\n" + text;
        put(out, "text", text);
        return out.toString();
    }

    // ── start 阶段(§9.2):主包在后台时委托伴随包启动 Activity ──
    private String startStage(HandsVerbs.Cmd cmd, HandsAccessibilityService svc) {
        if (locked()) return err("locked", "The screen is off or locked.");
        if (cmd.intentUri == null) return err("error", "No intent to start.");
        if (SystemClock.elapsedRealtime() >= cmd.deadline) return expired();
        Intent i;
        try {
            i = Intent.parseUri(cmd.intentUri, Intent.URI_INTENT_SCHEME);
        } catch (Exception e) {
            return err("error", "Bad intent.");
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String before = snapshot(svc).front.policy.pkg;
        try {
            svc.startActivity(i); // 无障碍服务享后台启动豁免
        } catch (RuntimeException e) {
            Log.w(TAG, "delegated start failed: " + e.getClass().getSimpleName());
            return err("needs_user", "The phone would not open that app from the background.");
        }
        // 轮询目标是否真到前台:OEM「后台弹出界面」拦截框会顶在前面,或什么都没发生 → needs_user(不谎报成功)。
        // ⚠️ 不知道目标包(多个接手者 → 系统选择器)时,只认「前台换了人」:主包在后台,启动前前台本来就不是 Forsion,
        //    「前台不是 Forsion」恒真,拿它当成功 = 被拦了也报 handoff(09-26 评审)。
        String want = cmd.pkg;
        long until = SystemClock.elapsedRealtime() + 1200;
        while (SystemClock.elapsedRealtime() < until) {
            String frontPkg = snapshot(svc).front.policy.pkg;
            boolean arrived = want != null ? want.equals(frontPkg) : !frontPkg.equals(before);
            if (!frontPkg.isEmpty() && !OWN.equals(frontPkg) && arrived) {
                JSONObject out = ok();
                put(out, "handoff", true);
                if (cmd.app != null) put(out, "app", cmd.app);
                return out.toString();
            }
            sleep(120);
        }
        return err("needs_user", "The app did not come to the front; a system prompt may be blocking it.");
    }

    /** 现读树并登记为当前 obs(observe / 动作后 / stale 附树)。 */
    private TreeSerializer.Result capture(HandsAccessibilityService svc, Snap snap) {
        int obs = ++obsCounter;
        TreeSerializer.Result r = serialize(svc, snap, obs);
        currentObs = obs;
        obsHistory.put(obs, r.sigs);
        return r;
    }

    /** 按快照序列化:脱敏包的窗口整窗略去(只记个数)。mutate 解析句柄与 capture 登记必须同一口径,下标才对得上。 */
    private TreeSerializer.Result serialize(HandsAccessibilityService svc, Snap snap, int obs) {
        DisplayMetrics dm = svc.getResources().getDisplayMetrics();
        String pkg = snap.front.policy.pkg;
        return TreeSerializer.serialize(snap.allowedViews(), appLabel(pkg), pkg, dm.widthPixels, dm.heightPixels, obs,
            snap.redactedCount());
    }

    // ───────────────────────────── 租约 ─────────────────────────────

    /**
     * 开租约的效果(事件订阅、到期定时、药丸)一律在主线程做,且做之前再认一次租约在期:
     * grantIf 与这里之间若被撤销(撤销的效果也在主线程排队),药丸不会在租约没了之后挂上去、再也没人撤(09-26 评审)。
     */
    private void applyLeaseEffects() {
        main.post(() -> {
            if (!lease.active(SystemClock.elapsedRealtime())) return;
            HandsAccessibilityService svc = HandsAccessibilityService.getInstance();
            if (svc != null) svc.setLeaseEvents(true);
            scheduleExpiry();
            Map<String, String> s = strings;
            if (s != null) {
                overlay.showPill(s.get("pillLabel"), s.get("pillStop"), this::onPillStop,
                    () -> lease.active(SystemClock.elapsedRealtime()));
            }
        });
    }

    private void renewLease(String acct) {
        if (lease.renew(SystemClock.elapsedRealtime(), acct)) scheduleExpiry();
    }

    /** 到点自动撤租约(撤药丸 + 关事件订阅)。⚠️ 没有它药丸「Tangu 正在操作」会在租约过期后一直挂着(09-26 评审)。 */
    private void scheduleExpiry() {
        main.removeCallbacks(leaseExpiry);
        main.postDelayed(leaseExpiry, Math.max(0, lease.until() - SystemClock.elapsedRealtime()));
    }

    /** postDelayed 走 uptime(深睡不走),到点时按 elapsedRealtime 再核一次:没到就补排,到了才撤。 */
    private void expireLease() {
        long until = lease.until();
        if (until == 0) return;
        long left = until - SystemClock.elapsedRealtime();
        if (left > 0) {
            main.removeCallbacks(leaseExpiry);
            main.postDelayed(leaseExpiry, left);
            return;
        }
        revokeLease();
    }

    private void onPillStop() {
        revokeLease();
        IHandsListener l = listener;
        if (l != null) {
            try {
                l.onStop();
            } catch (RemoteException e) {
                Log.w(TAG, "onStop notify failed");
            }
        }
    }

    /**
     * 撤租约(cancelAll / 急停 / 到期 / 服务销毁,任意线程):状态当场撤(推进撤销代数)、在途的同意当场按拒绝了结
     * (等浮层的 binder 线程立刻返回,执行道放行);药丸 / 事件订阅 / 定时在主线程撤 —— 与 applyLeaseEffects 同一队列,不会乱序。
     */
    private void revokeLease() {
        lease.revoke();
        overlay.cancelConsent();
        main.post(() -> {
            if (lease.active(SystemClock.elapsedRealtime())) return; // 期间又经新的同意开了租约:效果归它
            main.removeCallbacks(leaseExpiry);
            HandsAccessibilityService svc = HandsAccessibilityService.getInstance();
            if (svc != null) svc.setLeaseEvents(false);
            // ⚠️ 只撤药丸,不在这里 cancelConsent:换号时 leaseStage 先 revokeLease 再弹新的同意浮层,
            //    这段排在主线程上的撤销若再 cancel 一次,会把刚弹出的新同意当场判成拒绝。在途的同意上面已同步了结。
            overlay.hidePill();
        });
    }

    // ───────────────────────────── 截图回传 ─────────────────────────────

    private ParcelFileDescriptor readImage(String json) {
        String token;
        try {
            token = new JSONObject(json).optString("token", "");
        } catch (JSONException e) {
            return null;
        }
        final byte[] bytes = lastShot;
        if (bytes == null || token.isEmpty() || !token.equals(lastShotToken)) return null;
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            // ⚠️ 从工作线程写:管道缓冲 ~64KB,300KB 若在 binder 线程直写会与主包读端死锁。
            new Thread(() -> {
                try (ParcelFileDescriptor.AutoCloseOutputStream os = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                    os.write(bytes);
                } catch (IOException e) {
                    Log.w(TAG, "readImage write failed: " + e.getClass().getSimpleName());
                }
            }, "hands-image").start();
            return pipe[0];
        } catch (IOException e) {
            return null;
        }
    }

    // ───────────────────────────── 工具 ─────────────────────────────

    /**
     * 一个窗口在本次快照里的样子。policy = 策略用的纯数据视图(Policy.Win);同时是 GestureGuard 的 Pane(命中测试用)。
     * root 可空:取不到根的窗口不进树,但仍参与命中测试(落在上面的手势按「认不出」拒)。
     */
    private static final class Win implements GestureGuard.Pane {
        final int id;
        final AccessibilityNodeInfo root;
        /** 可触摸区域的外接矩形(API 33+ 取 getRegionInScreen 的,否则窗口边界)。 */
        final Rect bounds;
        /** API 33+ 的可触摸区域;null → 按 bounds。 */
        final Region region;
        final Policy.Win policy;
        final boolean redacted;
        /** 别的无障碍服务的浮层(TYPE_ACCESSIBILITY_OVERLAY,不是伴随包自己的)。 */
        final boolean foreign;

        Win(int id, AccessibilityNodeInfo root, Rect bounds, Region region, Policy.Win policy, boolean foreign) {
            this.id = id;
            this.root = root;
            this.bounds = bounds;
            this.region = region;
            this.policy = policy;
            this.foreign = foreign;
            this.redacted = !foreign && Policy.isRedactedPackage(policy.pkg);
        }

        static final Win NONE = new Win(-1, null, new Rect(), null, new Policy.Win("", null, null, null), false);

        @Override public int id() { return id; }
        @Override public Policy.Win policy() { return policy; }
        @Override public boolean contains(int x, int y) { return region != null ? region.contains(x, y) : bounds.contains(x, y); }
        @Override public int left() { return bounds.left; }
        @Override public int top() { return bounds.top; }
        @Override public int right() { return bounds.right; }
        @Override public int bottom() { return bounds.bottom; }
        @Override public NodeView root() { return root == null ? null : new NodeInfoView(root); }
        @Override public boolean foreignOverlay() { return foreign; }
    }

    /**
     * 一份 getWindows() 快照:wins 从上到下(getWindows 按层级降序),含别的无障碍服务的浮层(只供命中测试)、不含伴随包自己的浮层;
     * front = 活动 / 焦点窗口。listed = getWindows() 这次确实列出了窗口 —— 否则只是拿 getRootInActiveWindow 凑的,认不全。
     */
    private static final class Snap {
        final List<Win> wins;
        final Win front;
        final boolean listed;

        Snap(List<Win> wins, Win front, boolean listed) {
            this.wins = wins;
            this.front = front;
            this.listed = listed;
        }

        /** 进树的窗口根(NodeView):略去脱敏包、别人的浮层、取不到根的窗口。 */
        List<NodeView> allowedViews() {
            List<NodeView> out = new ArrayList<>();
            for (Win w : wins) if (!w.redacted && !w.foreign && w.root != null) out.add(new NodeInfoView(w.root));
            return out;
        }

        int redactedCount() {
            int n = 0;
            for (Win w : wins) if (w.redacted) n++;
            return n;
        }

        Win byId(int id) {
            for (Win w : wins) if (w.id == id) return w;
            return null;
        }

        List<ShotGuard.Key> keys() {
            List<ShotGuard.Key> out = new ArrayList<>();
            for (Win w : wins) out.add(new ShotGuard.Key(w.id, w.policy.pkg));
            return out;
        }
    }

    private Snap snapshot(HandsAccessibilityService svc) {
        List<Win> wins = new ArrayList<>();
        Win front = null;
        boolean listed = false;
        try {
            List<AccessibilityWindowInfo> windows = svc.getWindows();
            if (windows != null) {
                for (AccessibilityWindowInfo w : windows) {
                    if (w == null) continue;
                    AccessibilityNodeInfo r = w.getRoot();
                    Rect b = new Rect();
                    w.getBoundsInScreen(b);
                    Region region = touchRegion(w);
                    if (region != null) b = region.getBounds();
                    if (w.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) {
                        // 自己的药丸 / 同意框:不进树、不算前台,坐标手势落在药丸上另有 isInsidePill 拦。
                        // 别的无障碍服务的浮层:同样不进树,但它压在一切之上、会接住手势 → 记下来,落在上面的手势一律拒。
                        String opkg = r == null || r.getPackageName() == null ? "" : r.getPackageName().toString();
                        if (Policy.HANDS.equals(opkg)) continue;
                        wins.add(new Win(w.getId(), null, b, region, new Policy.Win(opkg, null, null, null), true));
                        continue;
                    }
                    CharSequence t = w.getTitle();
                    Win x = win(w.getId(), r, b, region, t == null ? null : t.toString());
                    wins.add(x);
                    if (front == null && (w.isActive() || w.isFocused()) && !x.policy.pkg.isEmpty()) front = x;
                }
                listed = !wins.isEmpty();
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "getWindows failed: " + e.getClass().getSimpleName());
            listed = false;
        }
        if (front == null) {
            AccessibilityNodeInfo r = svc.getRootInActiveWindow();
            if (r != null) {
                front = findWin(wins, r.getWindowId());
                if (front == null && wins.isEmpty()) {
                    Rect b = new Rect();
                    r.getBoundsInScreen(b);
                    front = win(r.getWindowId(), r, b, null, null);
                    wins.add(front);
                }
            }
        }
        return new Snap(wins, front != null ? front : Win.NONE, listed);
    }

    /** API 33+:窗口的可触摸区域(谁接住触摸按它判);更早的系统 → null(按窗口边界)。 */
    private static Region touchRegion(AccessibilityWindowInfo w) {
        if (Build.VERSION.SDK_INT < 33) return null;
        try {
            Region region = new Region();
            w.getRegionInScreen(region);
            return region;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** 轻量的窗口键(只取 id + 包名,不收文字):checkGesture 判完之后比一次,判的这段时间里窗口没换。 */
    private static List<ShotGuard.Key> windowKeys(HandsAccessibilityService svc) {
        List<ShotGuard.Key> out = new ArrayList<>();
        try {
            List<AccessibilityWindowInfo> windows = svc.getWindows();
            if (windows == null) return out;
            for (AccessibilityWindowInfo w : windows) {
                if (w == null) continue;
                AccessibilityNodeInfo r = w.getRoot();
                String pkg = r == null || r.getPackageName() == null ? "" : r.getPackageName().toString();
                if (w.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && Policy.HANDS.equals(pkg)) continue;
                out.add(new ShotGuard.Key(w.getId(), pkg));
            }
        } catch (RuntimeException e) {
            out.clear();
        }
        return out;
    }

    private static Win findWin(List<Win> wins, int id) {
        for (Win w : wins) if (w.id == id) return w;
        return null;
    }

    /** heading / texts 只对系统配置面(设置类包、systemui)取:敏感页标题与同意框措辞只在那里判(Policy)。 */
    private static Win win(int id, AccessibilityNodeInfo root, Rect bounds, Region region, String title) {
        String pkg = root == null || root.getPackageName() == null ? "" : root.getPackageName().toString();
        String heading = null;
        List<String> texts = null;
        if (root != null && (Policy.isSettingsPackage(pkg) || Policy.isSystemUi(pkg))) {
            texts = new ArrayList<>();
            collectTexts(root, texts, new int[] {0});
            heading = texts.isEmpty() ? null : texts.get(0);
        }
        return new Win(id, root, bounds, region, new Policy.Win(pkg, title, heading, texts), false);
    }

    /** 深度优先收前 40 条非空文字(最多走 300 个节点);首条即「首个标题」。 */
    private static void collectTexts(AccessibilityNodeInfo n, List<String> out, int[] visited) {
        if (n == null || out.size() >= 40 || visited[0]++ >= 300) return;
        CharSequence t = n.getText();
        if (t != null && t.toString().trim().length() > 0) out.add(t.toString());
        for (int i = 0; i < n.getChildCount() && out.size() < 40; i++) {
            collectTexts(n.getChild(i), out, visited);
        }
    }

    /** 目标节点所在窗口的策略码;窗口不在快照里 → 退到节点自己的包名;还认不出 → protected_app(fail closed)。 */
    private static String nodeBlock(Snap snap, AccessibilityNodeInfo n) {
        Win w = snap.byId(n.getWindowId());
        if (w != null) {
            if (w.foreign || w.policy.pkg.isEmpty()) return "protected_app";
            return Policy.mutateBlock(w.policy);
        }
        CharSequence p = n.getPackageName();
        if (p == null || p.length() == 0) return "protected_app";
        return Policy.mutateBlock(new Policy.Win(p.toString(), null, null, null));
    }

    private static AccessibilityNodeInfo raw(NodeView v) {
        return ((NodeInfoView) v).raw();
    }

    private static String blocked(String code) {
        return err(code, "This screen is off-limits for changes.");
    }

    private static String commitTarget() {
        return err("commit_target",
            "This looks like a send, pay, submit, order, call or save button, so Tangu is handing it back to you.");
    }

    private static String unknownScreen() {
        return err("error", "Could not tell which app is on screen; observe again, then retry.");
    }

    private static String screenChanged() {
        return err("error", "The screen changed before Tangu could act (a different window is now at that spot), so nothing was done; observe again, then retry.");
    }

    private String appLabel(String pkg) {
        if (pkg == null || pkg.isEmpty()) return "";
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    private boolean locked() {
        PowerManager pm = getSystemService(PowerManager.class);
        KeyguardManager km = getSystemService(KeyguardManager.class);
        boolean interactive = pm == null || pm.isInteractive();
        boolean keyguard = km != null && km.isKeyguardLocked();
        return !interactive || keyguard;
    }

    private void settle(HandsAccessibilityService svc) {
        svc.markSettleBaseline();
        long start = SystemClock.elapsedRealtime();
        while (true) {
            long now = SystemClock.elapsedRealtime();
            if (now - start >= 2000) return;
            if (now - svc.lastEventElapsed() >= 300) return;
            sleep(60);
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ── JSON 结果 ──

    private static JSONObject ok() {
        JSONObject o = new JSONObject();
        put(o, "ok", true);
        return o;
    }

    private static String err(String code, String error) {
        return errObj(code, error).toString();
    }

    private static JSONObject errObj(String code, String error) {
        JSONObject o = new JSONObject();
        put(o, "ok", false);
        put(o, "code", code);
        put(o, "error", error);
        return o;
    }

    /** 过了本地期限:主包据此回 null(不回执,由引擎按超时兑现)。 */
    private static String expired() {
        JSONObject o = new JSONObject();
        put(o, "expired", true);
        return o.toString();
    }

    private static String leaseJson(boolean granted, boolean needsCommit, String code) {
        JSONObject o = new JSONObject();
        put(o, "phase", "lease");
        put(o, "granted", granted);
        put(o, "needsCommit", needsCommit);
        if (code != null) put(o, "code", code);
        return o.toString();
    }

    private static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (JSONException ignored) {
            // 仅 key null / 数值 NaN 时抛
        }
    }
}
