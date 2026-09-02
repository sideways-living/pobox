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
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "pobox.watch"
        window.contentMinSize = NSSize(width: 940, height: 620)
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
    @Published var password = ""
    @Published var twoFactorCode = ""
    @Published var twoFactorChallengeId: String?
    @Published var snapshot: MailboxDashboardSnapshot?
    @Published var reviewItems: [ReviewItem] = []
    @Published var members: [TeamMember] = []
    @Published var postOfficeLocationResults: [PostOfficeLocationResult] = []
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var busyMailboxId: String?
    @Published var passwordMode = false

    private let client = MailboxAPIClient.live
    private let workspaceId = "ws_company"

    func openPasskeySignIn() {
        guard let url = URL(string: "https://pobox.watch") else { return }
        NSWorkspace.shared.open(url)
    }

    func signInWithPassword() async {
        await run {
            let result = try await client.login(email: email, password: password)
            if result.twoFactorRequired == true, let challengeId = result.challengeId {
                twoFactorChallengeId = challengeId
                twoFactorCode = ""
                return
            }
            try await loadWorkspace()
        }
    }

    func verifySecondFactor() async {
        guard let challengeId = twoFactorChallengeId else { return }
        await run {
            _ = try await client.verifySecondFactor(challengeId: challengeId, code: twoFactorCode)
            twoFactorChallengeId = nil
            twoFactorCode = ""
            try await loadWorkspace()
        }
    }

    func refresh() async {
        await run {
            try await loadWorkspace()
        }
    }

    func collect(_ mailbox: Mailbox) async {
        busyMailboxId = mailbox.id
        defer { busyMailboxId = nil }
        await run {
            try await client.collectMailbox(workspaceId: workspaceId, mailboxId: mailbox.id, source: .macOS)
            try await loadWorkspace()
        }
    }

    func logout() async {
        await run {
            try await client.logout()
            snapshot = nil
            reviewItems = []
            members = []
            postOfficeLocationResults = []
            twoFactorChallengeId = nil
            twoFactorCode = ""
            password = ""
            passwordMode = false
        }
    }

    private func loadWorkspace() async throws {
        async let dashboard = client.dashboard(workspaceId: workspaceId)
        async let reviews = client.reviewItems(workspaceId: workspaceId)
        async let team = client.teamMembers(workspaceId: workspaceId)
        snapshot = try await dashboard
        reviewItems = try await reviews
        members = try await team
    }

    func createUser(email: String, displayName: String, password: String, role: String) async {
        await run {
            _ = try await client.createUser(
                workspaceId: workspaceId,
                input: CreateUserInput(email: email, displayName: displayName, password: password, role: role)
            )
            try await loadWorkspace()
        }
    }

    func updateUser(_ member: TeamMember, email: String, displayName: String, role: String) async {
        await run {
            _ = try await client.updateUser(
                workspaceId: workspaceId,
                userId: member.id,
                input: UpdateUserInput(email: email, displayName: displayName, role: role)
            )
            try await loadWorkspace()
        }
    }

    func deleteUser(_ member: TeamMember) async {
        await run {
            try await client.deleteUser(workspaceId: workspaceId, userId: member.id)
            try await loadWorkspace()
        }
    }

    func searchPostOfficeLocations(query: String) async {
        await run {
            postOfficeLocationResults = try await client.searchPostOfficeLocations(workspaceId: workspaceId, query: query)
        }
    }

    func createPostOffice(name: String, address: String, phone: String?, latitude: Double, longitude: Double, geofenceRadius: Int) async {
        await run {
            _ = try await client.createPostOffice(
                workspaceId: workspaceId,
                input: CreatePostOfficeInput(name: name, address: address, phone: phone, latitude: latitude, longitude: longitude, geofenceRadius: geofenceRadius)
            )
            postOfficeLocationResults = []
            try await loadWorkspace()
        }
    }

    func updatePostOffice(_ office: PostOffice, name: String, address: String, phone: String?, latitude: Double, longitude: Double, geofenceRadius: Int) async {
        await run {
            _ = try await client.updatePostOffice(
                workspaceId: workspaceId,
                postOfficeId: office.id,
                input: UpdatePostOfficeInput(name: name, address: address, phone: phone, latitude: latitude, longitude: longitude, geofenceRadius: geofenceRadius)
            )
            try await loadWorkspace()
        }
    }

    func deletePostOffice(_ office: PostOffice) async {
        await run {
            try await client.deletePostOffice(workspaceId: workspaceId, postOfficeId: office.id)
            try await loadWorkspace()
        }
    }

    func createMailbox(postOfficeId: String, boxNumber: String) async {
        await run {
            _ = try await client.createMailbox(
                workspaceId: workspaceId,
                input: CreateMailboxInput(postOfficeId: postOfficeId, boxNumber: boxNumber)
            )
            try await loadWorkspace()
        }
    }

    func updateMailbox(_ mailbox: Mailbox, postOfficeId: String, boxNumber: String) async {
        await run {
            _ = try await client.updateMailbox(
                workspaceId: workspaceId,
                mailboxId: mailbox.id,
                input: UpdateMailboxInput(postOfficeId: postOfficeId, boxNumber: boxNumber)
            )
            try await loadWorkspace()
        }
    }

    func deleteMailbox(_ mailbox: Mailbox) async {
        await run {
            try await client.deleteMailbox(workspaceId: workspaceId, mailboxId: mailbox.id)
            try await loadWorkspace()
        }
    }

    private func run(_ operation: () async throws -> Void) async {
        isLoading = true
        errorMessage = nil
        do {
            try await operation()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Load failed. Check your connection and login details."
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
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("pobox.watch")
                    .font(.largeTitle.bold())
                Text(model.twoFactorChallengeId == nil ? "Sign in with your passkey" : "Enter your authenticator code")
                    .font(.title3.weight(.semibold))
                Text("pobox.watch requires a passkey and authenticator 2FA for every account.")
                    .foregroundStyle(.secondary)
            }

            if model.twoFactorChallengeId == nil {
                TextField("Email", text: $model.email)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 380)

                if model.passwordMode {
                    SecureField("Password", text: $model.password)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 380)
                }
            } else {
                TextField("Authenticator or recovery code", text: $model.twoFactorCode)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 380)
            }

            HStack(spacing: 10) {
                if model.twoFactorChallengeId != nil {
                    Button {
                        Task { await model.verifySecondFactor() }
                    } label: {
                        Label("Verify Code", systemImage: "checkmark.shield")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isLoading || model.twoFactorCode.isEmpty)

                    Button("Cancel") {
                        model.twoFactorChallengeId = nil
                        model.twoFactorCode = ""
                    }
                } else if model.passwordMode {
                    Button {
                        Task { await model.signInWithPassword() }
                    } label: {
                        Label("Continue with Password", systemImage: "lock")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isLoading || model.email.isEmpty || model.password.isEmpty)

                    Button {
                        model.passwordMode = false
                        model.password = ""
                    } label: {
                        Label("Back to Passkey", systemImage: "key")
                    }
                } else {
                    Button {
                        model.openPasskeySignIn()
                    } label: {
                        Label("Continue with Passkey", systemImage: "key.fill")
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Use Password to Set Up Security") {
                        model.passwordMode = true
                    }
                }

                if model.isLoading {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            Text("Passkey setup and first secure sign-in currently happen at pobox.watch in your browser. After setup, use the Mac app with the same secured account.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 520, alignment: .leading)

            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
                    .frame(maxWidth: 520, alignment: .leading)
            }

            Spacer()
        }
        .padding(36)
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
                    .disabled(model.isLoading)

                    Button {
                        Task { await model.logout() }
                    } label: {
                        Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    .disabled(model.isLoading)
                }
        }
    }

    @ViewBuilder
    private func detailView(for item: String) -> some View {
        switch item {
        case "Overview":
            MacOverviewDashboardView(snapshot: model.snapshot, reviewItems: model.reviewItems)
        case "PO Boxes":
            MacMailboxListView(snapshot: model.snapshot, busyMailboxId: model.busyMailboxId, collect: { mailbox in
                await model.collect(mailbox)
            }, updateMailbox: { mailbox, postOfficeId, boxNumber in
                await model.updateMailbox(mailbox, postOfficeId: postOfficeId, boxNumber: boxNumber)
            }, deleteMailbox: { mailbox in
                await model.deleteMailbox(mailbox)
            })
        case "Map":
            MacMapView(snapshot: model.snapshot, updatePostOffice: { office, name, address, phone, latitude, longitude, radius in
                await model.updatePostOffice(office, name: name, address: address, phone: phone, latitude: latitude, longitude: longitude, geofenceRadius: radius)
            }, deletePostOffice: { office in
                await model.deletePostOffice(office)
            })
        case "History":
            MacHistoryView(snapshot: model.snapshot, mode: .history)
        case "Activity":
            MacHistoryView(snapshot: model.snapshot, mode: .activity)
        case "Needs Review":
            MacNeedsReviewView(reviewItems: model.reviewItems)
        case "Team":
            MacTeamView(snapshot: model.snapshot, members: model.members) { email, displayName, password, role in
                await model.createUser(email: email, displayName: displayName, password: password, role: role)
            } updateUser: { member, email, displayName, role in
                await model.updateUser(member, email: email, displayName: displayName, role: role)
            } deleteUser: { member in
                await model.deleteUser(member)
            }
        case "Settings":
            MacSettingsView(snapshot: model.snapshot, logout: {
                await model.logout()
            }, locationResults: model.postOfficeLocationResults, searchPostOfficeLocations: { query in
                await model.searchPostOfficeLocations(query: query)
            }, createPostOffice: { name, address, phone, latitude, longitude, radius in
                await model.createPostOffice(name: name, address: address, phone: phone, latitude: latitude, longitude: longitude, geofenceRadius: radius)
            }, createMailbox: { postOfficeId, boxNumber in
                await model.createMailbox(postOfficeId: postOfficeId, boxNumber: boxNumber)
            })
        default:
            MacEmptyStateView(title: item, subtitle: "No information is available for this section.")
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

struct MacOverviewDashboardView: View {
    let snapshot: MailboxDashboardSnapshot?
    let reviewItems: [ReviewItem]

    private var waitingMailboxes: [Mailbox] {
        snapshot?.postOffices.flatMap(\.mailboxes).filter(\.mailWaiting) ?? []
    }

    var body: some View {
        MacPage(title: snapshot?.workspace.name ?? "Overview", subtitle: signedInText) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
                MacMetricCard(value: "\(snapshot?.outstandingMailboxCount ?? 0)", label: "PO boxes needing collection", systemImage: "tray.full.fill", tint: .orange)
                MacMetricCard(value: "\(snapshot?.postOffices.count ?? 0)", label: "Post office locations", systemImage: "building.2", tint: .blue)
                MacMetricCard(value: "\(reviewItems.count)", label: "Review queue items", systemImage: "exclamationmark.triangle.fill", tint: .red)
            }

            MacPanel(title: "Collection Queue", aside: "\(waitingMailboxes.count) waiting") {
                if waitingMailboxes.isEmpty {
                    MacEmptyStateView(title: "Nothing waiting", subtitle: "All shared PO boxes are currently clear.")
                } else {
                    ForEach(waitingMailboxes) { mailbox in
                        MacInfoRow(
                            title: mailbox.name,
                            detail: "PO Box \(mailbox.boxNumber)",
                            systemImage: "tray.full.fill",
                            tint: .orange
                        )
                    }
                }
            }

            if let nextOffice = snapshot?.postOffices.first(where: { $0.mailboxes.contains(where: \.mailWaiting) }) {
                MacPanel(title: "Next Location", aside: "Apple Maps") {
                    HStack(spacing: 12) {
                        Image(systemName: "map.fill")
                            .foregroundStyle(.blue)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(nextOffice.name)
                                .font(.headline)
                            Text(nextOffice.address)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button {
                            openAppleMaps(nextOffice)
                        } label: {
                            Label("Open in Apple Maps", systemImage: "arrow.up.right.square")
                        }
                    }
                    .padding(14)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    private var signedInText: String {
        guard let snapshot else { return "Loading live pobox.watch data." }
        return "Signed in as \(snapshot.currentUser.displayName)."
    }
}

struct MacMailboxListView: View {
    let snapshot: MailboxDashboardSnapshot?
    let busyMailboxId: String?
    let collect: (Mailbox) async -> Void
    let updateMailbox: (Mailbox, String, String) async -> Void
    let deleteMailbox: (Mailbox) async -> Void

    var body: some View {
        MacPage(title: "PO Boxes", subtitle: "Live shared state from pobox.watch.") {
            ForEach(snapshot?.postOffices ?? []) { office in
                MacPanel(title: office.name, aside: office.address) {
                    ForEach(office.mailboxes) { mailbox in
                        MacMailboxManageRow(
                            mailbox: mailbox,
                            postOffices: snapshot?.postOffices ?? [],
                            busy: busyMailboxId == mailbox.id,
                            collect: collect,
                            updateMailbox: updateMailbox,
                            deleteMailbox: deleteMailbox
                        )
                    }
                }
            }
        }
    }
}

struct MacMailboxManageRow: View {
    let mailbox: Mailbox
    let postOffices: [PostOffice]
    let busy: Bool
    let collect: (Mailbox) async -> Void
    let updateMailbox: (Mailbox, String, String) async -> Void
    let deleteMailbox: (Mailbox) async -> Void
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var postOfficeId = ""
    @State private var boxNumber = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: mailbox.mailWaiting ? "tray.full.fill" : "checkmark.circle.fill")
                    .foregroundStyle(mailbox.mailWaiting ? .orange : .green)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(mailbox.name)
                        .font(.headline)
                    Text(mailbox.mailWaiting ? "Mail waiting in PO Box \(mailbox.boxNumber)" : "PO Box \(mailbox.boxNumber) is clear")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if mailbox.mailWaiting {
                    Button {
                        Task { await collect(mailbox) }
                    } label: {
                        Label("Collect", systemImage: "checkmark.circle")
                    }
                    .disabled(busy)
                }
                Button {
                    postOfficeId = mailbox.postOfficeId
                    boxNumber = mailbox.boxNumber
                    editing.toggle()
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }

            if editing {
                HStack {
                    Picker("Post office", selection: $postOfficeId) {
                        ForEach(postOffices) { office in
                            Text(office.name).tag(office.id)
                        }
                    }
                    TextField("PO Box Number", text: $boxNumber)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        Task {
                            await updateMailbox(mailbox, postOfficeId, boxNumber)
                            editing = false
                        }
                    } label: {
                        Label("Save", systemImage: "checkmark")
                    }
                    .disabled(postOfficeId.isEmpty || boxNumber.isEmpty)
                }
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .confirmationDialog("Delete PO Box \(mailbox.boxNumber)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete PO Box", role: .destructive) {
                Task { await deleteMailbox(mailbox) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the PO box from active pobox.watch views.")
        }
    }
}

struct MacMapView: View {
    let snapshot: MailboxDashboardSnapshot?
    let updatePostOffice: (PostOffice, String, String, String?, Double, Double, Int) async -> Void
    let deletePostOffice: (PostOffice) async -> Void

    var body: some View {
        MacPage(title: "Map", subtitle: "Open post office locations in Apple Maps.") {
            ForEach(snapshot?.postOffices ?? []) { office in
                MacOfficeRow(office: office, updatePostOffice: updatePostOffice, deletePostOffice: deletePostOffice)
            }
        }
    }
}

struct MacHistoryView: View {
    enum Mode {
        case history
        case activity
    }

    let snapshot: MailboxDashboardSnapshot?
    let mode: Mode

    var body: some View {
        MacPage(title: mode == .history ? "History" : "Activity", subtitle: subtitle) {
            let events = Array(snapshot?.history.prefix(40) ?? [])
            if events.isEmpty {
                MacEmptyStateView(title: "No activity yet", subtitle: "New detections and collection events will appear here.")
            } else {
                ForEach(events) { event in
                    MacInfoRow(title: title(for: event), detail: detail(for: event), systemImage: icon(for: event), tint: tint(for: event))
                }
            }
        }
    }

    private var subtitle: String {
        mode == .history ? "Recent mail detections and collection records." : "Operational feed for the shared workspace."
    }

    private func title(for event: MailboxHistoryEvent) -> String {
        switch event {
        case .mail(let mail): mail.subject
        case .collection(let collection): "Collected by \(collection.collectedBy)"
        }
    }

    private func detail(for event: MailboxHistoryEvent) -> String {
        switch event {
        case .mail(let mail):
            return "\(mail.sender) - confidence \(Int(mail.parserConfidence * 100))% - \(mail.processedAt)"
        case .collection(let collection):
            return "\(collection.source.rawValue) - \(collection.collectedAt)"
        }
    }

    private func icon(for event: MailboxHistoryEvent) -> String {
        switch event {
        case .mail: "envelope.badge"
        case .collection: "checkmark.circle"
        }
    }

    private func tint(for event: MailboxHistoryEvent) -> Color {
        switch event {
        case .mail(let mail): mail.parserConfidence < 0.8 ? .red : .blue
        case .collection: .green
        }
    }
}

struct MacNeedsReviewView: View {
    let reviewItems: [ReviewItem]

    var body: some View {
        MacPage(title: "Needs Review", subtitle: "Parser exceptions and low-confidence mail detections.") {
            if reviewItems.isEmpty {
                MacEmptyStateView(title: "Queue clear", subtitle: "No review items are waiting.")
            } else {
                ForEach(reviewItems) { item in
                    MacInfoRow(
                        title: item.subject ?? "Unmatched mail notice",
                        detail: reviewDetail(item),
                        systemImage: "exclamationmark.triangle.fill",
                        tint: .red
                    )
                }
            }
        }
    }

    private func reviewDetail(_ item: ReviewItem) -> String {
        let box = item.mailboxNumber.map { "PO Box \($0)" } ?? "No PO box match"
        let confidence = item.confidence.map { "confidence \(Int($0 * 100))%" } ?? "confidence unknown"
        return "\(box) - \(confidence) - \(item.createdAt)"
    }
}

struct MacTeamView: View {
    let snapshot: MailboxDashboardSnapshot?
    let members: [TeamMember]
    let createUser: (String, String, String, String) async -> Void
    let updateUser: (TeamMember, String, String, String) async -> Void
    let deleteUser: (TeamMember) async -> Void

    var body: some View {
        MacPage(title: "Team", subtitle: "Users with access to this pobox.watch workspace.") {
            MacInfoRow(title: snapshot?.currentUser.displayName ?? "Unknown user", detail: snapshot?.currentUser.email ?? "No email loaded", systemImage: "person.crop.circle", tint: .blue)
            MacInfoRow(title: "Role", detail: snapshot?.currentUser.role ?? "Unknown", systemImage: "person.badge.key", tint: .purple)

            MacPanel(title: "Members", aside: "\(members.count) users") {
                if members.isEmpty {
                    MacEmptyStateView(title: "No team list loaded", subtitle: "Refresh after signing in to load the workspace members.")
                } else {
                    ForEach(members) { member in
                        MacTeamMemberRow(
                            member: member,
                            currentUserId: snapshot?.currentUser.id,
                            updateUser: updateUser,
                            deleteUser: deleteUser
                        )
                    }
                }
            }

            if snapshot?.currentUser.role == "ADMIN" {
                MacCreateUserForm(createUser: createUser)
            } else {
                MacInfoRow(title: "Admin required", detail: "Only admins can create new users.", systemImage: "lock", tint: .orange)
            }
        }
    }
}

struct MacSettingsView: View {
    let snapshot: MailboxDashboardSnapshot?
    let logout: () async -> Void
    let locationResults: [PostOfficeLocationResult]
    let searchPostOfficeLocations: (String) async -> Void
    let createPostOffice: (String, String, String?, Double, Double, Int) async -> Void
    let createMailbox: (String, String) async -> Void

    var body: some View {
        MacPage(title: "Settings", subtitle: "Configuration for this native pobox.watch client.") {
            MacInfoRow(title: "Server", detail: "https://pobox.watch", systemImage: "network", tint: .blue)
            MacInfoRow(title: "Workspace", detail: snapshot?.workspace.name ?? "Unknown", systemImage: "building.2", tint: .green)
            MacInfoRow(title: "Security", detail: "Passkey and authenticator setup is mandatory. Use the web app to add passkeys and manage setup.", systemImage: "key.fill", tint: .orange)

            if snapshot?.currentUser.role == "ADMIN" {
                MacCreatePostOfficeForm(locationResults: locationResults, searchPostOfficeLocations: searchPostOfficeLocations, createPostOffice: createPostOffice)
                MacCreateMailboxForm(postOffices: snapshot?.postOffices ?? [], createMailbox: createMailbox)
            } else {
                MacInfoRow(title: "Admin required", detail: "Only admins can add post offices and PO boxes.", systemImage: "lock", tint: .orange)
            }

            Button {
                Task { await logout() }
            } label: {
                Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .buttonStyle(.borderedProminent)
        }
    }
}

struct MacCreateUserForm: View {
    let createUser: (String, String, String, String) async -> Void
    @State private var displayName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var role = "MEMBER"

    var body: some View {
        MacPanel(title: "Add User", aside: "Admin") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Name", text: $displayName)
                    .textFieldStyle(.roundedBorder)
                TextField("Email", text: $email)
                    .textFieldStyle(.roundedBorder)
                SecureField("Temporary password", text: $password)
                    .textFieldStyle(.roundedBorder)
                Picker("Role", selection: $role) {
                    Text("Member").tag("MEMBER")
                    Text("Admin").tag("ADMIN")
                }
                .pickerStyle(.segmented)
                Button {
                    Task {
                        await createUser(email, displayName, password, role)
                        displayName = ""
                        email = ""
                        password = ""
                        role = "MEMBER"
                    }
                } label: {
                    Label("Create User", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(displayName.isEmpty || email.isEmpty || password.count < 12)
            }
            .frame(maxWidth: 480, alignment: .leading)
        }
    }
}

struct MacTeamMemberRow: View {
    let member: TeamMember
    let currentUserId: String?
    let updateUser: (TeamMember, String, String, String) async -> Void
    let deleteUser: (TeamMember) async -> Void
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var displayName = ""
    @State private var email = ""
    @State private var role = "MEMBER"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: member.active ? "person.crop.circle.badge.checkmark" : "person.crop.circle.badge.xmark")
                    .foregroundStyle(member.active ? .green : .gray)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 4) {
                    Text(member.displayName)
                        .font(.headline)
                    Text("\(member.email) - \(member.role) - \(member.status)")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    displayName = member.displayName
                    email = member.email
                    role = member.role
                    editing.toggle()
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .disabled(member.id == currentUserId)
            }

            if editing {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Name", text: $displayName)
                        .textFieldStyle(.roundedBorder)
                    TextField("Email", text: $email)
                        .textFieldStyle(.roundedBorder)
                    Picker("Role", selection: $role) {
                        Text("Member").tag("MEMBER")
                        Text("Admin").tag("ADMIN")
                    }
                    .pickerStyle(.segmented)
                    .disabled(member.id == currentUserId)
                    Button {
                        Task {
                            await updateUser(member, email, displayName, role)
                            editing = false
                        }
                    } label: {
                        Label("Save", systemImage: "checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(displayName.isEmpty || email.isEmpty)
                }
                .frame(maxWidth: 480, alignment: .leading)
            }
        }
        .padding(14)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .confirmationDialog("Delete \(member.displayName)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete User", role: .destructive) {
                Task { await deleteUser(member) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This disables their pobox.watch access.")
        }
    }
}

struct MacCreatePostOfficeForm: View {
    let locationResults: [PostOfficeLocationResult]
    let searchPostOfficeLocations: (String) async -> Void
    let createPostOffice: (String, String, String?, Double, Double, Int) async -> Void
    @State private var query = ""
    @State private var name = ""
    @State private var address = ""
    @State private var phone = ""
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var geofenceRadius = "200"
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        MacPanel(title: "Add Post Office", aside: "Admin") {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    TextField("Search LCTR by suburb, postcode, or post office name", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: query) { _, newValue in
                            scheduleSearch(newValue)
                        }
                    Button {
                        Task { await searchPostOfficeLocations(query) }
                    } label: {
                        Label("Search", systemImage: "magnifyingglass")
                    }
                    .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
                }

                if !locationResults.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(locationResults) { location in
                            Button {
                                select(location)
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(location.name)
                                        .font(.headline)
                                    Text(location.address)
                                        .foregroundStyle(.secondary)
                                    Text([location.phone, location.hours].compactMap(\.self).joined(separator: " - "))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .padding(10)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }

                TextField("Name", text: $name)
                    .textFieldStyle(.roundedBorder)
                TextField("Address", text: $address)
                    .textFieldStyle(.roundedBorder)
                TextField("Phone", text: $phone)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    TextField("Latitude", text: $latitude)
                        .textFieldStyle(.roundedBorder)
                    TextField("Longitude", text: $longitude)
                        .textFieldStyle(.roundedBorder)
                    TextField("Radius", text: $geofenceRadius)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 90)
                }
                Button {
                    Task {
                        await createPostOffice(name, address, phone.isEmpty ? nil : phone, Double(latitude) ?? 0, Double(longitude) ?? 0, Int(geofenceRadius) ?? 200)
                        query = ""
                        name = ""
                        address = ""
                        phone = ""
                        latitude = ""
                        longitude = ""
                        geofenceRadius = "200"
                    }
                } label: {
                    Label("Create Post Office", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(name.isEmpty || address.isEmpty || Double(latitude) == nil || Double(longitude) == nil || Int(geofenceRadius) == nil)
            }
            .frame(maxWidth: 560, alignment: .leading)
        }
    }

    private func select(_ location: PostOfficeLocationResult) {
        name = location.name
        address = location.address
        phone = location.phone ?? ""
        latitude = String(location.latitude)
        longitude = String(location.longitude)
    }

    private func scheduleSearch(_ value: String) {
        searchTask?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await searchPostOfficeLocations(trimmed)
        }
    }
}

struct MacCreateMailboxForm: View {
    let postOffices: [PostOffice]
    let createMailbox: (String, String) async -> Void
    @State private var postOfficeId = ""
    @State private var boxNumber = ""

    var body: some View {
        MacPanel(title: "Add PO Box", aside: "Admin") {
            VStack(alignment: .leading, spacing: 10) {
                Picker("Post office", selection: $postOfficeId) {
                    ForEach(postOffices) { office in
                        Text(office.name).tag(office.id)
                    }
                }
                .onAppear {
                    if postOfficeId.isEmpty {
                        postOfficeId = postOffices.first?.id ?? ""
                    }
                }
                TextField("PO Box Number", text: $boxNumber)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task {
                        await createMailbox(postOfficeId, boxNumber)
                        boxNumber = ""
                    }
                } label: {
                    Label("Create PO Box", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(postOfficeId.isEmpty || boxNumber.isEmpty)
            }
            .frame(maxWidth: 560, alignment: .leading)
        }
    }
}

struct MacOfficeRow: View {
    let office: PostOffice
    let updatePostOffice: (PostOffice, String, String, String?, Double, Double, Int) async -> Void
    let deletePostOffice: (PostOffice) async -> Void
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var name = ""
    @State private var address = ""
    @State private var phone = ""
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var geofenceRadius = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "map.fill")
                    .foregroundStyle(.blue)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(office.name)
                        .font(.headline)
                    Text([office.address, office.phone, "\(office.geofenceRadius)m geofence"].compactMap(\.self).joined(separator: " - "))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    openAppleMaps(office)
                } label: {
                    Label("Open in Apple Maps", systemImage: "arrow.up.right.square")
                }
                Button {
                    name = office.name
                    address = office.address
                    phone = office.phone ?? ""
                    latitude = String(office.latitude)
                    longitude = String(office.longitude)
                    geofenceRadius = String(office.geofenceRadius)
                    editing.toggle()
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }

            if editing {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Name", text: $name)
                        .textFieldStyle(.roundedBorder)
                    TextField("Address", text: $address)
                        .textFieldStyle(.roundedBorder)
                    TextField("Phone", text: $phone)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        TextField("Latitude", text: $latitude)
                            .textFieldStyle(.roundedBorder)
                        TextField("Longitude", text: $longitude)
                            .textFieldStyle(.roundedBorder)
                        TextField("Radius", text: $geofenceRadius)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 90)
                    }
                    Button {
                        Task {
                            await updatePostOffice(office, name, address, phone.isEmpty ? nil : phone, Double(latitude) ?? office.latitude, Double(longitude) ?? office.longitude, Int(geofenceRadius) ?? office.geofenceRadius)
                            editing = false
                        }
                    } label: {
                        Label("Save", systemImage: "checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(name.isEmpty || address.isEmpty || Double(latitude) == nil || Double(longitude) == nil || Int(geofenceRadius) == nil)
                }
                .frame(maxWidth: 560, alignment: .leading)
            }
        }
        .padding(14)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .confirmationDialog("Delete \(office.name)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Post Office", role: .destructive) {
                Task { await deletePostOffice(office) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This also removes its PO boxes from active pobox.watch views.")
        }
    }
}

struct MacMetricCard: View {
    let value: String
    let label: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
            Text(value)
                .font(.system(size: 34, weight: .bold))
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct MacInfoRow: View {
    let title: String
    let detail: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(14)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct MacPanel<Content: View>: View {
    let title: String
    let aside: String?
    @ViewBuilder let content: Content

    init(title: String, aside: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.aside = aside
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title)
                    .font(.title3.bold())
                Spacer()
                if let aside {
                    Text(aside)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            content
        }
        .frame(maxWidth: 840, alignment: .leading)
    }
}

struct MacPage<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let content: Content

    init(title: String, subtitle: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(title)
                        .font(.largeTitle.bold())
                    Text(subtitle)
                        .foregroundStyle(.secondary)
                }
                content
                Spacer(minLength: 20)
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct MacEmptyStateView: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
            Text(subtitle)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: 720, alignment: .leading)
        .padding(14)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
}

private func openAppleMaps(_ office: PostOffice) {
    NSWorkspace.shared.open(appleMapsURL(for: office))
}

private func appleMapsURL(for office: PostOffice) -> URL {
    var components = URLComponents(string: "https://maps.apple.com/")!
    components.queryItems = [
        URLQueryItem(name: "ll", value: "\(office.latitude),\(office.longitude)"),
        URLQueryItem(name: "q", value: office.name)
    ]
    return components.url!
}
