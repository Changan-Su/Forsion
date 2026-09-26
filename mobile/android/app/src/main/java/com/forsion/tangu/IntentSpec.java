package com.forsion.tangu;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 一条要发出去的 Intent 的**纯 Java 描述**(手机操控 T1)。刻意不 import 任何 android.*:
 * PhoneVerbs 只产出它,JUnit 在 JVM 上就能断言 action / data / extras / flags;
 * 真正的 android.content.Intent 由 PhoneControlPlugin.toIntent() 按它组装。
 *
 * extras 的值只允许 String / Boolean / Integer / Long / ArrayList&lt;Integer&gt;(toIntent 按类型分派)。
 */
final class IntentSpec {
    /** Intent.FLAG_ACTIVITY_NEW_TASK 的值(抄常量而非引用,保持本类无 android.* 依赖)。 */
    static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000;
    static final String CATEGORY_BROWSABLE = "android.intent.category.BROWSABLE";

    final String action;
    final String data;
    final String type;
    final String category;
    final int flags;
    /** true = 包一层系统分享面板(Intent.createChooser)。 */
    final boolean chooser;
    final Map<String, Object> extras;

    private IntentSpec(Builder b) {
        action = b.action;
        data = b.data;
        type = b.type;
        category = b.category;
        flags = b.flags;
        chooser = b.chooser;
        extras = Collections.unmodifiableMap(new LinkedHashMap<>(b.extras));
    }

    static Builder of(String action) {
        return new Builder(action);
    }

    @Override
    public String toString() {
        return "IntentSpec{" + action + (data != null ? " " + data : "") + (type != null ? " type=" + type : "")
            + (category != null ? " cat=" + category : "") + " flags=0x" + Integer.toHexString(flags)
            + (chooser ? " chooser" : "") + " extras=" + extras + "}";
    }

    static final class Builder {
        private final String action;
        private String data;
        private String type;
        private String category;
        private int flags;
        private boolean chooser;
        private final Map<String, Object> extras = new LinkedHashMap<>();

        private Builder(String action) {
            this.action = action;
        }

        Builder data(String v) { data = v; return this; }
        Builder type(String v) { type = v; return this; }
        Builder category(String v) { category = v; return this; }
        Builder flags(int v) { flags |= v; return this; }
        Builder chooser() { chooser = true; return this; }

        /** null / 空串不写(可选参数缺省 = 不带这个 extra)。 */
        Builder extra(String key, Object v) {
            if (v == null || (v instanceof String && ((String) v).isEmpty())) return this;
            if (v instanceof List) v = new ArrayList<>((List<?>) v);
            extras.put(key, v);
            return this;
        }

        IntentSpec build() {
            return new IntentSpec(this);
        }
    }
}
