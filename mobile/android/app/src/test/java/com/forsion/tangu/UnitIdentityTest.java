package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** JwtUserId + EntryKey + 条目 JSON(P1-K8,K8 §6 的 JwtUserIdTest / EntryKeyTest 合在这里)。 */
public class UnitIdentityTest {
    static String jwt(String payloadJson) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        return e.encodeToString("{\"alg\":\"HS256\"}".getBytes(StandardCharsets.UTF_8)) + "."
                + e.encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8)) + ".sig";
    }

    @Test
    public void userIdFromJwt() {
        assertEquals("u_42", UnitIdentity.userIdFromJwt(jwt("{\"userId\":\"u_42\",\"username\":\"x\"}")));
        assertEquals("7", UnitIdentity.userIdFromJwt(jwt("{\"userId\":7}")));
        assertNull("没有 userId", UnitIdentity.userIdFromJwt(jwt("{\"sub\":\"u\"}")));
        assertNull("userId 为空", UnitIdentity.userIdFromJwt(jwt("{\"userId\":\"  \"}")));
        assertNull("不是三段", UnitIdentity.userIdFromJwt("plain-token"));
        assertNull("payload 不是 JSON", UnitIdentity.userIdFromJwt("a.@@@.c"));
        assertNull(UnitIdentity.userIdFromJwt(null));
    }

    @Test
    public void entryKeyIsolatesAccountsAndHosts() {
        String a = UnitIdentity.entryKey("https://api.forsion.net/api", "u1");
        assertEquals(a, UnitIdentity.entryKey("https://api.forsion.net/api", "u1"));
        assertNotEquals("换号必须换键", a, UnitIdentity.entryKey("https://api.forsion.net/api", "u2"));
        assertNotEquals("换服务器必须换键", a, UnitIdentity.entryKey("https://self.host/api", "u1"));
        assertTrue(a.matches("^acct\\.[0-9a-f]{64}$"));
        // 拼接歧义:(apiBase="a|b", user="c") 与 (apiBase="a", user="b|c") 不该撞——apiBase 里不会有 '|'(checkApiBase 挡住空白,
        // 这里只钉当前行为,真撞了由 hub 按 userId 拒)
        assertNotEquals(UnitIdentity.entryKey("https://h/api", "x"), UnitIdentity.entryKey("https://h/ap", "ix"));
    }

    @Test
    public void jsonRoundTripAndRejects() {
        UnitIdentity id = new UnitIdentity("0f8fad5b-d9cb-469f-a165-70867728950e", "dev", "caller", "Pixel", 5L);
        UnitIdentity back = UnitIdentity.fromJson(id.toJson());
        assertEquals(id.unitId, back.unitId);
        assertEquals("dev", back.deviceSecret);
        assertEquals("caller", back.callerSecret);
        assertEquals("Pixel", back.name);
        assertEquals(5L, back.createdAt);
        assertNull(UnitIdentity.fromJson("{\"v\":2,\"unitId\":\"0f8fad5b-d9cb-469f-a165-70867728950e\",\"deviceSecret\":\"d\",\"callerSecret\":\"c\"}"));
        assertNull(UnitIdentity.fromJson("{\"v\":1,\"unitId\":\"NOT-A-UUID\",\"deviceSecret\":\"d\",\"callerSecret\":\"c\"}"));
        assertNull(UnitIdentity.fromJson("{\"v\":1,\"unitId\":\"0f8fad5b-d9cb-469f-a165-70867728950e\",\"deviceSecret\":\"\",\"callerSecret\":\"c\"}"));
        assertNull(UnitIdentity.fromJson("garbage"));
    }
}
