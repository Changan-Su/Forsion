package com.forsion.tangu.hands;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 一次租约同意的等待(手机操控 T2,契约 §9.5)。**纯 Java**,JVM 可测(ConsentWaitTest)。
 * 先到先得:用户点「允许 / 暂不」、到本地期限、被撤销(cancelAll / 急停 / 关服务)—— 谁先 finish 算谁,之后的一律无效。
 *
 * ⚠️ 撤销必须**当场**了结这次等待(finish(false)):只把浮层 removeView 掉的话,binder 线程还在 latch 上干等到期限(T2 期限 90s),
 *    这期间执行道(lane)一直被占着,后面的指令全排成 busy(09-26 评审 P2)。
 */
final class ConsentWait {
    private final CountDownLatch latch = new CountDownLatch(1);
    private final AtomicBoolean done = new AtomicBoolean(false);
    private volatile boolean granted;

    /** 了结这次等待。已了结过 → false(本次无效)。 */
    boolean finish(boolean yes) {
        if (!done.compareAndSet(false, true)) return false;
        granted = yes;
        latch.countDown();
        return true;
    }

    boolean isDone() {
        return done.get();
    }

    /** 等到了结或超时;超时按拒绝了结(若恰好同时被点了允许,以先了结的为准)。返回是否同意。 */
    boolean await(long ms) throws InterruptedException {
        if (!latch.await(Math.max(0, ms), TimeUnit.MILLISECONDS)) finish(false);
        return granted;
    }

    /**
     * 在途同意的槽位(Overlay 持有一个)。open 登记新的一次(顶掉的旧的按拒绝了结);cancel 把在途的那次当场按拒绝了结;
     * close 在等待方返回后清槽(只清自己那次)。任意线程可调。
     */
    static final class Slot {
        private final AtomicReference<ConsentWait> pending = new AtomicReference<>();

        ConsentWait open() {
            ConsentWait w = new ConsentWait();
            ConsentWait old = pending.getAndSet(w);
            if (old != null) old.finish(false);
            return w;
        }

        /** 撤销在途的同意:当场按拒绝了结(等待方立刻返回)。没有在途的 → 什么都不做。 */
        void cancel() {
            ConsentWait w = pending.getAndSet(null);
            if (w != null) w.finish(false);
        }

        void close(ConsentWait w) {
            pending.compareAndSet(w, null);
        }
    }
}
