package dev.autotest.fixture;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class CalculatorTest {
    @Test
    public void addReturnsTheSum() {
        assertEquals(42, new Calculator().add(40, 2));
    }

    @Test(expected = ArithmeticException.class)
    public void divideByZeroThrows() {
        new Calculator().divide(1, 0);
    }
}
