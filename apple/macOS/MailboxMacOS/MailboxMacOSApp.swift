import SwiftUI
import MailboxShared

@main
struct MailboxMacOSApp: App {
    var body: some Scene {
        WindowGroup {
            MacOverviewView()
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1100, height: 720)
    }
}

struct MacOverviewView: View {
    @State private var selection = "Overview"
    private let items = ["Overview", "Mailboxes", "Map", "History", "Activity", "Needs Review", "Team", "Settings"]

    var body: some View {
        NavigationSplitView {
            List(items, id: \.self, selection: $selection) { item in
                Label(item, systemImage: icon(for: item))
            }
            .navigationTitle("Mailbox")
        } detail: {
            VStack(alignment: .leading, spacing: 12) {
                Text(selection)
                    .font(.largeTitle.bold())
                Text("Native macOS layout prepared for the shared API, realtime updates, history, and team administration.")
                    .foregroundStyle(.secondary)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func icon(for item: String) -> String {
        switch item {
        case "Overview": "tray.full"
        case "Map": "map"
        case "History": "clock"
        case "Activity": "list.bullet.rectangle"
        case "Needs Review": "exclamationmark.triangle"
        case "Team": "person.2"
        case "Settings": "gearshape"
        default: "mail.stack"
        }
    }
}
