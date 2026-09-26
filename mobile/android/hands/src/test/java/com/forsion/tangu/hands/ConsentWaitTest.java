package com.forsion.tangu.hands;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * ConsentWait / Slot 单测(JVM):撤销当场了结在途的同意(契约 §9.5,09-26 二轮评审 P2 #9)。
 * ⚠️ 断言「及时」而不只是「false」:等待超时同样返回 false,只断言 false 的话没修也是绿的。
 * 跑法:cd mobile/android && ./gradlew :hands:testDebugUnitTest
 */
public class ConsentWaitTest {

    @Test
    public void cancelReleasesTheWaiterImmediately() throws Exception {
        ConsentWait.Slot slot = new ConsentWait.Slot();
        ConsentWait w = slot.open();
        AtomicBoolean result = new AtomicBoolean(true);
        AtomicLong waited = new AtomicLong(-1);
        Thread t = new Thread(() -> {
            long t0 = System.nanoTime();
            try {
                result.set(w.await(30_000)); // T2 的 90s 期限量级
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            waited.set((System.nanoTime() - t0) / 1_000_000);
        });
        t.start();
        Thread.sleep(100);
        slot.cancel();                   // cancelAll / 急停 / 关服务
        assertTrue("cancel must settle the pending consent at once", w.isDone());
        t.join(2_000);
        assertFalse(t.isAlive());
        assertFalse(result.get());
        assertTrue("waited " + waited.get() + "ms", waited.get() >= 0 && waited.get() < 2_000);
        // 撤销之后再点「允许」无效
        assertFalse(w.finish(true));
    }

    @Test
    public void firstFinisherWins() throws Exception {
        ConsentWait w = new ConsentWait();
        assertTrue(w.finish(true));
        assertFalse(w.finish(false));
        assertTrue(w.await(0));
    }

    @Test
    public void timeoutIsDenial() throws Exception {
        ConsentWait w = new ConsentWait();
        assertFalse(w.await(10));
        assertTrue(w.isDone());
        assertFalse(w.finish(true));
    }

    @Test
    public void newConsentSupersedesOldAndCloseOnlyClearsOwn() {
        ConsentWait.Slot slot = new ConsentWait.Slot();
        ConsentWait a = slot.open();
        ConsentWait b = slot.open();
        assertTrue(a.isDone());          // 被顶掉的按拒绝了结
        slot.close(a);                   // 旧的清槽不影响新的
        slot.cancel();
        assertTrue(b.isDone());
    }
}
