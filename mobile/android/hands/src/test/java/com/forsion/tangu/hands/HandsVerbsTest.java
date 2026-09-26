package com.forsion.tangu.hands;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

/**
 * HandsVerbs 纯逻辑单测(JVM):exec json 解析、configure 文案校验(含 {minutes})、参数取值。
 * 契约 §9.2、§9.5、§6。
 */
public class HandsVerbsTest {

    @Test
    public void parseStages() {
        HandsVerbs.Cmd lease = HandsVerbs.parse("{\"stage\":\"lease\",\"deadline\":123}");
        assertNotNull(lease);
        assertEquals("lease", lease.stage);
        assertEquals(123, lease.deadline);

        HandsVerbs.Cmd run = HandsVerbs.parse("{\"stage\":\"run\",\"op\":\"tap\",\"args\":{\"node\":3,\"obs\":7}}");
        assertNotNull(run);
        assertEquals("tap", run.op);
        assertEquals(3, HandsVerbs.handle(run.args));
        assertEquals(7, HandsVerbs.obs(run.args));

        assertNull(HandsVerbs.parse("{\"stage\":\"bogus\"}"));
        assertNull(HandsVerbs.parse("not json"));
        assertNull(HandsVerbs.parse(null));
    }

    /** 账号键(09-26 二轮评审 P1 #5):只收 32–64 位小写 hex;缺失 / 不合格 → null(lease / run 据此 fail closed)。 */
    @Test
    public void parseAcct() {
        String k = "0123456789abcdef0123456789abcdef";
        assertEquals(k, HandsVerbs.parse("{\"stage\":\"lease\",\"acct\":\"" + k + "\"}").acct);
        assertNull(HandsVerbs.parse("{\"stage\":\"run\",\"op\":\"observe\"}").acct);
        assertNull(HandsVerbs.parse("{\"stage\":\"lease\",\"acct\":\"Bearer eyJhbGciOi\"}").acct);
        assertNull(HandsVerbs.parse("{\"stage\":\"lease\",\"acct\":\"0123\"}").acct);
        assertNull(HandsVerbs.parse("{\"stage\":\"lease\",\"acct\":123}").acct);
    }

    @Test
    public void parseStart() {
        HandsVerbs.Cmd s = HandsVerbs.parse("{\"stage\":\"start\",\"intent\":\"intent://x\",\"pkg\":\"com.a\",\"app\":\"A\"}");
        assertNotNull(s);
        assertEquals("intent://x", s.intentUri);
        assertEquals("com.a", s.pkg);
        assertEquals("A", s.app);
    }

    @Test
    public void checkStringsRequiresMinutes() {
        Map<String, String> s = new HashMap<>();
        s.put("leaseTitle", "T");
        s.put("leaseBody", "For 10 minutes"); // 缺 {minutes}
        s.put("leaseAllow", "Allow");
        s.put("leaseDeny", "Not now");
        s.put("pillLabel", "Operating");
        s.put("pillStop", "Stop");
        assertEquals("leaseBody must contain {minutes}", HandsVerbs.checkStrings(s));
        s.put("leaseBody", "For {minutes} minutes Tangu can act.");
        assertNull(HandsVerbs.checkStrings(s));
        assertEquals("For 10 minutes Tangu can act.", HandsVerbs.fillMinutes(s.get("leaseBody"), 10));
    }

    @Test
    public void checkStringsMissingKey() {
        Map<String, String> s = new HashMap<>();
        s.put("leaseTitle", "T");
        assertTrue(HandsVerbs.checkStrings(s).startsWith("missing string"));
    }

    @Test
    public void argValidation() throws Exception {
        JSONObject a = new JSONObject();
        a.put("direction", "down");
        assertEquals("down", HandsVerbs.scrollDir(a));
        a.put("direction", "diagonal");
        assertNull(HandsVerbs.scrollDir(a));

        JSONObject k = new JSONObject();
        k.put("key", "back");
        assertEquals("back", HandsVerbs.key(k));
        k.put("key", "power");
        assertNull(HandsVerbs.key(k));

        JSONObject h = new JSONObject();
        h.put("node", 0);
        assertEquals(-1, HandsVerbs.handle(h)); // 0 不是合法句柄(1 起)
        h.put("node", 300);
        assertEquals(-1, HandsVerbs.handle(h)); // 越界
        h.put("node", 5);
        assertEquals(5, HandsVerbs.handle(h));
        assertEquals(0, HandsVerbs.handle(new JSONObject())); // 缺省 = 无句柄
    }

    @Test
    public void textTruncates() throws Exception {
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < HandsVerbs.MAX_TEXT + 100; i++) big.append('x');
        JSONObject a = new JSONObject();
        a.put("text", big.toString());
        assertEquals(HandsVerbs.MAX_TEXT, HandsVerbs.text(a).length());
        assertNull(HandsVerbs.text(new JSONObject()));
    }
}
