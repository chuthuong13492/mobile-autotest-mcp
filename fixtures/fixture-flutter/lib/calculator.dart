/// Integer arithmetic used by the fixture's tests.
class Calculator {
  /// Returns the sum of [a] and [b] (live GitHub check, temporary).
  int add(int a, int b) => a + b;

  /// Returns [a] divided by [b], truncated; throws [ArgumentError] when [b] is zero.
  int divide(int a, int b) {
    if (b == 0) throw ArgumentError.value(b, 'b', 'must not be zero');
    return a ~/ b;
  }
}
