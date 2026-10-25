package dev.autotest.fixture;

import static org.junit.Assert.assertEquals;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class CalculatorInstrumentedTest {
    @Test
    public void runsOnTheDevice() {
        assertEquals("dev.autotest.fixture",
                InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName());
    }

    @Test
    public void addIsWrongOnTheDevice() {
        assertEquals("fails on purpose", 5, new Calculator().add(2, 2));
    }
}
