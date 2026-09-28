package com.forsion.tangu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 原生中继(UnitRelay)对真 HTTP 服务器(JDK HttpServer 充当 hub 的 proxy 面)的行为(P1-K8,K8 §3.3 / §5 S2–S4 / S8)。
 * 判据都在服务器那一侧记账:收到几次请求、带了什么头。
 */
public class UnitRelayTest {
    static final String U = "0f8fad5b-d9cb-469f-a165-70867728950e";

    MiniHttp server;
    String apiBase;
    final List<Map<String, String>> seen = new CopyOnWriteArrayList<>();
    final List<String> seenPaths = new CopyOnWriteArrayList<>();
    final AtomicInteger badTicketsLeft = new AtomicInteger(0);
    volatile CountDownLatch streamGate;
    volatile CountDownLatch streamClosed;

    static final class FakeTokens implements UnitRelay.Tokens {
        int gets;
        int forced;
        int invalidated;
        UnitError fail;

        @Override
        public synchronized String get(boolean force) throws UnitError {
            if (fail != null) throw fail;
            gets++;
            if (force) forced++;
            return "fuc1.ticket" + gets;
        }

        @Override
        public synchronized void invalidate() {
            invalidated++;
        }
    }

    static final class RecSink implements UnitRelay.Sink {
        final LinkedBlockingQueue<String> events = new LinkedBlockingQueue<>();
        final ByteArrayOutputStream body = new ByteArrayOutputStream();
        final CountDownLatch closed = new CountDownLatch(1);
        volatile int status = -1;

        @Override
        public void head(int s, Map<String, String> headers) {
            status = s;
            events.add("head:" + s + ":" + new java.util.TreeMap<>(headers));
        }

        @Override
        public synchronized void chunk(byte[] buf, int off, int len) {
            body.write(buf, off, len);
            events.add("chunk:" + new String(buf, off, len, StandardCharsets.UTF_8));
        }

        @Override
        public void end() {
            events.add("end");
        }

        @Override
        public void error(String code, String message) {
            events.add("error:" + code);
        }

        @Override
        public void close() {
            closed.countDown();
        }

        List<String> drain() throws InterruptedException {
            assertTrue("sink 没有 close", closed.await(10, TimeUnit.SECONDS));
            List<String> out = new ArrayList<>();
            events.drainTo(out);
            return out;
        }
    }

    FakeTokens tokens;
    UnitRelay relay;
    volatile String bearer = "native-forsion-token";

    @Before
    public void start() throws Exception {
        server = new MiniHttp(this::handle);
        apiBase = "http://127.0.0.1:" + server.port() + "/api";
        tokens = new FakeTokens();
        relay = new UnitRelay(apiBase, () -> bearer, tokens, FakeHub.LOG);
    }

    @After
    public void stop() throws Exception {
        server.close();
    }

    private static OutputStream json(MiniHttp.Res res, int status, String body) throws java.io.IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/json");
        h.put("Set-Cookie", "x=1");
        OutputStream os = res.start(status, h, b.length);
        os.write(b);
        return os;
    }

    private void handle(MiniHttp.Req req, MiniHttp.Res res) throws Exception {
        Map<String, String> h = new HashMap<>(req.headers);
        String p = req.target;
        h.put(":body", req.body);
        h.put(":method", req.method);
        seen.add(h);
        seenPaths.add(p);
        if (p.endsWith("/proxy/engine/agent/events")) {
            Map<String, String> rh = new HashMap<>();
            rh.put("Content-Type", "text/event-stream");
            rh.put("X-Internal", "leak");
            OutputStream os = res.start(200, rh, -1);
            os.write("data: one\n\n".getBytes(StandardCharsets.UTF_8));
            os.flush();
            try {
                CountDownLatch g = streamGate;
                if (g != null) g.await(10, TimeUnit.SECONDS);
                os.write("data: two\n\n".getBytes(StandardCharsets.UTF_8));
                os.flush();
            } catch (Exception e) {
                CountDownLatch c = streamClosed;
                if (c != null) c.countDown();
            }
            return;
        }
        if (p.endsWith("/proxy/engine/agent/redirect")) {
            res.start(302, Collections.singletonMap("Location", "https://evil.test/steal"), 0);
            return;
        }
        if (h.get("x-forsion-caller") != null && badTicketsLeft.getAndDecrement() > 0) {
            json(res, 403, "{\"detail\":\"bad\",\"code\":\"UNIT_CALLER_INVALID\"}");
            return;
        }
        if (p.endsWith("/proxy/engine/agent/forbidden")) {
            json(res, 403, "{\"code\":\"REMOTE_SESSIONS_OFF\"}");
            return;
        }
        json(res, 200, "{\"ok\":true,\"path\":\"" + p + "\"}");
    }

    private static Map<String, String> jsHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("Accept", "application/json");
        h.put("content-type", "application/json");
        h.put("Authorization", "Bearer js-decoy");
        h.put("X-Forsion-Caller", "js-forged");
        h.put("x-forsion-remote-caller", "forged");
        h.put("Cookie", "c=1");
        return h;
    }

    @Test
    public void rebuildsHeadersFromScratch() throws Exception {
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("r1", U, "/engine/agent/runs", "POST", jsHeaders(), "{\"a\":1}"), s);
        List<String> ev = s.drain();
        assertEquals("[head:200:{content-type=application/json}, chunk:{\"ok\":true,\"path\":\"/api/units/" + U + "/proxy/engine/agent/runs\"}, end]", ev.toString());
        Map<String, String> h = seen.get(0);
        assertEquals("Bearer native-forsion-token", h.get("authorization"));
        assertEquals("fuc1.ticket1", h.get("x-forsion-caller"));
        assertNull(h.get("x-forsion-remote-caller"));
        assertNull(h.get("cookie"));
        assertEquals("application/json", h.get("content-type"));
        assertEquals("{\"a\":1}", h.get(":body"));
        assertEquals("POST", h.get(":method"));
    }

    @Test
    public void badPathSendsNothing() throws Exception {
        for (String p : new String[]{"/engine/../unit/mcp", "/unit/mcp", "/engine/%2e%2e/x", "//evil.test/x", "/engine#x"}) {
            RecSink s = new RecSink();
            relay.start(new UnitRelay.Req("b" + p.hashCode(), U, p, "GET", Collections.emptyMap(), null), s);
            assertEquals(p, "[error:bad_path]", s.drain().toString());
        }
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("b-upper", U.toUpperCase(), "/engine/agent", "GET", Collections.emptyMap(), null), s);
        assertEquals("[error:bad_path]", s.drain().toString());
        assertTrue("服务器一个请求都没收到", seen.isEmpty());
        assertEquals("连票都不去换", 0, tokens.gets);
    }

    @Test
    public void failClosedWhenNoTicket() throws Exception {
        tokens.fail = new UnitError("caller_unavailable", "down");
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("f1", U, "/engine/agent/sessions", "GET", Collections.emptyMap(), null), s);
        assertEquals("[error:caller_unavailable]", s.drain().toString());
        tokens.fail = new UnitError("caller_unsupported", "old");
        RecSink s2 = new RecSink();
        relay.start(new UnitRelay.Req("f2", U, "/engine/agent/sessions", "GET", Collections.emptyMap(), null), s2);
        assertEquals("[error:caller_unsupported]", s2.drain().toString());
        assertTrue("S4:取不到身份就不发匿名请求", seen.isEmpty());
    }

    @Test
    public void signedOutIsUnavailable() throws Exception {
        bearer = null;
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("so", U, "/engine/agent/sessions", "GET", Collections.emptyMap(), null), s);
        assertEquals("[error:caller_unavailable]", s.drain().toString());
        assertTrue(seen.isEmpty());
    }

    @Test
    public void badTicketRefreshesAndRetriesOnce() throws Exception {
        badTicketsLeft.set(1);
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("t1", U, "/engine/agent/sessions", "GET", jsHeaders(), null), s);
        List<String> ev = s.drain();
        assertEquals(200, s.status);
        assertEquals("head 只交了一次(重试前没交过)", 1, ev.stream().filter(e -> e.startsWith("head")).count());
        assertEquals(2, seen.size());
        assertEquals(1, tokens.forced);
        assertEquals(1, tokens.invalidated);
        assertEquals("fuc1.ticket2", seen.get(1).get("x-forsion-caller"));
    }

    @Test
    public void secondBadTicketIsHandedToJsAsIs() throws Exception {
        badTicketsLeft.set(5);
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("t2", U, "/engine/agent/sessions", "GET", Collections.emptyMap(), null), s);
        List<String> ev = s.drain();
        assertEquals(403, s.status);
        assertEquals("只重发一次", 2, seen.size());
        assertTrue(new String(s.body.toByteArray(), StandardCharsets.UTF_8).contains("UNIT_CALLER_INVALID"));
        assertEquals("end", ev.get(ev.size() - 1));
    }

    @Test
    public void otherForbiddenIsNotRetried() throws Exception {
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("t3", U, "/engine/agent/forbidden", "POST", Collections.emptyMap(), "{}"), s);
        s.drain();
        assertEquals(403, s.status);
        assertEquals(1, seen.size());
        assertTrue(new String(s.body.toByteArray(), StandardCharsets.UTF_8).contains("REMOTE_SESSIONS_OFF"));
    }

    @Test
    public void streamsChunkByChunkAndFiltersResponseHeaders() throws Exception {
        streamGate = new CountDownLatch(1);
        RecSink s = new RecSink();
        Map<String, String> h = new HashMap<>();
        h.put("accept", "text/event-stream");
        relay.start(new UnitRelay.Req("s1", U, "/engine/agent/events", "GET", h, null), s);
        String head = s.events.poll(10, TimeUnit.SECONDS);
        assertEquals("head:200:{content-type=text/event-stream}", head);
        String first = s.events.poll(10, TimeUnit.SECONDS);
        assertEquals("第一块在服务器写第二块之前就到了", "chunk:data: one\n\n", first);
        streamGate.countDown();
        List<String> rest = s.drain();
        assertEquals("[chunk:data: two\n\n, end]", rest.toString());
    }

    @Test
    public void cancelDisconnectsAndStopsEmitting() throws Exception {
        streamGate = new CountDownLatch(1);
        streamClosed = new CountDownLatch(1);
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("c1", U, "/engine/agent/events", "GET", Collections.singletonMap("accept", "text/event-stream"), null), s);
        s.events.poll(10, TimeUnit.SECONDS);
        s.events.poll(10, TimeUnit.SECONDS);
        relay.cancel("c1");
        assertTrue("取消后 sink 被 close", s.closed.await(5, TimeUnit.SECONDS));
        assertTrue("取消后不再交任何东西", s.events.isEmpty());
        streamGate.countDown();
        assertEquals(0, relay.inFlight());
    }

    @Test
    public void redirectsAreNotFollowed() throws Exception {
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("rd", U, "/engine/agent/redirect", "GET", Collections.emptyMap(), null), s);
        s.drain();
        assertEquals(302, s.status);
        assertEquals("只打了一次,没跟跳转", 1, seen.size());
    }

    @Test
    public void bodyCapAndGetWithBody() throws Exception {
        StringBuilder big = new StringBuilder(UnitRelay.MAX_BODY_BYTES + 10);
        while (big.length() <= UnitRelay.MAX_BODY_BYTES) big.append("0123456789");
        RecSink s = new RecSink();
        relay.start(new UnitRelay.Req("big", U, "/engine/agent/upload", "POST", Collections.emptyMap(), big.toString()), s);
        assertEquals("[error:too_large]", s.drain().toString());
        RecSink s2 = new RecSink();
        relay.start(new UnitRelay.Req("gb", U, "/engine/agent/x", "GET", Collections.emptyMap(), "x"), s2);
        assertEquals("[error:bad_path]", s2.drain().toString());
        RecSink s3 = new RecSink();
        relay.start(new UnitRelay.Req("tr", U, "/engine/agent/x", "TRACE", Collections.emptyMap(), null), s3);
        assertEquals("[error:bad_path]", s3.drain().toString());
        assertTrue(seen.isEmpty());
    }

    @Test
    public void concurrencyCapAnswersRelayBusy() throws Exception {
        streamGate = new CountDownLatch(1);
        List<RecSink> sinks = new ArrayList<>();
        for (int i = 0; i < UnitRelay.MAX_CONCURRENT; i++) {
            RecSink s = new RecSink();
            sinks.add(s);
            relay.start(new UnitRelay.Req("cc" + i, U, "/engine/agent/events", "GET", Collections.singletonMap("accept", "text/event-stream"), null), s);
        }
        for (RecSink s : sinks) s.events.poll(10, TimeUnit.SECONDS);
        RecSink extra = new RecSink();
        relay.start(new UnitRelay.Req("cc-extra", U, "/engine/agent/sessions", "GET", Collections.emptyMap(), null), extra);
        assertEquals("[error:relay_busy]", extra.drain().toString());
        streamGate.countDown();
        for (RecSink s : sinks) s.drain();
        assertFalse(seenPaths.stream().anyMatch(p -> p.endsWith("/agent/sessions")));
    }

    @Test
    public void duplicateIdRejected() throws Exception {
        streamGate = new CountDownLatch(1);
        RecSink a = new RecSink();
        relay.start(new UnitRelay.Req("dup", U, "/engine/agent/events", "GET", Collections.singletonMap("accept", "text/event-stream"), null), a);
        a.events.poll(10, TimeUnit.SECONDS);
        RecSink b = new RecSink();
        relay.start(new UnitRelay.Req("dup", U, "/engine/agent/sessions", "GET", Collections.emptyMap(), null), b);
        assertEquals("[error:bad_path]", b.drain().toString());
        streamGate.countDown();
        a.drain();
    }

    @Test
    public void noApiBaseIsUnsupported() throws Exception {
        UnitRelay r = new UnitRelay(null, () -> bearer, tokens, FakeHub.LOG);
        RecSink s = new RecSink();
        r.start(new UnitRelay.Req("na", U, "/engine/agent/sessions", "GET", Collections.emptyMap(), null), s);
        assertEquals("[error:caller_unsupported]", s.drain().toString());
    }
}
