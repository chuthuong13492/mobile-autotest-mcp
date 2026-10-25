import XCTest

final class CounterUITests: XCTestCase {
    func testTapIncrementShowsOne() {
        let app = XCUIApplication()
        app.launch()
        app.buttons["incrementButton"].tap()
        XCTAssertEqual(app.staticTexts["countLabel"].label, "Count: 1")
    }
}
