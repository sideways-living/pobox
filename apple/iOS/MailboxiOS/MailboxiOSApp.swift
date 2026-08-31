import SwiftUI
import MailboxShared

@main
struct MailboxiOSApp: App {
    var body: some Scene {
        WindowGroup {
            iPhoneRootView()
        }
    }
}

@MainActor
final class iPhoneMailboxViewModel: ObservableObject {
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
            try await client.collectMailbox(workspaceId: workspaceId, mailboxId: mailbox.id, source: .iPhone)
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

struct iPhoneRootView: View {
    @StateObject private var model = iPhoneMailboxViewModel()

    var body: some View {
        Group {
            if model.snapshot == nil {
                iPhoneLoginView(model: model)
            } else {
                iPhoneDashboardView(model: model)
            }
        }
    }
}

struct iPhoneLoginView: View {
    @ObservedObject var model: iPhoneMailboxViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    Text("pobox.watch")
                }
                Section("Sign In") {
                    TextField("Email", text: $model.email)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                    SecureField("Password", text: $model.password)
                        .textContentType(.password)
                    Button {
                        Task { await model.signIn() }
                    } label: {
                        if model.isLoading {
                            ProgressView()
                        } else {
                            Label("Sign In", systemImage: "person.crop.circle.badge.checkmark")
                        }
                    }
                    .disabled(model.isLoading)
                }
                if let errorMessage = model.errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("pobox.watch")
        }
    }
}

struct iPhoneDashboardView: View {
    @ObservedObject var model: iPhoneMailboxViewModel

    var body: some View {
        TabView {
            NavigationStack {
                iPhoneOverviewList(model: model)
                    .navigationTitle("pobox.watch")
                    .toolbar {
                        Button {
                            Task { await model.refresh() }
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                    }
            }
            .tabItem { Label("Overview", systemImage: "tray.full") }

            NavigationStack {
                iPhoneHistoryList(snapshot: model.snapshot)
                    .navigationTitle("History")
            }
            .tabItem { Label("History", systemImage: "clock") }

            NavigationStack {
                iPhoneSettingsView(snapshot: model.snapshot)
                    .navigationTitle("Settings")
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

struct iPhoneOverviewList: View {
    @ObservedObject var model: iPhoneMailboxViewModel

    var body: some View {
        List {
            if let snapshot = model.snapshot {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(snapshot.outstandingMailboxCount)")
                            .font(.system(size: 44, weight: .bold))
                        Text(snapshot.outstandingMailboxCount == 1 ? "PO box needs checking" : "PO boxes need checking")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }

                ForEach(snapshot.postOffices) { office in
                    Section(office.name) {
                        Text(office.address)
                            .foregroundStyle(.secondary)
                        ForEach(office.mailboxes) { mailbox in
                            iPhoneMailboxRow(mailbox: mailbox, busy: model.busyMailboxId == mailbox.id) {
                                await model.collect(mailbox)
                            }
                        }
                    }
                }

                if let errorMessage = model.errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
        }
        .refreshable {
            await model.refresh()
        }
    }
}

struct iPhoneMailboxRow: View {
    let mailbox: Mailbox
    let busy: Bool
    let collect: () async -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: mailbox.mailWaiting ? "tray.full.fill" : "checkmark.circle")
                .foregroundStyle(mailbox.mailWaiting ? .orange : .green)
            VStack(alignment: .leading, spacing: 3) {
                Text(mailbox.name)
                    .font(.headline)
                Text(mailbox.mailWaiting ? "Mail waiting" : "Clear")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if mailbox.mailWaiting {
                Button {
                    Task { await collect() }
                } label: {
                    if busy {
                        ProgressView()
                    } else {
                        Text("Collect")
                    }
                }
                .disabled(busy)
            }
        }
    }
}

struct iPhoneHistoryList: View {
    let snapshot: MailboxDashboardSnapshot?

    var body: some View {
        List {
            ForEach(Array(snapshot?.history.prefix(30) ?? [])) { event in
                switch event {
                case .mail(let mail):
                    Label(mail.subject, systemImage: "envelope.badge")
                case .collection(let collection):
                    Label("Collected from \(collection.source.rawValue)", systemImage: "checkmark.circle")
                }
            }
        }
    }
}

struct iPhoneSettingsView: View {
    let snapshot: MailboxDashboardSnapshot?

    var body: some View {
        Form {
            Section("Workspace") {
                Text(snapshot?.workspace.name ?? "Not loaded")
                Text(snapshot?.currentUser.email ?? "")
                    .foregroundStyle(.secondary)
            }
            Section("Server") {
                Text("https://pobox.watch")
            }
        }
    }
}
