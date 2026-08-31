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
            detailView(for: selection)
        }
    }

    @ViewBuilder
    private func detailView(for item: String) -> some View {
        switch item {
        case "Overview":
            MacSectionView(
                title: "Overview",
                subtitle: "Live summary of all shared mailbox locations.",
                rows: [
                    ("Outstanding", "Shows how many physical boxes need checking."),
                    ("Realtime", "Will update immediately when web, iPhone, or Mac users collect mail."),
                    ("Next step", "Wire this panel to https://pobox.watch dashboard data.")
                ]
            )
        case "Mailboxes":
            MacSectionView(
                title: "Mailboxes",
                subtitle: "Mailbox-by-mailbox operational state.",
                rows: [
                    ("Box number", "List each configured mailbox and whether mail is waiting."),
                    ("Collect action", "Mark a box collected from the Mac app."),
                    ("Audit trail", "Record who collected it and when.")
                ]
            )
        case "Map":
            MacSectionView(
                title: "Map",
                subtitle: "Post office locations and collection context.",
                rows: [
                    ("Locations", "Display each post office attached to the workspace."),
                    ("Directions", "Open the selected post office in Maps."),
                    ("Geofence", "Use the shared radius settings for reminder logic.")
                ]
            )
        case "History":
            MacSectionView(
                title: "History",
                subtitle: "Recent mail detections and collection events.",
                rows: [
                    ("Mail arrived", "Show provider notification matches."),
                    ("Collected", "Show user, device source, and collection time."),
                    ("Duplicates", "Keep duplicate provider messages from creating extra work.")
                ]
            )
        case "Activity":
            MacSectionView(
                title: "Activity",
                subtitle: "Operational feed for the shared workspace.",
                rows: [
                    ("Team actions", "Invites, role changes, and manual corrections."),
                    ("System events", "Parser matches, provider sync, and delivery status."),
                    ("Review", "Surface anything that needs admin attention.")
                ]
            )
        case "Needs Review":
            MacSectionView(
                title: "Needs Review",
                subtitle: "Items that should not be auto-applied.",
                rows: [
                    ("Ambiguous mail", "Messages that matched weakly or need human confirmation."),
                    ("Failed sync", "Provider or notification failures requiring retry."),
                    ("Security", "Suspicious login or invitation events.")
                ]
            )
        case "Team":
            MacSectionView(
                title: "Team",
                subtitle: "Workspace users and roles.",
                rows: [
                    ("Admins", "Can invite users and manage workspace settings."),
                    ("Members", "Can view and collect assigned mailboxes."),
                    ("Invitations", "Pending invitations will appear here.")
                ]
            )
        case "Settings":
            MacSectionView(
                title: "Settings",
                subtitle: "Configuration for the native Mac client.",
                rows: [
                    ("Server", "https://pobox.watch"),
                    ("Workspace", "Company Mailboxes"),
                    ("Authentication", "Login wiring is the next native app milestone.")
                ]
            )
        default:
            MacSectionView(title: item, subtitle: "Section pending.", rows: [])
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

struct MacSectionView: View {
    let title: String
    let subtitle: String
    let rows: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.largeTitle.bold())
                Text(subtitle)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 12) {
                ForEach(rows, id: \.0) { row in
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: "checkmark.circle")
                            .foregroundStyle(.green)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.0)
                                .font(.headline)
                            Text(row.1)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(14)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .frame(maxWidth: 720, alignment: .leading)

            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
