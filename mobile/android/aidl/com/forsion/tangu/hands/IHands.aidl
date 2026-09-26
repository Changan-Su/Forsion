// 手机操控 T2 的跨 APK 接口(主包 com.forsion.tangu → 伴随包 com.forsion.tangu.hands)。
// 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §9.1、§9.2。
// ⚠️ 共享 aidl 源目录(../aidl),两个模块都 buildFeatures { aidl true } 并把它加进 sourceSets,
//    于是双方生成同一个 stub / proxy,包名一致才能互认。
package com.forsion.tangu.hands;

import com.forsion.tangu.hands.IHandsListener;
import android.os.ParcelFileDescriptor;

interface IHands {
    // 每次调用伴随包都再 checkSignatures(Binder.getCallingUid(), myUid);不一致直接抛 SecurityException。
    // exec 的入参是一段 JSON(见 HandsVerbs):{stage, op, args, deadline}。
    //   stage="lease":判租约 —— 需要弹浮层就弹并等用户,返回 {phase:"lease", granted, needsCommit, code?}。
    //   stage="run" :执行 op 并回一份新的 observation,返回 {ok, code?, text?, image_pending?, ...}。
    // ⚠️ 分两阶段是因为 R3 语义要求 claim → 浮层 → **commit**(只有主包能 commit)→ 执行,
    //    单次阻塞 exec 塞不下「浮层确认后主包再 commit」这一步。契约 §9.5,已在 §9 记为对列表接口的增量。
    String exec(String json);

    // 截图字节走管道,绝不塞进 String 返回(binder 事务上限 ~1MB)。json={token}:取 observe 时截好的那张。
    ParcelFileDescriptor readImage(String json);

    // 主包按界面语言下发文案(租约浮层 + 停止药丸);占位符校验规则同 R3。
    void configure(String stringsJson);

    // {proto, a11yEnabled, leased}。主包据此判 phone.ui 能力是否成立(§9.1)。
    String status();

    // 撤销租约、清掉在途等待(主包收到 onStop 之后、或重置时调用)。
    void cancelAll();

    // 急停回调:药丸「停止」被点 → onStop()。oneway,不阻塞伴随包。
    oneway void registerListener(IHandsListener listener);
}
