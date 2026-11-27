package com.forsion.tangu;

import android.content.Context;

/** Public view of {@link NativeConfig} for the local engine package (apiBase / token are still never taken from JS). */
public final class NativeConfigAccess {
    private NativeConfigAccess() {}

    public static String apiBase(Context ctx) { return NativeConfig.apiBase(ctx); }

    public static String token(Context ctx) { return NativeConfig.token(ctx); }

    /** Sign-in / sign-out / account switch (the page writes the token through @capacitor/preferences). Keep a strong reference to l. */
    public static void onTokenChange(Context ctx, android.content.SharedPreferences.OnSharedPreferenceChangeListener l) {
        ctx.getSharedPreferences(NativeConfig.PREFS_GROUP, Context.MODE_PRIVATE).registerOnSharedPreferenceChangeListener(l);
    }

    public static boolean isTokenKey(String key) { return NativeConfig.TOKEN_KEY.equals(key); }
}
