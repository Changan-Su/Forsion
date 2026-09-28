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

/** 登记流程(P1-K8,K8 §3.2):register → caller-secret → 落盘;半截回收;解不开即重登;按账号隔离;forget。 */
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
        FakeHub.Call r = hub.calls.get(0);
        JSONObject body = new JSONObject(r.body);
        assertEquals("phone", body.getString("kind"));
        assertEquals("android", body.getString("platform"));
        assertEquals("Pixel 9", body.getString("name"));
        FakeHub.Call cs = hub.calls.get(1);
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
        assertEquals(UnitRegistrar.NAME_MAX, new JSONObject(hub.calls.get(0).body).getString("name").length());
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
