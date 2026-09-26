package com.forsion.tangu.hands;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * LeaseState 单测(JVM):租约认账号键、同意与撤销的竞态按撤销代数判(契约 §9.5,09-26 二轮评审 P1 #5 / #6)。
 * 跑法:cd mobile/android && ./gradlew :hands:testDebugUnitTest
 */
public class LeaseStateTest {
    private static final String A = "0123456789abcdef0123456789abcdef";
    private static final String B = "fedcba9876543210fedcba9876543210";

    /** #5:换了账号(主包那发 cancelAll 丢了)的第一条 T2 op 不能沿用上一个账号的同意。 */
    @Test
    public void leaseBelongsToOneAccount() {
        LeaseState l = new LeaseState();
        long g = l.gen();
        assertTrue(l.grantIf(g, 1_000, 60_000, A));
        assertTrue(l.valid(2_000, A));
        assertFalse("another account must be asked again", l.valid(2_000, B));
        assertFalse(l.renew(2_000, B));
        assertTrue(l.active(2_000)); // 药丸 / status 仍按「有租约」
        assertFalse(l.valid(2_000, null));
        assertFalse(l.valid(2_000, ""));
    }

    /** #6:弹同意浮层期间 cancelAll / 急停跑过 → 用户随后点「允许」也不开租约。 */
    @Test
    public void consentAfterCancellationDoesNotGrant() {
        LeaseState l = new LeaseState();
        long g = l.gen();          // leaseStage 弹浮层之前记下
        l.revoke();                // 等用户期间:cancelAll
        assertFalse(l.grantIf(g, 1_000, 60_000, A));
        assertFalse(l.active(1_000));
        assertFalse(l.valid(1_000, A));
        // 期限已过的同意同样不算
        LeaseState l2 = new LeaseState();
        assertFalse(l2.grantIf(l2.gen(), 60_000, 60_000, A));
        assertFalse(l2.grantIf(l2.gen(), 1_000, 60_000, null));
    }

    /** 本条 op 开始后被撤过(哪怕随即又同意了)→ 这条 op 的闸不过。 */
    @Test
    public void generationPinsTheOp() {
        LeaseState l = new LeaseState();
        assertTrue(l.grantIf(l.gen(), 0, 60_000, A));
        long opGen = l.gen();
        assertTrue(l.valid(1_000, A, opGen));
        l.revoke();
        assertTrue(l.grantIf(l.gen(), 1_500, 60_000, A));
        assertTrue(l.valid(2_000, A));
        assertFalse(l.valid(2_000, A, opGen));
    }

    @Test
    public void expiryAndRenew() {
        LeaseState l = new LeaseState();
        assertTrue(l.grantIf(l.gen(), 0, 60_000, A));
        assertEquals(LeaseState.LEASE_MS, l.until());
        assertTrue(l.renew(LeaseState.LEASE_MS - 1, A));
        assertEquals(2 * LeaseState.LEASE_MS - 1, l.until());
        assertFalse(l.valid(2 * LeaseState.LEASE_MS, A));
        assertFalse(l.renew(2 * LeaseState.LEASE_MS, A));
        l.revoke();
        assertEquals(0, l.until());
    }
}
