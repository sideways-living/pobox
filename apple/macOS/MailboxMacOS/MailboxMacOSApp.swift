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
        window.title = "pobox.watch"
        window.contentMinSize = NSSize(width: 900, height: 600)
        window.contentView = NSHostingView(rootView: MacRootView())
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@MainActor
final class MacMailboxViewModel: ObservableObject {
    @Published var email = "daniel@example.com"
    @Published var password = "Password123!"
    @Published var snapshot: MailboxDashboardSnapshot?
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var busyMailboxId: String?

    private let client = MailboxAPIClient.live
    private let workspaceId = "ws_company"

    func signIn() async {
        await run {
            try await client.login(email: email, password: password)
            snapshot = try await client.dashboard(workspaceId: workspaceId)
        }
    }

    func refresh() async {
        await run {
            snapshot = try await client.dashboard(workspaceId: workspaceId)
        }
    }

    func collect(_ mailbox: Mailbox) async {
        busyMailboxId = mailbox.id
        defer { busyMailboxId = nil }
        await run {
            try await client.collectMailbox(workspaceId: workspaceId, mailboxId: mailbox.id, source: .macOS)
            snapshot = try await client.dashboard(workspaceId: workspaceId)
        }
    }

    private func run(_ operation: () async throws -> Void) async {
        isLoading = true
        errorMessage = nil
        do {
            try await operation()
        } catch {
            errorMessage = "Load failed. Check your connection and login details."
        }
        isLoading = false
    }
}

struct MacRootView: View {
    @StateObject private var model = MacMailboxViewModel()

    var body: some View {
        if model.snapshot == nil {
            MacLoginView(model: model)
        } else {
            MacOverviewView(model: model)
        }
    }
}

struct MacLoginView: View {
    @ObservedObject var model: MacMailboxViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("pobox.watch")
                .font(.largeTitle.bold())
            Text("Sign in to pobox.watch")
                .foregroundStyle(.secondary)

            TextField("Email", text: $model.email)
                .textFieldStyle(.roundedBorder)
                .frame(width: 360)
            SecureField("Password", text: $model.password)
                .textFieldStyle(.roundedBorder)
                .frame(width: 360)

            HStack {
                Button {
                    Task { await model.signIn() }
                } label: {
                    Label("Sign In", systemImage: "person.crop.circle.badge.checkmark")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isLoading)

                if model.isLoading {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
            }

            Spacer()
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct MacOverviewView: View {
    @ObservedObject var model: MacMailboxViewModel
    @State private var selection = "Overview"
    private let items = ["Overview", "PO Boxes", "Map", "History", "Activity", "Needs Review", "Team", "Settings"]

    var body: some View {
        NavigationSplitView {
            List(items, id: \.self, selection: $selection) { item in
                Label(item, systemImage: icon(for: item))
            }
            .navigationTitle("pobox.watch")
        } detail: {
            detailView(for: selection)
                .toolbar {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
        }
    }

    @ViewBuilder
    private func detailView(for item: String) -> some View {
        let snapshot = model.snapshot
        switch item {
        case "Overview":
            MacSectionView(
                title: snapshot?.workspace.name ?? "Overview",
                subtitle: snapshot.map { "Signed in as \($0.currentUser.displayName)" } ?? "Live summary of all shared PO box locations.",
                rows: [
                    ("Outstanding", "\(snapshot?.outstandingMailboxCount ?? 0) PO boxes need checking."),
                    ("Post offices", "\(snapshot?.postOffices.count ?? 0) locations loaded from pobox.watch."),
                    ("PO Boxes", "\(snapshot?.postOffices.flatMap(\.mailboxes).count ?? 0) shared boxes are configured.")
                ]
            )
        case "PO Boxes":
            MacMailboxListView(snapshot: snapshot, busyMailboxId: model.busyMailboxId) { mailbox in
                await model.collect(mailbox)
            }
        case "Map":
            MacSectionView(
                title: "Map",
                subtitle: "Post office locations configured for this workspace.",
                rows: snapshot?.postOffices.map { ($0.name, "\($0.address) - \($0.geofenceRadius)m geofence") } ?? []
            )
        case "History":
            MacSectionView(
                title: "History",
                subtitle: "Recent mail detections and collection events.",
                rows: snapshot?.history.prefix(30).map(historyRow) ?? []
            )
        case "Activity":
            MacSectionView(
                title: "Activity",
                subtitle: "Operational feed for the shared workspace.",
                rows: snapshot?.history.prefix(30).map(historyRow) ?? []
            )
        case "Needs Review":
            let reviewRows = snapshot?.history.compactMap { event -> (String, String)? in
                if case .mail(let mail) = event, mail.parserConfidence < 0.8 {
                    return (mail.subject, "Parser confidence \(Int(mail.parserConfidence * 100))%")
                }
                return nil
            } ?? []
            MacSectionView(
                title: "Needs Review",
                subtitle: "Low-confidence mail detection events.",
                rows: reviewRows.isEmpty ? [("Clear", "No review items returned by the live dashboard.")] : reviewRows
            )
        case "Team":
            MacSectionView(
                title: "Team",
                subtitle: "Current authenticated user.",
                rows: [
                    ("Name", snapshot?.currentUser.displayName ?? "Unknown"),
                    ("Email", snapshot?.currentUser.email ?? "Unknown"),
                    ("Role", snapshot?.currentUser.role ?? "Unknown")
                ]
            )
        case "Settings":
            MacSectionView(
                title: "Settings",
                subtitle: "Configuration for the native Mac client.",
                rows: [
                    ("Server", "https://pobox.watch"),
                    ("Workspace", snapshot?.workspace.name ?? "Unknown"),
                    ("Storage", "Prisma/PostgreSQL through the VPS API.")
                ]
            )
        default:
            MacSectionView(title: item, subtitle: "Section pending.", rows: [])
        }
    }

    private func historyRow(_ event: MailboxHistoryEvent) -> (String, String) {
        switch event {
        case .mail(let mail):
            return (mail.subject, "PO box \(mail.mailboxId) from \(mail.sender)")
        case .collection(let collection):
            return ("Collected from \(collection.source.rawValue)", "By \(collection.collectedBy) at \(collection.collectedAt)")
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

struct MacMailboxListView: View {
    let snapshot: MailboxDashboardSnapshot?
    let busyMailboxId: String?
    let collect: (Mailbox) async -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("PO Boxes")
                        .font(.largeTitle.bold())
                    Text("Current shared state from pobox.watch")
                        .foregroundStyle(.secondary)
                }

                ForEach(snapshot?.postOffices ?? []) { office in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(office.name)
                            .font(.title3.bold())
                        ForEach(office.mailboxes) { mailbox in
                            HStack {
                                Image(systemName: mailbox.mailWaiting ? "tray.full.fill" : "checkmark.circle")
                                    .foregroundStyle(mailbox.mailWaiting ? .orange : .green)
                                VStack(alignment: .leading) {
                                    Text(mailbox.name)
                                        .font(.headline)
                                    Text(mailbox.mailWaiting ? "Mail waiting" : "Clear")
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if mailbox.mailWaiting {
                                    Button("Collect") {
                                        Task { await collect(mailbox) }
                                    }
                                    .disabled(busyMailboxId == mailbox.id)
                                }
                            }
                            .padding(12)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                    .frame(maxWidth: 780, alignment: .leading)
                }
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
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
