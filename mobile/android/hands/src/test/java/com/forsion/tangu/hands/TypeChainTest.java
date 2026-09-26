package com.forsion.tangu.hands;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * TypeChain 单测(JVM):输入链的每一步变更之前都问 guard,guard 一假整条链就停(契约 §9.5,09-26 二轮评审 P1)。
 * 负对照:旧实现只在开头过一次闸,之后聚焦 / 点击 / 清空 / 三次重试 / 写剪贴板 / 粘贴一路做到底 —— 下面的「停止之后不再有任何变更」都会红。
 * 跑法:cd mobile/android && ./gradlew :hands:testDebugUnitTest
 */
public class TypeChainTest {

    /** 记下每一步变更的假输入框。setTextOk=false 模拟 ACTION_SET_TEXT 一直被拒(走剪贴板兜底)。 */
    static final class FakeField implements TypeChain.Field {
        final List<String> log = new ArrayList<>();
        final boolean setTextOk;
        String value = "";

        FakeField(boolean setTextOk) {
            this.setTextOk = setTextOk;
        }

        @Override public boolean focus() { log.add("focus"); return true; }
        @Override public boolean click() { log.add("click"); return true; }
        @Override public boolean select(int s, int e) { log.add("select"); return true; }
        @Override public boolean setText(String s) {
            log.add("setText:" + s);
            if (setTextOk || s.isEmpty()) value = s;
            return setTextOk;
        }
        @Override public String text() { return value; }
        @Override public boolean paste() { log.add("paste"); return true; }
    }

    /** 允许前 n 次询问,之后一律拒(模拟用户在第 n 步之后点了「停止」)。记录被问了几次。 */
    static final class CountingGuard implements TypeChain.Guard {
        int allowed;
        int asked;

        CountingGuard(int allowed) {
            this.allowed = allowed;
        }

        @Override public boolean ok() {
            asked++;
            return asked <= allowed;
        }
    }

    /** 剪贴板假实现:与真身同口径 —— 写之前(主线程那一步里)再问一次 guard。 */
    static final class FakeClip implements TypeChain.Clip {
        final List<String> writes = new ArrayList<>();

        @Override public boolean set(String text, TypeChain.Guard guard) {
            if (!guard.ok()) return false;
            writes.add(text);
            return true;
        }
    }

    private static final TypeChain.Sleeper NO_SLEEP = ms -> { };

    @Test
    public void happyPathSetsText() {
        FakeField f = new FakeField(true);
        FakeClip clip = new FakeClip();
        TypeChain.Outcome o = TypeChain.run(f, clip, "wifi", false, () -> true, NO_SLEEP);
        assertEquals(TypeChain.Outcome.DONE, o);
        assertEquals("wifi", f.value);
        assertTrue(clip.writes.isEmpty());
    }

    @Test
    public void appendKeepsExistingText() {
        FakeField f = new FakeField(true);
        f.value = "hello ";
        assertEquals(TypeChain.Outcome.DONE, TypeChain.run(f, new FakeClip(), "world", true, () -> true, NO_SLEEP));
        assertEquals("hello world", f.value);
    }

    /** 每一种「在第 k 次询问之后停止」都不许再有任何变更,并回 STOPPED。 */
    @Test
    public void stopsBeforeEveryMutation() {
        // 不设防时整条链(SET_TEXT 一直失败:三次重试 + 剪贴板 + 粘贴)一共几步变更
        FakeField full = new FakeField(false);
        FakeClip fullClip = new FakeClip();
        assertEquals(TypeChain.Outcome.DONE, TypeChain.run(full, fullClip, "secret", false, () -> true, NO_SLEEP));
        int total = full.log.size() + fullClip.writes.size();
        assertTrue(full.log.contains("paste"));
        for (int k = 0; k <= total + 2; k++) {
            FakeField f = new FakeField(false);
            FakeClip clip = new FakeClip();
            CountingGuard g = new CountingGuard(k);
            TypeChain.Outcome o = TypeChain.run(f, clip, "secret", false, g, NO_SLEEP);
            int mutations = f.log.size() + clip.writes.size();
            // 每一步变更之前都各问过一次且被放行:允许 k 次 → 最多 k 步变更(旧实现只问一次,k=1 时照样做完 17 步)
            assertTrue("k=" + k + " mutations=" + mutations + " log=" + f.log, mutations <= k);
            if (k < total) assertEquals("k=" + k, TypeChain.Outcome.STOPPED, o);
        }
    }

    /** 停止发生在剪贴板写入前那一刻(主线程排队期间):剪贴板不写、不粘贴。 */
    @Test
    public void clipboardStepAsksTheGuardAgain() {
        FakeField f = new FakeField(false);
        final boolean[] entered = {false};
        final List<String> writes = new ArrayList<>();
        // 停止恰好发生在剪贴板那一步排队等主线程的时候:链自己之前的询问都放行,剪贴板实现里再问的那一次拒绝
        TypeChain.Clip clip = (text, guard) -> {
            entered[0] = true;
            if (!guard.ok()) return false;
            writes.add(text);
            return true;
        };
        TypeChain.Outcome o = TypeChain.run(f, clip, "secret", false, () -> !entered[0], NO_SLEEP);
        assertTrue(entered[0]);
        assertEquals(TypeChain.Outcome.STOPPED, o);
        assertTrue(writes.isEmpty());
        assertFalse(f.log.contains("paste"));
    }

    @Test
    public void stoppedBeforeAnything() {
        FakeField f = new FakeField(true);
        assertEquals(TypeChain.Outcome.STOPPED, TypeChain.run(f, new FakeClip(), "x", false, () -> false, NO_SLEEP));
        assertTrue(f.log.isEmpty());
    }
}
