package com.forsion.tangu;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Space 快捷方式(2026-08-20)。两件事:
 *  - setSpaces:把 Space 列表发布成**动态快捷方式** —— 长按桌面上的 app 图标就是这张列表,
 *    点一条直接进那个 Space。顺带,安卓自己允许把列表里的一条长按拖到桌面变成固定图标。
 *  - pin:直接请求把某个 Space **固定到桌面**(系统弹自己的确认框,我们不画任何 UI)。
 *
 * 两者用的是同一个 Intent:`tangu://space?id=<id>`,显式指向 MainActivity(显式 Intent 不吃
 * intent-filter,所以 AndroidManifest 不用动)。JS 侧冷启走 App.getLaunchUrl()、热启走 appUrlOpen,
 * 见 mobile/src/spaceShortcuts.ts。
 *
 * ⚠️ 快捷方式 id 恒为 `space:<空间 id>` 且**永不变**:已经被用户固定到桌面的那些图标靠它认领,
 *    换 id = 桌面上的旧图标变成失效的空壳。
 */
@CapacitorPlugin(name = "SpaceShortcuts")
public class SpaceShortcutsPlugin extends Plugin {

    private ShortcutInfoCompat build(Context ctx, String id, String shortLabel, int rank) {
        Intent intent = new Intent(ctx, MainActivity.class);
        // ⚠️ 必须带 action:没有 action 的 Intent 建快捷方式会被系统直接拒(IllegalArgumentException)。
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("tangu://space?id=" + Uri.encode(id)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return new ShortcutInfoCompat.Builder(ctx, "space:" + id)
                .setShortLabel(shortLabel)
                .setLongLabel(shortLabel)
                // 显式给图标:不给的话「回落到 app 图标」是各家 launcher 自己的行为,有的直接画个空圈。
                .setIcon(IconCompat.createWithResource(ctx, R.mipmap.ic_launcher))
                .setRank(rank)
                .setIntent(intent)
                .build();
    }

    /** 发布动态快捷方式。入参 spaces = [{id, label}, …],顺序即优先级(前面的更可能被显示)。 */
    @PluginMethod
    public void setSpaces(PluginCall call) {
        Context ctx = getContext();
        JSArray arr = call.getArray("spaces");
        try {
            List<ShortcutInfoCompat> out = new ArrayList<>();
            // 系统对每个 activity 的动态快捷方式条数有硬上限(通常 4~5),超了 setDynamicShortcuts 直接抛。
            int max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(ctx);
            int n = arr == null ? 0 : arr.length();
            for (int i = 0; i < n && out.size() < max; i++) {
                JSONObject o = arr.getJSONObject(i);
                String id = o.optString("id", "");
                String lbl = o.optString("label", "");
                if (id.isEmpty() || lbl.isEmpty()) continue;
                out.add(build(ctx, id, lbl, out.size()));
            }
            ShortcutManagerCompat.setDynamicShortcuts(ctx, out);
            JSObject res = new JSObject();
            res.put("published", out.size());
            res.put("max", max);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("setSpaces failed: " + e.getMessage(), e);
        }
    }

    /**
     * 请求把一个 Space 固定到桌面。系统弹自己的确认框。
     * ⚠️ 部分国产 ROM(MIUI/ColorOS 等)把「创建桌面快捷方式」做成了逐 app 的权限且默认关:
     *    isRequestPinShortcutSupported 照样返回 true,但确认框**静默不出现**。这不是本插件的 bug,
     *    只能引导用户去系统设置里给本 app 打开该权限。
     */
    @PluginMethod
    public void pin(PluginCall call) {
        Context ctx = getContext();
        String id = call.getString("id");
        String lbl = call.getString("label");
        if (id == null || id.isEmpty() || lbl == null || lbl.isEmpty()) {
            call.reject("id 与 label 必填");
            return;
        }
        try {
            boolean supported = ShortcutManagerCompat.isRequestPinShortcutSupported(ctx);
            if (supported) ShortcutManagerCompat.requestPinShortcut(ctx, build(ctx, id, lbl, 0), null);
            JSObject res = new JSObject();
            res.put("requested", supported);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("pin failed: " + e.getMessage(), e);
        }
    }
}
