package com.forsion.tangu;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 测试用的极简 HTTP/1.1 服务器(每连接一请求、Connection: close)。Android 单测的编译 classpath 看不到
 * com.sun.net.httpserver,所以自己在 ServerSocket 上拼 —— 只够 UnitRelayTest 用:请求行 + 头 + Content-Length 体;
 * 响应先写状态行与头,之后给原始输出流(不写 Content-Length = 读到 EOF 为止,正好模拟 SSE)。
 */
final class MiniHttp implements AutoCloseable {
    static final class Req {
        String method;
        String target;
        final Map<String, String> headers = new HashMap<>();
        String body;
    }

    interface Res {
        /** 写状态行与头;len < 0 = 不写 Content-Length(读到关连接为止)。 */
        OutputStream start(int status, Map<String, String> headers, long len) throws IOException;
    }

    interface Handler {
        void handle(Req req, Res res) throws Exception;
    }

    private final ServerSocket ss;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile boolean closed;

    MiniHttp(Handler h) throws IOException {
        ss = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        pool.execute(() -> {
            while (!closed) {
                try {
                    Socket s = ss.accept();
                    pool.execute(() -> serve(s, h));
                } catch (IOException e) {
                    if (closed) return;
                }
            }
        });
    }

    int port() {
        return ss.getLocalPort();
    }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) >= 0; ) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
        }
        return new String(b.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private void serve(Socket s, Handler h) {
        try (Socket sock = s) {
            InputStream in = sock.getInputStream();
            Req r = new Req();
            String[] first = line(in).split(" ");
            if (first.length < 2) return;
            r.method = first[0];
            r.target = first[1];
            for (String l; !(l = line(in)).isEmpty(); ) {
                int i = l.indexOf(':');
                if (i > 0) r.headers.put(l.substring(0, i).trim().toLowerCase(Locale.ROOT), l.substring(i + 1).trim());
            }
            int len = Integer.parseInt(r.headers.getOrDefault("content-length", "0"));
            byte[] body = new byte[len];
            for (int off = 0; off < len; ) {
                int n = in.read(body, off, len - off);
                if (n < 0) break;
                off += n;
            }
            r.body = new String(body, StandardCharsets.UTF_8);
            OutputStream out = sock.getOutputStream();
            h.handle(r, (status, headers, n) -> {
                StringBuilder b = new StringBuilder("HTTP/1.1 ").append(status).append(" X\r\n");
                Map<String, String> all = new LinkedHashMap<>(headers);
                all.put("Connection", "close");
                if (n >= 0) all.put("Content-Length", String.valueOf(n));
                for (Map.Entry<String, String> e : all.entrySet()) b.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
                b.append("\r\n");
                out.write(b.toString().getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                return out;
            });
            out.flush();
        } catch (Exception ignored) {
            // 客户端断开等
        }
    }

    @Override
    public void close() throws IOException {
        closed = true;
        ss.close();
        pool.shutdownNow();
    }
}
