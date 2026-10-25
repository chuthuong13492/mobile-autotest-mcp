package dev.autotest.fixture;

import static org.junit.Assert.assertEquals;

import org.junit.Ignore;
import org.junit.Test;

/** Outcomes the Android adapter must map: a failure and a skip (the passing cases are in CalculatorTest). */
public class ScenarioTest {
    @Test
    public void addIsWrongOnPurpose() {
        assertEquals("fails on purpose", 5, new Calculator().add(2, 2));
    }

    @Ignore("skipped on purpose")
    @Test
    public void skippedOnPurpose() {}
}
