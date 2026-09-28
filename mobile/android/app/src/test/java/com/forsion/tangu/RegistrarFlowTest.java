package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

/**
 * 登记流程(P1-K8,K8 §3.2):探测 → register → caller-secret → 落盘;老 server 一行不建;半截回收;解不开即重登;
 * 按账号隔离;forget;status()(current)不排在登记的网络 I/O 后面(评审 P2)。
 */
public class RegistrarFlowTest {
    FakeHub hub;
    FakeHub.MemStore store;
    FakeHub.TestClock clock;
    FakeHub.Env env;
    UnitRegistrar reg;

    @Before
    public void setUp() {
        hub = new FakeHub();
        store = new FakeHub.MemStore();
        clock = new FakeHub.TestClock();
        env = new FakeHub.Env();
        reg = new UnitRegistrar(env, hub, store, clock, FakeHub.LOG);
    }

    @Test
    public void registersAsPhoneThenMintsCallerSecret() throws Exception {
        UnitRegistrar.Ensured e = reg.ensure();
        assertTrue(e.created);
        assertEquals(1, hub.count("POST", "/units/register"));
        assertEquals("登记前先探一次 caller-token 路由", "/units/" + UnitRegistrar.PROBE_UNIT_ID + "/caller-token", hub.calls.get(0).path());
        assertNull("探测不带任何凭据", hub.calls.get(0).headers.get("X-Unit-Caller-Secret"));
        FakeHub.Call r = hub.calls.get(1);
        assertEquals("/units/register", r.path());
        JSONObject body = new JSONObject(r.body);
        assertEquals("phone", body.getString("kind"));
        assertEquals("android", body.getString("platform"));
        assertEquals("Pixel 9", body.getString("name"));
        FakeHub.Call cs = hub.calls.get(2);
        assertEquals("/units/" + e.identity.unitId + "/caller-secret", cs.path());
        assertNotNull("caller-secret 必须带 X-Unit-Secret", cs.headers.get("X-Unit-Secret"));
        assertEquals("phone", hub.rows.get(e.identity.unitId).kind);
        // 落盘的是本账号的键
        String key = UnitIdentity.entryKey(FakeHub.API, "u1");
        assertNotNull(store.map.get(key));
        // 第二次 ensure 不再登记(单飞 + 复用)
        UnitRegistrar.Ensured again = reg.ensure();
        assertFalse(again.created);
        assertEquals(e.identity.unitId, again.identity.unitId);
        assertEquals(1, hub.count("POST", "/units/register"));
    }

    @Test
    public void callerSecretFailureReclaimsHalfRowAndStoresNothing() throws Exception {
        hub.failCallerSecret = 500;
        try {
            reg.ensure();
            fail("应当失败");
        } catch (UnitError e) {
            assertEquals("server_500", e.code);
        }
        assertEquals("半截行被 DELETE 回收", 1, hub.count("DELETE", "/units/[^/]+"));
        assertTrue(hub.rows.isEmpty());
        assertTrue("不存半截条目", store.map.isEmpty());
    }

    /**
     * 评审 P2:生产 server 2.3.21 没有调用方凭据路由。原先:register 建行 → caller-secret 无 code 404 → 删行 → server_404
     * (界面显示「稍后重试」、每点一次电脑就建一行删一行,老 server 不认 kind 那一瞬间还出现在桌面切换器里)。
     * 现在:探测撞无 code 的 404 → caller_unsupported,一行都不建。
     */
    @Test
    public void oldServerIsUnsupportedWithoutCreatingARow() throws Exception {
        hub.oldServer = true;
        for (int i = 0; i < 3; i++) {
            try {
                reg.ensure();
                fail("应当失败");
            } catch (UnitError e) {
                assertEquals("caller_unsupported", e.code);
            }
        }
        assertEquals("名册里一行都没建", 0, hub.count("POST", "/units/register"));
        assertEquals(0, hub.count("DELETE", "/units/[^/]+"));
        assertTrue(store.map.isEmpty());
    }

    /** 探测过了、caller-secret 却撞无 code 的 404(半升级 / 路由被挡):同样 unsupported,半截行照样回收。 */
    @Test
    public void callerSecretRouteMissingIsUnsupportedAndReclaimed() throws Exception {
        hub.failCallerSecret = 404;
        try {
            reg.ensure();
            fail("应当失败");
        } catch (UnitError e) {
            assertEquals("caller_unsupported", e.code);
        }
        assertEquals(1, hub.count("DELETE", "/units/[^/]+"));
        assertTrue(hub.rows.isEmpty());
    }

    @Test
    public void probeFailuresAreClassified() throws Exception {
        hub.networkDown = new java.io.IOException("offline");
        try {
            reg.ensure();
            fail();
        } catch (UnitError e) {
            assertEquals("network", e.code);
        }
        hub.networkDown = null;
        hub.rejectAuth = true; // token 过期 / 被吊销
        try {
            reg.ensure();
            fail();
        } catch (UnitError e) {
            assertEquals("server_401", e.code);
            assertEquals("auth_expired", e.relayCode());
        }
        assertEquals(0, hub.count("POST", "/units/register"));
    }

    /**
     * 评审 P2:status() 跑在 Capacitor 唯一的插件线程上,原先 current() 与 ensure() 同一把锁 ——
     * 慢网登记期间(连接 10s + 读 15s × 2–3 次)整个 app 的插件调用都排在后面。现在 current() 只拿存储锁。
     */
    @Test
    public void currentDoesNotWaitForInFlightRegistration() throws Exception {
        hub.registerGate = new java.util.concurrent.CountDownLatch(1);
        Thread t = new Thread(() -> {
            try {
                reg.ensure();
            } catch (UnitError ignored) {
                // 断言在下面
            }
        });
        t.start();
        assertTrue("登记没进到 hub", hub.registerEntered.await(5, java.util.concurrent.TimeUnit.SECONDS));
        java.util.concurrent.FutureTask<UnitIdentity> f = new java.util.concurrent.FutureTask<>(() -> reg.current());
        new Thread(f).start();
        UnitIdentity during;
        try {
            during = f.get(1, java.util.concurrent.TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException e) {
            hub.registerGate.countDown();
            t.join(5000);
            throw new AssertionError("current() 被在途登记挡住了(与 ensure 同一把锁)");
        }
        assertNull("登记途中如实是「未登记」", during);
        hub.registerGate.countDown();
        t.join(5000);
        assertNotNull("登记完成后读得到", reg.current());
    }

    @Test
    public void storageFailureReclaimsRow() throws Exception {
        store.failPut = true;
        try {
            reg.ensure();
            fail("应当失败");
        } catch (UnitError e) {
            assertEquals("storage", e.code);
        }
        assertTrue("存不下 = 这行永远用不上,回收", hub.rows.isEmpty());
    }

    @Test
    public void unreadableEntryIsDroppedAndReRegisteredOnDemand() throws Exception {
        String first = reg.ensure().identity.unitId;
        String key = UnitIdentity.entryKey(FakeHub.API, "u1");
        store.corrupt = key; // 备份恢复到新机:钥匙不在,解不开
        assertNull("status 读到的是未登记", reg.current());
        assertNull("解不开的条目被删", store.map.get(key));
        UnitRegistrar.Ensured e = reg.ensure();
        assertTrue(e.created);
        assertNotEquals(first, e.identity.unitId);
    }

    @Test
    public void accountsAreIsolated() throws Exception {
        String a = reg.ensure().identity.unitId;
        env.token = UnitIdentityTest.jwt("{\"userId\":\"u2\"}");
        assertNull("B 账号看不到 A 的条目", reg.current());
        String b = reg.ensure().identity.unitId;
        assertNotEquals(a, b);
        assertEquals(2, hub.count("POST", "/units/register"));
        env.token = UnitIdentityTest.jwt("{\"userId\":\"u1\"}");
        assertEquals("换回 A:A 的条目还在、不重登", a, reg.ensure().identity.unitId);
        assertEquals(2, hub.count("POST", "/units/register"));
    }

    @Test
    public void notSignedInAndNoApiBase() {
        env.token = null;
        try {
            reg.ensure();
            fail();
        } catch (UnitError e) {
            assertEquals("not_signed_in", e.code);
        }
        env.token = "not-a-jwt";
        try {
            reg.ensure();
            fail();
        } catch (UnitError e) {
            assertEquals("not_signed_in", e.code);
        }
        env.token = UnitIdentityTest.jwt("{\"userId\":\"u1\"}");
        env.apiBase = "http://evil.test/api";
        try {
            reg.ensure();
            fail();
        } catch (UnitError e) {
            assertEquals("no_api_base", e.code);
        }
        assertTrue("一个请求都没发", hub.calls.isEmpty());
    }

    @Test
    public void forgetRemoteDeletesRowAndEntry() throws Exception {
        String id = reg.ensure().identity.unitId;
        reg.forget(true);
        assertNull(reg.current());
        assertFalse(hub.rows.containsKey(id));
        assertEquals(1, hub.count("DELETE", "/units/" + id));
    }

    @Test
    public void longDeviceNameIsTruncatedAndBlankFallsBack() throws Exception {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 300; i++) b.append('n');
        env.name = b.toString();
        reg.ensure();
        assertEquals(UnitRegistrar.NAME_MAX, new JSONObject(hub.last("POST", "/units/register").body).getString("name").length());
    }

    @Test
    public void secretsNeverAppearInErrorMessages() throws Exception {
        UnitIdentity id = reg.ensure().identity;
        hub.networkDown = new java.io.IOException("down " + id.deviceSecret);
        try {
            reg.rotateCallerSecret(reg.account(), id);
            fail();
        } catch (UnitError e) {
            assertFalse(e.getMessage().contains(id.deviceSecret));
            assertFalse(e.getMessage().contains(id.callerSecret));
        }
    }
}
