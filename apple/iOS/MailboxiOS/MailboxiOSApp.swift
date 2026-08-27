import SwiftUI
import MailboxShared

@main
struct MailboxiOSApp: App {
    var body: some Scene {
        WindowGroup {
            iPhoneOverviewView()
        }
    }
}

struct iPhoneOverviewView: View {
    var body: some View {
        TabView {
            NavigationStack {
                MailboxDashboardPlaceholder(platform: "iPhone")
                    .navigationTitle("Mailbox")
            }
            .tabItem { Label("Overview", systemImage: "tray.full") }

            Text("Map")
                .tabItem { Label("Map", systemImage: "map") }

            Text("History")
                .tabItem { Label("History", systemImage: "clock") }

            Text("Settings")
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

struct MailboxDashboardPlaceholder: View {
    let platform: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Shared mailbox state will load from the Node API.")
                .font(.headline)
            Text("Geofence reminders remain on-device and never upload live user location.")
                .foregroundStyle(.secondary)
            Button("Enable Collection Reminders") {}
                .buttonStyle(.borderedProminent)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
