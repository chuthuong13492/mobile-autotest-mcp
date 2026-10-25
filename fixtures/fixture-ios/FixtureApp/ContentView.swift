import SwiftUI

struct ContentView: View {
    @State private var count = 0

    var body: some View {
        VStack(spacing: 16) {
            Text("Count: \(count)").accessibilityIdentifier("countLabel")
            Button("Increment") { count += 1 }.accessibilityIdentifier("incrementButton")
        }
        .padding()
    }
}
