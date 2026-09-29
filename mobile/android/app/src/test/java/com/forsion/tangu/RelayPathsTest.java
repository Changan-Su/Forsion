package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 中继路径闸(P1-K8,INTEGRATION R-06)。用例表与 JS 侧共用:src/test/resources/relay-paths.json
 * (node:mobile/scripts/relay-paths.test.cjs)。每条带 native 期望的用例在这里跑 RelayPaths.check(id, path)。
 */
public class RelayPathsTest {
    private static JSONObject table() throws Exception {
        try (InputStream in = RelayPathsTest.class.getClassLoader().getResourceAsStream("relay-paths.json")) {
            if (in == null) throw new AssertionError("relay-paths.json 不在测试 classpath 上");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    @Test
    public void sharedTableNativeColumn() throws Exception {
        JSONArray cases = table().getJSONArray("cases");
        List<String> bad = new ArrayList<>();
        int checked = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            if (!c.has("native")) continue;
            checked++;
            boolean want = c.getBoolean("native");
            boolean got = RelayPaths.check(c.getString("id"), c.getString("path"));
            if (got != want) bad.add(c.getString("name") + ": want " + want + " got " + got);
        }
        // 仪器自检:表确实被读到、native 列够多
        assertTrue("native 用例太少: " + checked, checked >= 30);
        assertEquals("与共用用例表不符:\n  " + String.join("\n  ", bad), 0, bad.size());
    }

    @Test
    public void relayCasesAcceptedNatively() throws Exception {
        // js=relay 的每条,原生也必须放行(两侧同判的最低保证)
        JSONArray cases = table().getJSONArray("cases");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            if (!"relay".equals(c.optString("js"))) continue;
            assertTrue(c.getString("name"), RelayPaths.check(c.getString("id"), c.getString("path")));
        }
    }

    @Test
    public void pathLengthCap() {
        StringBuilder b = new StringBuilder("/engine/");
        while (b.length() <= RelayPaths.MAX_PATH) b.append('a');
        assertTrue(!RelayPaths.checkPath(b.toString()));
        assertTrue(!RelayPaths.checkPath(null));
    }

    @Test
    public void apiBaseGate() {
        assertEquals("https://api.forsion.net/api", RelayPaths.checkApiBase("https://api.forsion.net/api/"));
        assertEquals("http://localhost:8788/api", RelayPaths.checkApiBase("http://localhost:8788/api"));
        assertEquals("http://10.0.2.2:3001/api", RelayPaths.checkApiBase("http://10.0.2.2:3001/api"));
        assertNull(RelayPaths.checkApiBase("http://evil.test/api"));
        assertNull(RelayPaths.checkApiBase("http://localhost.evil.test/api"));
        assertNull(RelayPaths.checkApiBase("https://user@host/api"));
        assertNull(RelayPaths.checkApiBase("ftp://x/api"));
        assertNull(RelayPaths.checkApiBase(null));
    }
}
