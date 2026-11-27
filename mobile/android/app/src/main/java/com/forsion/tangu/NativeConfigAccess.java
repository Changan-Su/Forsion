package com.forsion.tangu;

import android.content.Context;

/** Public view of {@link NativeConfig} for the local engine package (apiBase / token are still never taken from JS). */
public final class NativeConfigAccess {
    private NativeConfigAccess() {}

    public static String apiBase(Context ctx) { return NativeConfig.apiBase(ctx); }

    public static String token(Context ctx) { return NativeConfig.token(ctx); }
}
