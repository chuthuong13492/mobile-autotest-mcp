import XCTest
@testable import FixtureApp

/// Outcomes the iOS adapter must map: a failure and a skip (the passing cases are in CalculatorTests).
final class ScenarioTests: XCTestCase {
    func testAddIsWrongOnPurpose() {
        XCTAssertEqual(Calculator().add(2, 2), 5, "fails on purpose")
    }

    func testSkippedOnPurpose() throws {
        throw XCTSkip("skipped on purpose")
    }
}
