import XCTest
@testable import FixtureApp

final class CalculatorTests: XCTestCase {
    func testAddReturnsTheSum() {
        XCTAssertEqual(Calculator().add(40, 2), 42)
    }

    func testDivideByZeroReturnsNil() {
        XCTAssertNil(Calculator().divide(1, 0))
    }
}
