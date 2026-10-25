/// Integer arithmetic used by the fixture's tests.
struct Calculator {
    func add(_ a: Int, _ b: Int) -> Int { a + b }

    /// Returns `a / b`, truncated; nil when `b` is zero.
    func divide(_ a: Int, _ b: Int) -> Int? { b == 0 ? nil : a / b }
}
