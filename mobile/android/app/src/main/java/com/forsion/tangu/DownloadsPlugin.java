package com.forsion.tangu;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * P1-DL:把字节存进系统公共「下载」(MediaStore.Downloads,Android 10 / API 29+,不要任何存储权限)。
 *
 * 为什么要原生:Capacitor 的 WebView 没有 DownloadListener,`<a download href=blob:>` 在 App 里点了什么都不发生 ——
 * 手机上「本会话的文件」的下载键是个哑弹(浏览器台架却是绿的)。JS 侧:mobile/src/saveDownload.ts → window.tangu.saveDownload,
 * 调用方 desktop/frontend/src/services/nativeDownload.ts(downloadWorkspaceFile 优先走它,缺席回落 `<a download>`)。
 *
 * 分块协议(不是一次性 save({base64})):Capacitor 桥把一次调用整个当一条 JSON 字符串递进 Java 堆,再解析一遍、再解 base64 ——
 * 50 MB 的文件峰值是好几百 MB,清单里没有 largeHeap,单发必 OOM。分块后 Java 这侧只占 O(块)(JS 每块 1.5 MB)。
 *
 * | 方法                         | 返回 / reject code                                                  |
 * |------------------------------|---------------------------------------------------------------------|
 * | begin({name, mime, size})    | {id};unsupported_os(API < 29)/ too_large / busy / io                 |
 * | append({id, data})           | {written};data = 这一块的 base64;not_found / bad_request / too_large / io |
 * | finish({id})                 | {name}= MediaStore 实际落下的显示名(同名会被去重成 `x (1).txt`)       |
 * | abort({id})                  | {ok};删掉那条待定行                                                    |
 *
 * 上限 {@link #MAX_BYTES}(50 MB)是政策不是内存约束:JS 那侧要把整份 Blob 捏在 WebView 里,再大就该走流式(另立项)。
 * 页面重载(onPageStarted)时收掉全部未完成的条目 —— 否则一条 IS_PENDING=1 的行会在系统里挂 7 天。
 * API 26–28(minSdk 26)刻意不做:应用专属目录不是「下载」,toast 会撒谎;公共目录又要 WRITE_EXTERNAL_STORAGE 运行时权限。
 */
@CapacitorPlugin(name = "ForsionDownloads")
public class DownloadsPlugin extends Plugin {
    private static final String TAG = "ForsionDownloads";
    /** 与 JS 侧 NATIVE_DOWNLOAD_MAX_BYTES 同值(desktop/frontend/src/services/nativeDownload.ts)。 */
    static final long MAX_BYTES = 50L * 1024 * 1024;
    /** 同时未完成的条目上限:JS 每次只开一条,超了说明有泄漏,拒掉而不是越积越多。 */
    private static final int MAX_OPEN = 4;

    private static final class Pending {
        final Uri uri;
        final OutputStream out;
        long written;

        Pending(Uri uri, OutputStream out) {
            this.uri = uri;
            this.out = out;
        }
    }

    private final Map<String, Pending> open = new ConcurrentHashMap<>();
    /** 单线程:同一条目的 append 严格按序,且不占 Capacitor 所有插件共用的那条线程。 */
    private final ExecutorService io = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "forsion-downloads");
        t.setDaemon(true);
        return t;
    });

    private static final DownloadNames.MimeLookup MIME_MAP = new DownloadNames.MimeLookup() {
        @Override
        public String mimeFromExtension(String extLower) {
            return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extLower);
        }

        @Override
        public String extensionFromMime(String mime) {
            return MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        }
    };

    @Override
    public void load() {
        // ⚠️ 不能在 load() 里直接 addWebViewListener:Capacitor 7.6 的 Bridge.Builder.create() 先 new Bridge(…)(插件的 load()
        //    就在这个构造里跑),**之后**才 bridge.setWebViewListeners(builder 自己那张表) —— load() 里加进去的监听被整张换掉,
        //    静默失效(模拟器实测:重载后 .pending-* 一直在)。挪到主线程的下一拍,那时 create() 已经返回、表不会再被换。
        new Handler(Looper.getMainLooper()).post(() -> getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                io.execute(() -> {
                    int n = abortAll();
                    if (n > 0) Log.i(TAG, "page (re)load: dropped " + n + " unfinished download(s)");
                });
            }
        }));
    }

    @PluginMethod
    public void begin(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Saving to Downloads requires Android 10 or later", "unsupported_os");
            return;
        }
        final String name = DownloadNames.sanitize(call.getString("name"));
        final String mime = DownloadNames.chooseMime(name, call.getString("mime"), MIME_MAP);
        // optDouble 而不是 call.getDouble:后者不认 Long(> 2 GB 的声明值会被当成「没给」放过去)
        double declared = call.getData().optDouble("size", -1);
        if (declared > MAX_BYTES) {
            call.reject("File exceeds " + MAX_BYTES + " bytes", "too_large");
            return;
        }
        io.execute(() -> {
            if (open.size() >= MAX_OPEN) {
                call.reject("Too many unfinished downloads", "busy");
                return;
            }
            ContentResolver cr = getContext().getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = null;
            try {
                uri = cr.insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
                if (uri == null) throw new IllegalStateException("MediaStore insert returned null");
                OutputStream out = cr.openOutputStream(uri, "w");
                if (out == null) throw new IllegalStateException("MediaStore openOutputStream returned null");
                String id = UUID.randomUUID().toString();
                open.put(id, new Pending(uri, out));
                JSObject o = new JSObject();
                o.put("id", id);
                call.resolve(o);
            } catch (Exception e) {
                if (uri != null) deleteQuietly(uri);
                Log.w(TAG, "begin failed: " + e.getClass().getSimpleName());
                call.reject(e.getClass().getSimpleName(), "io");
            }
        });
    }

    @PluginMethod
    public void append(PluginCall call) {
        final String id = call.getString("id");
        final String data = call.getString("data");
        io.execute(() -> {
            Pending p = id == null ? null : open.get(id);
            if (p == null) {
                call.reject("Unknown download id", "not_found");
                return;
            }
            byte[] bytes;
            try {
                bytes = Base64.getDecoder().decode(data == null ? "" : data);
            } catch (IllegalArgumentException e) {
                drop(id);
                call.reject("Chunk is not valid base64", "bad_request");
                return;
            }
            if (p.written + bytes.length > MAX_BYTES) {
                drop(id);
                call.reject("File exceeds " + MAX_BYTES + " bytes", "too_large");
                return;
            }
            try {
                p.out.write(bytes);
                p.written += bytes.length;
                JSObject o = new JSObject();
                o.put("written", p.written);
                call.resolve(o);
            } catch (Exception e) {
                drop(id);
                Log.w(TAG, "append failed: " + e.getClass().getSimpleName());
                call.reject(e.getClass().getSimpleName(), "io");
            }
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        final String id = call.getString("id");
        io.execute(() -> {
            Pending p = id == null ? null : open.remove(id);
            if (p == null) {
                call.reject("Unknown download id", "not_found");
                return;
            }
            ContentResolver cr = getContext().getContentResolver();
            try {
                p.out.close();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(p.uri, v, null, null);
                String saved = displayName(cr, p.uri);
                JSObject o = new JSObject();
                o.put("name", saved);
                o.put("size", p.written);
                call.resolve(o);
            } catch (Exception e) {
                deleteQuietly(p.uri);
                Log.w(TAG, "finish failed: " + e.getClass().getSimpleName());
                call.reject(e.getClass().getSimpleName(), "io");
            }
        });
    }

    @PluginMethod
    public void abort(PluginCall call) {
        final String id = call.getString("id");
        io.execute(() -> {
            if (id != null) drop(id);
            JSObject o = new JSObject();
            o.put("ok", true);
            call.resolve(o);
        });
    }

    /** 只在 io 线程上调。 */
    private int abortAll() {
        List<String> ids = new ArrayList<>(open.keySet());
        for (String id : ids) drop(id);
        return ids.size();
    }

    /** 关流 + 删掉待定行。只在 io 线程上调。 */
    private void drop(String id) {
        Pending p = open.remove(id);
        if (p == null) return;
        try {
            p.out.close();
        } catch (Exception ignored) {
            // 已经坏了的流,关不上也要删行
        }
        deleteQuietly(p.uri);
    }

    private void deleteQuietly(Uri uri) {
        try {
            getContext().getContentResolver().delete(uri, null, null);
        } catch (Exception e) {
            Log.w(TAG, "delete pending row failed: " + e.getClass().getSimpleName());
        }
    }

    private static String displayName(ContentResolver cr, Uri uri) {
        try (Cursor c = cr.query(uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        }
        return "";
    }
}
