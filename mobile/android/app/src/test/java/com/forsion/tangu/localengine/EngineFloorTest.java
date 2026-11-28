package com.forsion.tangu.localengine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The rollback rule (mobile/android/local-engine/README.md): an engine may start only if every newer recorded one has its fingerprint. */
public class EngineFloorTest {
    private static final String A = "a".repeat(64), B = "b".repeat(64);

    @Test public void emptyHistoryAllowsAndRecords() {
        assertEquals(EngineFloor.Verdict.ALLOW_AND_RECORD, EngineFloor.EMPTY.decide("2.14.10", A));
        assertEquals(EngineFloor.Verdict.ALLOW_AND_RECORD, EngineFloor.parse(null).decide("2.14.10", A));
    }

    @Test public void forwardAlwaysAllowedAndRecorded() {
        EngineFloor f = EngineFloor.EMPTY.with("2.14.10", A);
        assertEquals(EngineFloor.Verdict.ALLOW_AND_RECORD, f.decide("2.14.11", B));
        assertEquals(EngineFloor.Verdict.ALLOW, f.decide("2.14.10", A)); // the same version: nothing new to record
    }

    @Test public void backOnlyOnAnIdenticalFingerprint() {
        EngineFloor f = EngineFloor.EMPTY.with("2.14.10", A).with("2.14.11", A);
        assertEquals(EngineFloor.Verdict.ALLOW, f.decide("2.14.10", A));
        EngineFloor g = EngineFloor.EMPTY.with("2.14.10", A).with("2.14.11", B);
        assertEquals("never an old engine on data a newer one may have migrated", EngineFloor.Verdict.REFUSE, g.decide("2.14.10", A));
    }

    @Test public void aBaThenBackToTheFirstIsRefused() {
        // v1 (A) → v2 (B) migrates → v3 (A) recorded then crashes before touching data → v1 must not run on B-migrated data
        EngineFloor f = EngineFloor.EMPTY.with("1.0.0", A).with("2.0.0", B).with("3.0.0", A);
        assertEquals(EngineFloor.Verdict.REFUSE, f.decide("1.0.0", A));
        assertEquals("v2 is older than v3, whose schema code differs", EngineFloor.Verdict.REFUSE, f.decide("2.0.0", B));
        assertEquals(EngineFloor.Verdict.ALLOW, f.decide("3.0.0", A));
    }

    @Test public void twoBuildsOfOneVersionAreDifferentEngines() {
        // N/A ran (maybe migrated); a second signed build N/B must not start on that data, and once N/B were let on,
        // N-1/A could not use "N has my fingerprint" to come back
        EngineFloor f = EngineFloor.EMPTY.with("2.14.9", A).with("2.14.10", A);
        assertEquals(EngineFloor.Verdict.REFUSE, f.decide("2.14.10", B));
        assertEquals(EngineFloor.Verdict.ALLOW, f.decide("2.14.10", A));
        assertEquals("a newer version is still free to move forward", EngineFloor.Verdict.ALLOW_AND_RECORD, f.decide("2.14.11", B));
    }

    @Test public void numericNotLexical() {
        EngineFloor f = EngineFloor.EMPTY.with("1.10.0", B);
        assertEquals("1.9.0 is older than 1.10.0", EngineFloor.Verdict.REFUSE, f.decide("1.9.0", A));
    }

    @Test public void roundTripsAndRefusesWhatItCannotRead() {
        EngineFloor f = EngineFloor.EMPTY.with("2.14.10", A).with("2.14.11", B);
        EngineFloor g = EngineFloor.parse(f.serialize());
        assertEquals(2, g.entries.size());
        assertEquals(EngineFloor.Verdict.REFUSE, g.decide("2.14.10", A));
        for (String bad : new String[]{"", "{", "[]", "{\"schema\":2,\"engines\":[]}", "{\"schema\":1}",
                "{\"schema\":1,\"engines\":[{\"version\":\"2.14\",\"fingerprint\":\"" + A + "\"}]}",
                "{\"schema\":1,\"engines\":[{\"version\":\"2.14.1\",\"fingerprint\":\"xyz\"}]}"}) {
            assertThrows(bad, IllegalArgumentException.class, () -> EngineFloor.parse(bad));
        }
    }

    @Test public void versions() {
        assertTrue(Versions.compare("1.10.0", "1.9.9") > 0);
        assertTrue(Versions.compare("2.0.0", "10.0.0") < 0);
        assertEquals(0, Versions.compare("2.14.10", "2.14.10"));
        for (String bad : new String[]{"01.2.3", "1.2", "1.2.3-beta.1", "1.2.3+x", "v1.2.3", " 1.2.3", "1.2.3 ", "1234567890.0.0"}) {
            assertTrue(bad, !Versions.isRelease(bad));
            assertThrows(IllegalArgumentException.class, () -> Versions.compare(bad, "1.0.0"));
        }
    }
}
