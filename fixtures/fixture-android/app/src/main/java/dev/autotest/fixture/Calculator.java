package dev.autotest.fixture;

/** Integer arithmetic used by the fixture's tests. */
public final class Calculator {
    public int add(int a, int b) {
        return a + b;
    }

    /** Returns a / b, truncated; throws ArithmeticException when b is zero. */
    public int divide(int a, int b) {
        return a / b;
    }
}
