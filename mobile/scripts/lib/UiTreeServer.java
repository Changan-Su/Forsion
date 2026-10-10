import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Point;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeoutException;

/**
 * The emulator harnesses' tree reader, kept running. `uiautomator dump` starts a process and waits for a full second
 * of quiet on every read — 2 s a read, four fifths of a run (measured 2026-10-09: 395 s of 490). This prints the same
 * XML from one process that stays connected: `GET /dump?idle=<ms>` on the local socket "forsion-uitree".
 *
 * Started by scripts/lib/emu-cdp.cjs with app_process, as the shell user — the way the platform's own `uiautomator`
 * command runs. The device has ONE UI automation slot: while this is connected, `uiautomator dump` fails ("already
 * registered"). So it leaves by itself when nobody asked for 30 s (a run that died does not keep the slot), and on
 * `GET /quit`.
 *
 * The same nodes with the same attribute values as the command (`scripts/uitree-compare.cjs` holds the two side by
 * side): the active window only, views not important for accessibility included, children the user cannot see left
 * out, bounds cut to the screen and empty when off it, NAF on a button nothing names, the same characters replaced or
 * written as numbers. One value is written differently and reads the same: with a double quote in it the command
 * switches the attribute to single quotes, this writes &quot;.
 * It connects the way the command does, other accessibility services suspended
 * meanwhile — with them left running the WebView marks its off-screen nodes invisible and the tree comes out
 * shorter (2026-10-09: 68 nodes against 90 on the session list).
 * Different on purpose: `idle` is the caller's and counts from the last thing that moved (the command insists on
 * 1000 ms from its own start and fails when the screen keeps moving; this answers with what is there).
 */
public final class UiTreeServer {
    private static final String NAME = "forsion-uitree";
    private static final long LEAVE_AFTER_MS = 30_000;
    private static volatile long lastAsked = SystemClock.uptimeMillis();

    public static void main(String[] args) throws Exception {
        // The accessibility client posts to the main looper (a process without one dies in its constructor); this
        // thread ends up running it, the socket is served from another.
        Looper.prepareMainLooper();
        HandlerThread thread = new HandlerThread(NAME);
        thread.start();
        // As UiAutomationShellWrapper in the platform's uiautomator command; none of this is SDK API.
        Object connection = Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor().newInstance();
        Constructor<UiAutomation> create = UiAutomation.class.getDeclaredConstructor(Looper.class, Class.forName("android.app.IUiAutomationConnection"));
        create.setAccessible(true);
        final UiAutomation automation = create.newInstance(thread.getLooper(), connection);
        UiAutomation.class.getDeclaredMethod("connect", int.class).invoke(automation, 0); // 0 = as the command: see above
        AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS; // = `uiautomator dump` without --compressed
        automation.setServiceInfo(info);

        final LocalServerSocket server = new LocalServerSocket(NAME);
        Thread watchdog = new Thread(() -> {
            while (SystemClock.uptimeMillis() - lastAsked < LEAVE_AFTER_MS) SystemClock.sleep(1000);
            leave(automation);
        });
        watchdog.setDaemon(true);
        watchdog.start();
        Thread serving = new Thread(() -> serve(server, automation), NAME + "-serve");
        serving.setDaemon(true);
        serving.start();
        System.out.println(NAME + " ready");
        Looper.loop();
    }

    private static void serve(LocalServerSocket server, UiAutomation automation) {
        while (true) {
            try (LocalSocket socket = server.accept()) {
                lastAsked = SystemClock.uptimeMillis();
                // "GET /dump?idle=250 HTTP/1.1" — the rest of the request is not read: the answer closes the connection
                String line = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII)).readLine();
                String path = line == null ? "" : line.split(" ").length > 1 ? line.split(" ")[1] : "";
                OutputStream out = socket.getOutputStream();
                if (path.startsWith("/quit")) {
                    respond(out, 200, "bye");
                    socket.close();
                    leave(automation);
                } else if (path.startsWith("/dump")) {
                    String xml;
                    try {
                        xml = dump(automation, number(path, "idle", 500));
                    } catch (Throwable e) {
                        android.util.Log.e(NAME, "dump failed", e);
                        respond(out, 500, String.valueOf(e));
                        continue;
                    }
                    if (xml == null) respond(out, 503, "no active window"); else respond(out, 200, xml);
                } else {
                    respond(out, 200, NAME);
                }
                lastAsked = SystemClock.uptimeMillis();
            } catch (Throwable e) {
                android.util.Log.e(NAME, "request failed", e); // the next one is served
            }
        }
    }

    private static void leave(UiAutomation automation) {
        try { UiAutomation.class.getDeclaredMethod("disconnect").invoke(automation); } catch (Throwable e) { /* the system drops a dead client anyway */ }
        System.exit(0);
    }

    private static long number(String path, String key, long fallback) {
        int at = path.indexOf(key + "=");
        if (at < 0) return fallback;
        int end = at + key.length() + 1;
        while (end < path.length() && Character.isDigit(path.charAt(end))) end++;
        try { return Long.parseLong(path.substring(at + key.length() + 1, end)); } catch (NumberFormatException e) { return fallback; }
    }

    private static void respond(OutputStream out, int status, String body) throws Exception {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + status + (status == 200 ? " OK" : " Failed") + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    /** The active window as `uiautomator dump` writes it; null when there is none. */
    private static String dump(UiAutomation automation, long idle) throws Exception {
        if (idle > 0) {
            try { automation.waitForIdle(idle, Math.max(idle * 4, 2000)); } catch (TimeoutException e) { /* still moving: what is there now */ }
        }
        // A reader that lives on keeps a cache of nodes, kept current by events; the command starts with none every
        // time. Read from the app, not from memory.
        automation.clearCache();
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        if (root == null) return null;
        Object displays = Class.forName("android.hardware.display.DisplayManagerGlobal").getMethod("getInstance").invoke(null);
        Display display = (Display) displays.getClass().getMethod("getRealDisplay", int.class).invoke(displays, Display.DEFAULT_DISPLAY);
        Point size = new Point();
        display.getRealSize(size);
        StringBuilder out = new StringBuilder(1 << 16);
        out.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"").append(display.getRotation()).append("\">");
        node(root, 0, out, size.x, size.y);
        return out.append("</hierarchy>").toString();
    }

    private static void node(AccessibilityNodeInfo n, int index, StringBuilder out, int width, int height) {
        Rect bounds = new Rect();
        n.getBoundsInScreen(bounds);
        if (!bounds.intersect(0, 0, width, height)) bounds.setEmpty();
        out.append("<node");
        if (unnamedButton(n)) out.append(" NAF=\"true\"");
        out.append(" index=\"").append(index).append('"');
        text(out, "text", n.getText());
        text(out, "resource-id", n.getViewIdResourceName());
        text(out, "class", n.getClassName());
        text(out, "package", n.getPackageName());
        text(out, "content-desc", n.getContentDescription());
        flag(out, "checkable", n.isCheckable());
        flag(out, "checked", n.isChecked());
        flag(out, "clickable", n.isClickable());
        flag(out, "enabled", n.isEnabled());
        flag(out, "focusable", n.isFocusable());
        flag(out, "focused", n.isFocused());
        flag(out, "scrollable", n.isScrollable());
        flag(out, "long-clickable", n.isLongClickable());
        flag(out, "password", n.isPassword());
        flag(out, "selected", n.isSelected());
        out.append(" bounds=\"").append(bounds.toShortString()).append("\">");
        for (int i = 0, count = n.getChildCount(); i < count; i++) {
            AccessibilityNodeInfo child = n.getChild(i);
            if (child != null && child.isVisibleToUser()) node(child, i, out, width, height);
        }
        out.append("</node>");
    }

    /** The dumper's NAF ("not accessibility friendly"): something to press that nothing names, itself or below. */
    private static boolean unnamedButton(AccessibilityNodeInfo n) {
        String type = n.getClassName() == null ? "" : n.getClassName().toString();
        for (String list : new String[] {"android.widget.GridView", "android.widget.GridLayout", "android.widget.ListView", "android.widget.TableLayout"}) {
            if (type.endsWith(list)) return false;
        }
        return n.isClickable() && n.isEnabled() && empty(n.getContentDescription()) && empty(n.getText()) && !namedBelow(n);
    }

    private static boolean namedBelow(AccessibilityNodeInfo n) {
        for (int i = 0, count = n.getChildCount(); i < count; i++) {
            AccessibilityNodeInfo child = n.getChild(i);
            if (child != null && (!empty(child.getContentDescription()) || !empty(child.getText()) || namedBelow(child))) return true;
        }
        return false;
    }

    private static boolean empty(CharSequence s) {
        return s == null || s.length() == 0;
    }

    private static void flag(StringBuilder out, String name, boolean value) {
        out.append(' ').append(name).append("=\"").append(value).append('"');
    }

    private static void text(StringBuilder out, String name, CharSequence value) {
        out.append(' ').append(name).append("=\"");
        for (int i = 0, length = value == null ? 0 : value.length(); i < length; i++) {
            char c = value.charAt(i);
            switch (c) {
                case '&': out.append("&amp;"); break;
                case '<': out.append("&lt;"); break;
                case '>': out.append("&gt;"); break;
                case '"': out.append("&quot;"); break;
                case '\n': out.append("&#10;"); break;
                case '\r': out.append("&#13;"); break;
                case '\t': out.append("&#9;"); break;
                default:
                    // the dumper's list of what XML cannot carry → "."; beyond the BMP → a number, as its serializer writes it
                    if (c < 0x20 || (c >= 0x7F && c <= 0x84) || (c >= 0x86 && c <= 0x9F) || (c >= 0xFDD0 && c <= 0xFDDF)) out.append('.');
                    else if (Character.isHighSurrogate(c) && i + 1 < length && Character.isLowSurrogate(value.charAt(i + 1))) out.append("&#").append(Character.toCodePoint(c, value.charAt(++i))).append(';');
                    else out.append(c);
            }
        }
        out.append('"');
    }
}
