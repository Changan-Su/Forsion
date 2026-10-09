package com.forsion.tangu

import android.content.ComponentName
import android.content.pm.PackageManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 桌面图标跟随「设置 → 外观 → 应用图标」(页面侧 mobile/src/launcherIcon.ts)。
 * 桌面上的图标是清单里的一个入口(activity-alias);Android 只允许在安装包声明过的入口之间切换,所以只有内置图标
 * 能上桌面 —— 上传的图片 / 插件图标(以及任何不认识的 id)一律回到默认入口,它们只在 App 内显示。
 * 入口一次只开一个;开关的名单 = 清单里的别名,两边一起改。
 */
@CapacitorPlugin(name = "LauncherIcon")
class LauncherIconPlugin : Plugin() {
    @PluginMethod
    fun set(call: PluginCall) {
        try {
            val want = ENTRIES[call.getString("id")] ?: DEFAULT
            val pm = context.packageManager
            var changed = false
            // 先开后关:任何时刻都至少留着一个入口。
            for (name in listOf(want) + (ENTRIES.values + DEFAULT).filter { it != want }) {
                // 类名的包固定是 com.forsion.tangu(并装的预览包只换 applicationId)。
                val component = ComponentName(context.packageName, "com.forsion.tangu.$name")
                val on = when (pm.getComponentEnabledSetting(component)) {
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
                    PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> name == DEFAULT // 清单里只有默认入口是开着的
                    else -> false
                }
                if (on == (name == want)) continue
                // DONT_KILL_APP:不带的话系统会把正在用的 App 一起杀掉。
                pm.setComponentEnabledSetting(
                    component,
                    if (name == want) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP,
                )
                changed = true
            }
            call.resolve(JSObject().put("changed", changed))
        } catch (e: Exception) {
            call.reject("LauncherIcon.set failed: ${e.message}", e)
        }
    }

    companion object {
        /** ⚠️ 永不改名:用户桌面上已有的图标认的是这个组件名(见清单)。 */
        const val DEFAULT = "MainActivity"
        /** 应用图标的 id(desktop/frontend/src/appearance/builtins.ts 的 key)→ 清单里的别名。 */
        val ENTRIES = mapOf("builtin:arioso" to "IconArioso")
    }
}
