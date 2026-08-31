import SwiftUI
import MailboxShared
import AppKit

@main
struct MailboxMacOSApp: App {
    @NSApplicationDelegateAdaptor(MailboxMacOSAppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

final class MailboxMacOSAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Mailbox"
        window.contentMinSize = NSSize(width: 900, height: 600)
        window.contentView = NSHostingView(rootView: MacOverviewView())
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
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
