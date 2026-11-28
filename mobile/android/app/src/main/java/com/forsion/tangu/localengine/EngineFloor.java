package com.forsion.tangu.localengine;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The rollback rule for one account's data (mobile/android/local-engine/README.md, "Rollback rule"): the history of
 * every engine version that was allowed to start on it, and the decision for the next one.
 *
 * E may start only if every recorded version newer than E, or equal to it, has E's schema fingerprint. When E is newer than everything
 * recorded, it is appended (and must be on disk before the spawn). An unreadable history refuses (unknown is not empty).
 * Pure logic + parse / serialise; LocalEngine does the file IO under its lifecycle lock.
 */
final class EngineFloor {
    static final class Entry {
        final String version, fingerprint;

        Entry(String version, String fingerprint) { this.version = version; this.fingerprint = fingerprint; }
    }

    enum Verdict { ALLOW, ALLOW_AND_RECORD, REFUSE }

    final List<Entry> entries;

    EngineFloor(List<Entry> entries) { this.entries = Collections.unmodifiableList(new ArrayList<>(entries)); }

    static final EngineFloor EMPTY = new EngineFloor(new ArrayList<>());

    /** null text = no file (empty history). Throws on anything it cannot read as a history: the caller refuses the start. */
    static EngineFloor parse(String text) throws IllegalArgumentException {
        if (text == null) return EMPTY;
        try {
            JSONObject o = new JSONObject(text);
            if (o.getInt("schema") != 1) throw new IllegalArgumentException("unknown history schema");
            JSONArray a = o.getJSONArray("engines");
            List<Entry> out = new ArrayList<>();
            for (int i = 0; i < a.length(); i++) {
                JSONObject e = a.getJSONObject(i);
                String v = e.getString("version"), f = e.getString("fingerprint");
                if (!Versions.isRelease(v) || !f.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("bad entry");
                out.add(new Entry(v, f));
            }
            return new EngineFloor(out);
        } catch (org.json.JSONException e) {
            throw new IllegalArgumentException("unreadable history");
        }
    }

    Verdict decide(String version, String fingerprint) {
        boolean newest = true;
        for (Entry e : entries) {
            int c = Versions.compare(e.version, version);
            // c == 0 too: two signed builds of one version with different schema code are different engines; the one
            // that ran first may have migrated the data (a version number is not proof of identity)
            if (c >= 0 && !e.fingerprint.equals(fingerprint)) return Verdict.REFUSE;
            if (c >= 0) newest = false;
        }
        return newest ? Verdict.ALLOW_AND_RECORD : Verdict.ALLOW;
    }

    EngineFloor with(String version, String fingerprint) {
        List<Entry> l = new ArrayList<>(entries);
        l.add(new Entry(version, fingerprint));
        return new EngineFloor(l);
    }

    String serialize() {
        JSONObject o = new JSONObject();
        JSONArray a = new JSONArray();
        try {
            for (Entry e : entries) a.put(new JSONObject().put("version", e.version).put("fingerprint", e.fingerprint));
            o.put("schema", 1);
            o.put("engines", a);
        } catch (org.json.JSONException e) {
            throw new IllegalStateException(e);
        }
        return o.toString();
    }
}
