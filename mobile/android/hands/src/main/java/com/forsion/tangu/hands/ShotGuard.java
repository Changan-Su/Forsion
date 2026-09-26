package com.forsion.tangu.hands;

import java.util.List;

/**
 * observe 截图(整屏)的脱敏守卫(手机操控 T2,契约 §9.3 / §9.4)。**纯 Java**,JVM 可测(ShotGuardTest)。
 *
 * ⚠️ 09-26 评审 P1:截图是异步的(回调最长 ~3s),原来只凭截之前那一份 getWindows() 快照判「没有脱敏窗口」——
 *    截的过程中支付宝切到前台 / 通知栏拉下来盖上去,整屏就把树里略去的那窗补了回来;getWindows() 取不到时还按「没有脱敏窗口」放行。
 *    现在:截前认不全就不截(fail closed);截后重取快照,窗口集合 / 前台包变了、期间来过窗口变化事件、或出现脱敏窗口 → 整张丢弃。
 */
final class ShotGuard {
    private ShotGuard() {}

    /** 一个窗口的身份(id + 包名);快照里按层序从上到下排。 */
    static final class Key {
        final int id;
        final String pkg;

        Key(int id, String pkg) {
            this.id = id;
            this.pkg = pkg == null ? "" : pkg;
        }

        @Override
        public boolean equals(Object o) {
            if (!(o instanceof Key)) return false;
            Key k = (Key) o;
            return id == k.id && pkg.equals(k.pkg);
        }

        @Override
        public int hashCode() {
            return id * 31 + pkg.hashCode();
        }

        @Override
        public String toString() {
            return id + ":" + pkg;
        }
    }

    /** 截之前:窗口列得出来(getWindows 非空)、前台认得出、没有任何窗口属脱敏包。 */
    static boolean mayCapture(boolean listed, List<Key> keys, String frontPkg) {
        if (!listed || keys == null || keys.isEmpty() || frontPkg == null || frontPkg.isEmpty()) return false;
        for (Key k : keys) if (Policy.isRedactedPackage(k.pkg)) return false;
        return true;
    }

    /**
     * 截之后:截后快照仍满足 mayCapture,窗口集合(id + 包,含层序)与前台包都和截前一致,且期间没来过窗口变化事件(quiet)。
     * 任一不满足 → 丢弃这张图。
     */
    static boolean keep(List<Key> before, String frontBefore, boolean listedAfter, List<Key> after, String frontAfter,
                        boolean quiet) {
        if (!quiet) return false;
        if (!mayCapture(listedAfter, after, frontAfter)) return false;
        return before != null && before.equals(after) && frontBefore != null && frontBefore.equals(frontAfter);
    }
}
