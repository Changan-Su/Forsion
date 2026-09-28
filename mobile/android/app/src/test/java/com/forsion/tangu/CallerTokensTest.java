package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Before;
import org.junit.Test;

/** 调用方票缓存与自愈(P1-K8;INTEGRATION R-02 / R-03)、失败归类(评审 P1)、移除后的闩(评审 P2)。时钟注入。 */
public class CallerTokensTest {
    FakeHub hub;
    FakeHub.MemStore store;
    FakeHub.TestClock clock;
    FakeHub.Env env;
    UnitRegistrar reg;
    CallerTokens tokens;

    @Before
    public void setUp() {
        hub = new FakeHub();
        store = new FakeHub.MemStore();
        clock = new FakeHub.TestClock();
        env = new FakeHub.Env();
        reg = new UnitRegistrar(env, hub, store, clock, FakeHub.LOG);
        tokens = new CallerTokens(reg, hub, clock, FakeHub.LOG);
    }

    private int mints() {
        return hub.mints();
    }

    private String codeOf(ThrowingRunnable r) {
        try {
            r.run();
        } catch (UnitError e) {
            return e.code;
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        fail("应当抛 UnitError");
        return null;
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    @Test
    public void cachesUntilSixtySecondsBeforeExpiry() throws Exception {
        String t1 = tokens.get(false);
        assertEquals(1, mints());
        FakeHub.Call c = hub.calls.get(hub.calls.size() - 1);
        assertTrue("换票带 X-Unit-Caller-Secret", c.headers.get("X-Unit-Caller-Secret") != null);
        assertTrue("换票不带设备密钥", c.headers.get("X-Unit-Secret") == null);
        clock.advance(539_000); // 600 − 60 − 1
        hub.serverNowMs += 539_000;
        assertEquals(t1, tokens.get(false));
        assertEquals(1, mints());
        clock.advance(2_000);
        hub.serverNowMs += 2_000;
        String t2 = tokens.get(false);
        assertNotEquals(t1, t2);
        assertEquals(2, mints());
    }

    @Test
    public void phoneClockSkewDoesNotCauseRemintStorm() throws Exception {
        clock.wall += 20 * 60_000L; // 手机时钟快 20 分钟:按手机时钟算,每张票一到手就「过期」了
        tokens.get(false);
        tokens.get(false);
        tokens.get(false);
        assertEquals("按服务器 Date 头算剩余有效期", 1, mints());
    }

    @Test
    public void withoutDateHeaderFallsBackToLocalClockCapped() throws Exception {
        hub.sendDate = false;
        clock.wall -= 60 * 60_000L; // 手机慢一小时:剩余有效期算出来 1h+,必须被封顶 600s
        tokens.get(false);
        clock.advance(541_000);
        tokens.get(false);
        assertEquals(2, mints());
    }

    @Test
    public void forceRefreshMintsANewOne() throws Exception {
        String t1 = tokens.get(false);
        String t2 = tokens.get(true);
        assertNotEquals(t1, t2);
        assertEquals(2, mints());
    }

    @Test
    public void accountSwitchNeverReusesTheOtherAccountsTicket() throws Exception {
        String a = tokens.get(false);
        env.token = UnitIdentityTest.jwt("{\"userId\":\"u2\"}");
        String b = tokens.get(false);
        assertNotEquals(a, b);
        assertEquals(2, mints());
        FakeHub.Call last = hub.calls.get(hub.calls.size() - 1);
        assertTrue(last.headers.get("Authorization").endsWith(env.token));
    }

    @Test
    public void callerSecretMismatchRotatesOnceKeepsUnitId() throws Exception {
        String id = reg.ensure().identity.unitId;
        hub.rows.get(id).callerHash = FakeHub.sha("someone-else"); // 服务器那头的 caller secret 变了(别处轮换过 / 本地丢了一次写)
        tokens.get(false);
        assertEquals("轮换一次", 1, hub.count("POST", "/units/[^/]+/caller-secret") - 1 /* 登记那次 */);
        assertEquals("保住 unit id", id, reg.current().unitId);
        assertEquals("没有重新登记", 1, hub.count("POST", "/units/register"));
    }

    @Test
    public void rotationWithBadDeviceSecretReRegistersAndDropsStaleRow() throws Exception {
        String id = reg.ensure().identity.unitId;
        hub.rows.get(id).callerHash = FakeHub.sha("x");
        hub.rows.get(id).secretHash = FakeHub.sha("y"); // 设备密钥也对不上 → 轮换 403 UNIT_SECRET_MISMATCH
        tokens.get(false);
        assertEquals(2, hub.count("POST", "/units/register"));
        assertNotEquals(id, reg.current().unitId);
        assertTrue("旧行被删", !hub.rows.containsKey(id));
    }

    @Test
    public void unitNotFoundReRegistersAtMostOncePerTenMinutes() throws Exception {
        String id = reg.ensure().identity.unitId;
        hub.rows.remove(id); // 本机那行被人在名册里删了
        tokens.get(false);
        String id2 = reg.current().unitId;
        assertNotEquals(id, id2);
        assertEquals(2, hub.count("POST", "/units/register"));
        hub.rows.remove(id2);
        tokens.invalidate();
        try {
            tokens.get(false);
            fail("10 分钟内第二次重新登记应被节流");
        } catch (UnitError e) {
            assertEquals("caller_unavailable", e.code);
        }
        assertEquals(2, hub.count("POST", "/units/register"));
        clock.advance(UnitRegistrar.REREGISTER_MIN_MS);
        tokens.get(false);
        assertEquals(3, hub.count("POST", "/units/register"));
    }

    @Test
    public void oldServerWithoutRouteIsUnsupported() throws Exception {
        hub.oldServer = true;
        assertEquals("caller_unsupported", codeOf(() -> tokens.get(false)));
        assertEquals("探测先挡住:名册里一行都没建", 0, hub.count("POST", "/units/register"));
        // 已登记过、server 回滚成老版本:换票撞无 code 的 404 同样 unsupported
        hub.oldServer = false;
        reg.ensure();
        hub.oldServer = true;
        assertEquals("caller_unsupported", codeOf(() -> tokens.get(false)));
    }

    /**
     * 评审 P1:短暂失败(断网、网关 5xx、限流)不是终局 —— 归 network,渲染层当离线暂停、网络回来就续;
     * 原先一律 caller_unavailable,K6 的健康状态机把它当终局,一次断网就永久杀掉目标与 run 流。
     */
    @Test
    public void transientMintFailuresAreNetworkNotTerminal() throws Exception {
        reg.ensure();
        for (int st : new int[]{500, 502, 503, 504, 429}) {
            hub.mintStatus = st;
            assertEquals("换票 " + st, "network", codeOf(() -> tokens.get(false)));
        }
        hub.mintStatus = 0;
        hub.networkDown = new java.io.IOException("offline");
        assertEquals("换票断网", "network", codeOf(() -> tokens.get(false)));
        hub.networkDown = null;
        assertTrue("网络回来就好", tokens.get(false).startsWith("fuc1."));
    }

    @Test
    public void transientFailuresDuringLazyRegistrationAreNetwork() throws Exception {
        hub.registerStatus = 503;
        assertEquals("登记 503", "network", codeOf(() -> tokens.get(false)));
        hub.registerStatus = 0;
        hub.networkDown = new java.io.IOException("offline");
        assertEquals("登记断网", "network", codeOf(() -> tokens.get(false)));
        hub.networkDown = null;
        hub.failCallerSecret = 502;
        assertEquals("caller-secret 502", "network", codeOf(() -> tokens.get(false)));
        assertTrue("半截行回收了", hub.rows.isEmpty());
    }

    @Test
    public void transientFailuresWhileHealingAreNetwork() throws Exception {
        String id = reg.ensure().identity.unitId;
        hub.rows.get(id).callerHash = FakeHub.sha("elsewhere"); // 换票 → 403 MISMATCH → 轮换
        hub.networkDown = new java.io.IOException("offline");
        hub.networkDownPath = "/units/[^/]+/caller-secret"; // 轮换那一步断网
        assertEquals("轮换途中断网", "network", codeOf(() -> tokens.get(false)));
        hub.networkDown = null;
        hub.networkDownPath = null;
        hub.failCallerSecret = 500;
        assertEquals("轮换 500", "network", codeOf(() -> tokens.get(false)));
        tokens.get(false);
        assertEquals("恢复后照常轮换,id 不变", id, reg.current().unitId);
    }

    /** forsion_token 被 server 拒了(过期 / 吊销):交 auth_expired,JS 合成 401 让渲染层复检账号,不是「身份取不到」。 */
    @Test
    public void unauthorizedIsAuthExpired() throws Exception {
        reg.ensure();
        hub.mintStatus = 401;
        assertEquals("换票 401", "auth_expired", codeOf(() -> tokens.get(false)));
        hub.mintStatus = 0;
        FakeHub h2 = new FakeHub();
        h2.registerStatus = 401;
        UnitRegistrar r2 = new UnitRegistrar(env, h2, new FakeHub.MemStore(), clock, FakeHub.LOG);
        CallerTokens t2 = new CallerTokens(r2, h2, clock, FakeHub.LOG);
        assertEquals("登记 401", "auth_expired", codeOf(() -> t2.get(false)));
    }

    /** 明确的拒绝才是终局 caller_unavailable:自愈后仍被拒、设备类型无效。 */
    @Test
    public void definitiveRefusalsStayUnavailable() throws Exception {
        reg.ensure();
        hub.mintStatus = 400; // K1:UNIT_KIND_INVALID
        assertEquals("caller_unavailable", codeOf(() -> tokens.get(false)));
        hub.mintStatus = 403;
        assertEquals("caller_unavailable", codeOf(() -> tokens.get(false)));
    }

    /**
     * 评审 P2:「移除本机」之后,还在飞的中继请求撞 403 / 404 → 自愈 → 悄悄登记出新身份、电脑上又弹确认。
     * 移除后懒登记与自愈一律拒绝,直到用户显式 ensure()。
     */
    @Test
    public void afterForgetLazyRegistrationAndHealingAreRefused() throws Exception {
        UnitRegistrar.Account a = reg.account();
        UnitIdentity stale = reg.ensure().identity;
        tokens.get(false);
        reg.forget(true);
        tokens.invalidate();
        assertEquals("懒登记被拒", "caller_unavailable", codeOf(() -> tokens.get(false)));
        assertEquals("在途请求:移除前取到的身份撞 404 → 重新登记被拒", "caller_unavailable", codeOf(() -> reg.reRegister(a, stale, false)));
        assertEquals("在途请求:轮换也被拒(不把旧条目轮换回来)", "caller_unavailable", codeOf(() -> reg.rotateCallerSecret(a, stale)));
        assertEquals("一次都没重新登记", 1, hub.count("POST", "/units/register"));
        assertTrue("名册里没有行", hub.rows.isEmpty());
        assertEquals(null, reg.current());
        // 用户在弹层里点电脑 = 显式 ensure():解闩、登记新身份
        String fresh = reg.ensure().identity.unitId;
        assertNotEquals(stale.unitId, fresh);
        assertTrue(tokens.get(false).startsWith("fuc1."));
    }

    @Test
    public void forgetLatchIsPerAccount() throws Exception {
        reg.ensure();
        reg.forget(true);
        env.token = UnitIdentityTest.jwt("{\"userId\":\"u2\"}");
        assertTrue("B 账号不受 A 的移除影响", tokens.get(false).startsWith("fuc1."));
    }

    @Test
    public void notSignedInIsUnavailable() {
        env.token = null;
        try {
            tokens.get(false);
            fail();
        } catch (UnitError e) {
            assertEquals("caller_unavailable", e.code);
        }
    }
}
