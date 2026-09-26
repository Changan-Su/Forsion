package com.forsion.tangu.hands;

/**
 * 租约状态(手机操控 T2,契约 §9.5)。**纯 Java**,时间由调用方按 elapsedRealtime 口径传入,JVM 可测(LeaseStateTest)。
 *
 * ⚠️ 租约认**账号键**(acct,主包下发的 token 摘要,伴随包永不见 token 本身):另一个账号的第一条 T2 op 必须重新征得同意 ——
 *    只靠主包在换号时 cancelAll 不够:主包没绑上时那一发会丢,token 在 HandsClient 懒建之前变了也没人看见(09-26 评审 P1)。
 * ⚠️ 撤销代数(gen):每次 revoke +1。弹同意浮层前记下代数,用户点「允许」后**原子地**比对再授予 ——
 *    等浮层期间 cancelAll / 急停跑过,就不能再凭这次同意开租约(09-26 评审 P1)。同一代数也给输入链当取消判据。
 */
final class LeaseState {
    static final long LEASE_MS = 10 * 60 * 1000;

    private long until;   // 0 = 无租约
    private String acct;  // 租约属主(账号键)
    private long gen;     // 撤销代数

    /** 租约在期且属于 acct。acct 为空一律不认(fail closed)。 */
    synchronized boolean valid(long now, String acct) {
        return until != 0 && now < until && acct != null && !acct.isEmpty() && acct.equals(this.acct);
    }

    /** 同上,且撤销代数仍是 expectGen(本条 op 开始之后没被撤过 —— 撤了又重新同意也不算)。执行闸与输入链用。 */
    synchronized boolean valid(long now, String acct, long expectGen) {
        return gen == expectGen && valid(now, acct);
    }

    /** 租约在期(不论属主):药丸 / 到期 / status().leased 用。 */
    synchronized boolean active(long now) {
        return until != 0 && now < until;
    }

    synchronized long until() {
        return until;
    }

    synchronized long gen() {
        return gen;
    }

    /**
     * 同意之后才授予:代数没变(等浮层期间没被撤过)∧ 没过期限 ∧ acct 合法 → 开租约并返回 true;否则什么都不改。
     * @param expectGen 弹浮层之前记下的 gen()
     */
    synchronized boolean grantIf(long expectGen, long now, long deadline, String acct) {
        if (gen != expectGen || now >= deadline || acct == null || acct.isEmpty()) return false;
        until = now + LEASE_MS;
        this.acct = acct;
        return true;
    }

    /** 顺延(只给本账号、在期的租约)。 */
    synchronized boolean renew(long now, String acct) {
        if (!valid(now, acct)) return false;
        until = now + LEASE_MS;
        return true;
    }

    /** 撤租约并推进代数(在途的同意 / 输入链据此作废)。 */
    synchronized void revoke() {
        until = 0;
        acct = null;
        gen++;
    }
}
