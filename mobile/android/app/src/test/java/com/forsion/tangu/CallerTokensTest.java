package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Before;
import org.junit.Test;

/** 调用方票缓存与自愈(P1-K8;INTEGRATION R-02 / R-03)。时钟注入。 */
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
        return hub.count("POST", "/units/[^/]+/caller-token");
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
        try {
            tokens.get(false);
            fail();
        } catch (UnitError e) {
            assertEquals("caller_unsupported", e.code);
        }
    }

    @Test
    public void serverErrorsAndNetworkAreUnavailable() throws Exception {
        reg.ensure();
        hub.mintStatus = 500;
        try {
            tokens.get(false);
            fail();
        } catch (UnitError e) {
            assertEquals("caller_unavailable", e.code);
        }
        hub.mintStatus = 0;
        hub.networkDown = new java.io.IOException("offline");
        try {
            tokens.get(false);
            fail();
        } catch (UnitError e) {
            assertEquals("caller_unavailable", e.code);
        }
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
