import SwiftUI
import PoboxWatchShared
import AppKit

@main
struct PoboxWatchMacOSApp: App {
    @NSApplicationDelegateAdaptor(PoboxWatchMacOSAppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

@MainActor
final class PoboxWatchMacOSAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let model = MacMailboxViewModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "pobox.watch"
        window.contentMinSize = NSSize(width: 940, height: 620)
        window.contentView = NSHostingView(rootView: MacRootView(model: model))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    @objc private func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent replyEvent: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: urlString)
        else { return }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            await model.consumeNativeHandoff(from: url)
        }
    }
}

@MainActor
final class MacMailboxViewModel: ObservableObject {
    @Published var email = ""
    @Published var password = ""
    @Published var twoFactorCode = ""
    @Published var twoFactorChallengeId: String?
    @Published var snapshot: MailboxDashboardSnapshot?
    @Published var releaseNotice: ReleaseNotice?
    @Published var reviewItems: [ReviewItem] = []
    @Published var members: [TeamMember] = []
    @Published var postOfficeLocationResults: [PostOfficeLocationResult] = []
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var busyMailboxId: String?
    @Published var passwordMode = false

    private let client = PoboxWatchAPIClient.live
    private let workspaceId = "ws_company"
    private var loadGeneration = 0
    private var nativeSignInProof: NativeSignInProof?

    func openPasskeySignIn() {
        guard let loginEmail = validatedLoginEmail() else { return }
        let proof = NativeSignInProof()
        nativeSignInProof = proof
        guard var components = URLComponents(string: "https://pobox.watch") else { return }
        components.queryItems = [
            URLQueryItem(name: "nativeReturn", value: "poboxwatch://auth"),
            URLQueryItem(name: "nativeChallenge", value: proof.challenge),
            URLQueryItem(name: "email", value: loginEmail)
        ]
        guard let url = components.url else { return }
        NSWorkspace.shared.open(url)
    }

    private func validatedLoginEmail() -> String? {
        let value = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let pattern = #"^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$"#
        let isValid = value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        if !isValid {
            errorMessage = "Enter a valid email address before continuing with passkey sign-in."
            return nil
        }
        email = value
        errorMessage = nil
        return value
    }

    func consumeNativeHandoff(from url: URL) async {
        guard let proof = nativeSignInProof, url.scheme == "poboxwatch",
              url.host == "auth",
              let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "code" })?
                .value
        else { return }
        nativeSignInProof = nil
        await run {
            _ = try await client.consumeNativeHandoff(code: code, verifier: proof.verifier)
            passwordMode = false
            password = ""
            twoFactorChallengeId = nil
            twoFactorCode = ""
            try await loadWorkspace()
        }
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
            try await client.collectMailbox(workspaceId: workspaceId, mailboxId: mailbox.id, source: .macOS, expectedUpdatedAt: mailbox.updatedAt)
            try await loadWorkspace()
        }
    }

    func logout() async {
        loadGeneration += 1
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
        loadGeneration += 1
        let generation = loadGeneration
        async let dashboard = client.dashboard(workspaceId: workspaceId)
        async let reviews = client.reviewItems(workspaceId: workspaceId)
        async let team = client.teamMembers(workspaceId: workspaceId)
        async let notice = client.releaseNotes(workspaceId: workspaceId)
        let values = try await (dashboard, reviews, team, notice)
        guard generation == loadGeneration else { return }
        snapshot = values.0
        reviewItems = values.1
        members = values.2
        releaseNotice = values.3.changes.isEmpty ? nil : values.3
    }

    func dismissReleaseNotes() async {
        guard let version = releaseNotice?.version else { return }
        loadGeneration += 1
        await run {
            let remaining = try await client.releaseNotes(workspaceId: workspaceId, dismissVersion: version)
            releaseNotice = remaining.changes.isEmpty ? nil : remaining
        }
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

    func updateUser(_ member: TeamMember, email: String, displayName: String, role: String, status: String) async {
        await run {
            _ = try await client.updateUser(
                workspaceId: workspaceId,
                userId: member.id,
                input: UpdateUserInput(email: email, displayName: displayName, role: role, status: status, expectedVersion: member.version)
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
                input: UpdatePostOfficeInput(name: name, address: address, phone: phone, latitude: latitude, longitude: longitude, geofenceRadius: geofenceRadius, expectedUpdatedAt: office.updatedAt)
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
                input: UpdateMailboxInput(postOfficeId: postOfficeId, boxNumber: boxNumber, expectedUpdatedAt: mailbox.updatedAt)
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

    func resolveReviewItem(_ item: ReviewItem, mailboxId: String) async {
        await run {
            try await client.resolveReviewItem(workspaceId: workspaceId, reviewItemId: item.id, mailboxId: mailboxId)
            try await loadWorkspace()
        }
    }

    func createMailboxFromReview(_ item: ReviewItem, postOfficeId: String, boxNumber: String) async {
        await run {
            let mailbox = try await client.createMailbox(
                workspaceId: workspaceId,
                input: CreateMailboxInput(postOfficeId: postOfficeId, boxNumber: boxNumber)
            )
            try await client.resolveReviewItem(workspaceId: workspaceId, reviewItemId: item.id, mailboxId: mailbox.id)
            try await loadWorkspace()
        }
    }

    func markReviewItemResolved(_ item: ReviewItem) async {
        await run {
            try await client.markReviewItemResolved(workspaceId: workspaceId, reviewItemId: item.id)
            try await loadWorkspace()
        }
    }

    func dismissReviewItem(_ item: ReviewItem) async {
        await run {
            try await client.dismissReviewItem(workspaceId: workspaceId, reviewItemId: item.id)
            try await loadWorkspace()
        }
    }

    private func run(_ operation: () async throws -> Void) async {
        isLoading = true
        errorMessage = nil
        do {
            try await operation()
        } catch {
            if case PoboxWatchAPIError.authenticationRequired = error {
                snapshot = nil
                members = []
                reviewItems = []
            }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Load failed. Check your connection and login details."
        }
        isLoading = false
    }
}

struct MacRootView: View {
    @StateObject private var model: MacMailboxViewModel

    init(model: MacMailboxViewModel = MacMailboxViewModel()) {
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        if model.snapshot == nil {
            MacLoginView(model: model)
        } else {
           MacOverviewView(model: model)
                .sheet(item: $model.releaseNotice) { notice in
                    VStack(alignment: .leading, spacing: 16) {
                        Text("What's New").font(.title2.bold())
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                ForEach(notice.changes) { change in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(change.title).font(.headline)
                                        Text(change.summary)
                                    }
                                }
                            }
                        }
                        if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                        Button("Got It") { Task { await model.dismissReleaseNotes() } }
                            .disabled(model.isLoading)
                    }
                    .padding(24)
                    .frame(minWidth: 280, idealWidth: 560, maxWidth: 640, minHeight: 360, idealHeight: 520)
                    .interactiveDismissDisabled()
                }
                .task(id: model.snapshot?.currentUser.id) {
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(30)) } catch { return }
                        if !model.isLoading { await model.refresh() }
                    }
                }
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
                    .disabled(model.isLoading || model.email.isEmpty)

                    Button("Use Password to Set Up Security") {
                        model.passwordMode = true
                    }
                }

                if model.isLoading {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            Text("Passkey sign-in opens pobox.watch in your browser and returns here automatically after your account is secure.")
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
    private let items = ["Overview", "Post Offices", "Map", "History", "Activity", "Needs Review", "Team", "Settings"]

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
        case "Post Offices":
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
            MacNeedsReviewView(
                snapshot: model.snapshot,
                reviewItems: model.reviewItems,
                resolveReviewItem: { item, mailboxId in
                    await model.resolveReviewItem(item, mailboxId: mailboxId)
                },
                createMailboxFromReview: { item, postOfficeId, boxNumber in
                    await model.createMailboxFromReview(item, postOfficeId: postOfficeId, boxNumber: boxNumber)
                },
                markReviewItemResolved: { item in
                    await model.markReviewItemResolved(item)
                },
                dismissReviewItem: { item in
                    await model.dismissReviewItem(item)
                }
            )
        case "Team":
            MacTeamView(snapshot: model.snapshot, members: model.members) { email, displayName, password, role in
                await model.createUser(email: email, displayName: displayName, password: password, role: role)
            } updateUser: { member, email, displayName, role, status in
                await model.updateUser(member, email: email, displayName: displayName, role: role, status: status)
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
        snapshot?.postOffices.flatMap(\.mailboxes).filter(hasWaitingItem) ?? []
    }

    var body: some View {
        MacPage(title: snapshot?.workspace.name ?? "Overview", subtitle: signedInText) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
                MacMetricCard(value: "\(snapshot?.outstandingMailboxCount ?? 0)", label: "Boxes needing collection", systemImage: "tray.full.fill", tint: .orange)
                MacMetricCard(value: "\(snapshot?.postOffices.count ?? 0)", label: "Post office locations", systemImage: "building.2", tint: .blue)
                MacMetricCard(value: "\(reviewItems.count)", label: "Review queue items", systemImage: "exclamationmark.triangle.fill", tint: .red)
            }

            MacPanel(title: "Collection Queue", aside: "\(waitingMailboxes.count) waiting") {
                if waitingMailboxes.isEmpty {
                    MacEmptyStateView(title: "Nothing waiting", subtitle: "All shared boxes are currently clear.")
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

            if let nextOffice = snapshot?.postOffices.first(where: { $0.mailboxes.contains(where: hasWaitingItem) }) {
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
        MacPage(title: "Post Offices", subtitle: "Post offices with their assigned boxes.") {
            ForEach(snapshot?.postOffices ?? []) { office in
                MacPanel(title: office.name, aside: office.address) {
                    if office.mailboxes.isEmpty {
                        MacEmptyStateView(title: "No PO box assigned", subtitle: "This post office can be deleted or given a PO box.")
                    } else {
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
                Image(systemName: hasWaitingItem(mailbox) ? "tray.full.fill" : "checkmark.circle.fill")
                    .foregroundStyle(hasWaitingItem(mailbox) ? .orange : .green)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(mailbox.name)
                        .font(.headline)
                    Text(mailboxStatusLine(mailbox))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if hasWaitingItem(mailbox) {
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
    let snapshot: MailboxDashboardSnapshot?
    let reviewItems: [ReviewItem]
    let resolveReviewItem: (ReviewItem, String) async -> Void
    let createMailboxFromReview: (ReviewItem, String, String) async -> Void
    let markReviewItemResolved: (ReviewItem) async -> Void
    let dismissReviewItem: (ReviewItem) async -> Void

    var body: some View {
        MacPage(title: "Needs Review", subtitle: "Parser exceptions and low-confidence mail detections.") {
            if reviewItems.isEmpty {
                MacEmptyStateView(title: "Queue clear", subtitle: "No review items are waiting.")
            } else {
                MacPanel(title: "Review Queue", aside: "\(reviewItems.count) items") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(reviewItems) { item in
                            MacReviewItemRow(
                                item: item,
                                postOffices: snapshot?.postOffices ?? [],
                                mailboxChoices: mailboxChoices(from: snapshot),
                                resolveReviewItem: resolveReviewItem,
                                createMailboxFromReview: createMailboxFromReview,
                                markReviewItemResolved: markReviewItemResolved,
                                dismissReviewItem: dismissReviewItem
                            )
                        }
                    }
                }
            }
        }
    }

    private func mailboxChoices(from snapshot: MailboxDashboardSnapshot?) -> [MacMailboxChoice] {
        snapshot?.postOffices.flatMap { office in
            office.mailboxes.map { mailbox in
                MacMailboxChoice(id: mailbox.id, officeName: office.name, mailbox: mailbox)
            }
        } ?? []
    }
}

private struct MacMailboxChoice: Identifiable {
    let id: String
    let officeName: String
    let mailbox: Mailbox

    var label: String {
        "\(officeName) - PO Box \(mailbox.boxNumber)"
    }
}

private struct MacReviewItemRow: View {
    let item: ReviewItem
    let postOffices: [PostOffice]
    let mailboxChoices: [MacMailboxChoice]
    let resolveReviewItem: (ReviewItem, String) async -> Void
    let createMailboxFromReview: (ReviewItem, String, String) async -> Void
    let markReviewItemResolved: (ReviewItem) async -> Void
    let dismissReviewItem: (ReviewItem) async -> Void

    @State private var selectedMailboxId = ""
    @State private var createPostOfficeId = ""
    @State private var createBoxNumber = ""
    @State private var confirmIgnore = false
    @State private var confirmResolved = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: item.notificationType == "PARCEL" ? "shippingbox.fill" : "envelope.badge.fill")
                    .foregroundStyle(.orange)
                    .frame(width: 22)

                VStack(alignment: .leading, spacing: 5) {
                    Text(item.subject ?? "Unmatched mail notification")
                        .font(.headline)
                    Text(reviewSummary)
                        .foregroundStyle(.secondary)
                    if let preview = item.bodyPreview, !preview.isEmpty {
                        Text(preview)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                }

                Spacer()

                Button(role: .destructive) {
                    confirmIgnore = true
                } label: {
                    Label("Ignore", systemImage: "xmark.circle")
                }

                Button {
                    confirmResolved = true
                } label: {
                    Label("Mark Resolved", systemImage: "checkmark.circle")
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 10) {
                Text("Match to an existing PO box")
                    .font(.subheadline.weight(.semibold))

                if mailboxChoices.isEmpty {
                    Text("No saved PO boxes are available yet.")
                        .foregroundStyle(.secondary)
                } else {
                    Picker("PO box", selection: $selectedMailboxId) {
                        ForEach(mailboxChoices) { choice in
                            Text(choice.label).tag(choice.id)
                        }
                    }
                    .pickerStyle(.menu)

                    Button {
                        Task { await resolveReviewItem(item, selectedMailboxId) }
                    } label: {
                        Label("Match Existing Box", systemImage: "link")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selectedMailboxId.isEmpty)
                }
            }

            if item.mailboxNumber != nil || item.postOfficeName != nil {
                Divider()

                VStack(alignment: .leading, spacing: 10) {
                    Text("Create missing PO box")
                        .font(.subheadline.weight(.semibold))

                    if postOffices.isEmpty {
                        Text("Add a post office first, then return to this review item.")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Post office", selection: $createPostOfficeId) {
                            ForEach(postOffices) { office in
                                Text(office.name).tag(office.id)
                            }
                        }
                        .pickerStyle(.menu)

                        TextField("PO Box Number", text: $createBoxNumber)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 240)

                        Button {
                            Task { await createMailboxFromReview(item, createPostOfficeId, createBoxNumber.trimmingCharacters(in: .whitespacesAndNewlines)) }
                        } label: {
                            Label("Create and Resolve", systemImage: "plus.circle")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(createPostOfficeId.isEmpty || createBoxNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
        .padding(14)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .onAppear(perform: prepareDefaults)
        .confirmationDialog("Ignore this review item?", isPresented: $confirmIgnore, titleVisibility: .visible) {
            Button("Ignore Item", role: .destructive) {
                Task { await dismissReviewItem(item) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The review item will be removed and its source email can be handled on the next poll.")
        }
        .confirmationDialog("Mark this review item resolved?", isPresented: $confirmResolved, titleVisibility: .visible) {
            Button("Mark Resolved") {
                Task { await markReviewItemResolved(item) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Use this only when no PO box status change is needed.")
        }
    }

    private var reviewSummary: String {
        [
            "Received \(displayDate(item.receivedAt ?? item.createdAt))",
            item.sender.map { "from \($0)" },
            "reason: \(item.reason ?? "Needs manual review")",
            parsedGuess,
            confidenceText
        ]
            .compactMap(\.self)
            .joined(separator: " - ")
    }

    private var parsedGuess: String {
        if let number = item.mailboxNumber, !number.isEmpty {
            return "guess: PO Box \(number)"
        }
        if let office = item.postOfficeName, !office.isEmpty {
            return "guess: \(office)"
        }
        return "guess: none"
    }

    private var confidenceText: String? {
        item.confidence.map { "confidence \(Int($0 * 100))%" }
    }

    private func prepareDefaults() {
        if selectedMailboxId.isEmpty {
            selectedMailboxId = preferredMailboxChoice()?.id ?? mailboxChoices.first?.id ?? ""
        }
        if createPostOfficeId.isEmpty {
            createPostOfficeId = preferredPostOffice()?.id ?? postOffices.first?.id ?? ""
        }
        if createBoxNumber.isEmpty {
            createBoxNumber = item.mailboxNumber ?? ""
        }
    }

    private func preferredMailboxChoice() -> MacMailboxChoice? {
        guard let mailboxNumber = item.mailboxNumber else { return nil }
        return mailboxChoices.first { normalizeBoxNumber($0.mailbox.boxNumber) == normalizeBoxNumber(mailboxNumber) }
    }

    private func preferredPostOffice() -> PostOffice? {
        guard let postOfficeName = item.postOfficeName else { return nil }
        return postOffices.first { normalizeLocationName($0.name) == normalizeLocationName(postOfficeName) }
    }
}

private func normalizeBoxNumber(_ value: String) -> String {
    value.filter(\.isNumber)
}

private func normalizeLocationName(_ value: String) -> String {
    value
        .lowercased()
        .replacingOccurrences(of: "local post office", with: "")
        .replacingOccurrences(of: "post office", with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func displayDate(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "unknown time" }
    let formatters: [ISO8601DateFormatter] = {
        let withFractionalSeconds = ISO8601DateFormatter()
        withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return [withFractionalSeconds, standard]
    }()

    if let date = formatters.compactMap({ $0.date(from: value) }).first {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    return value
}

struct MacTeamView: View {
    let snapshot: MailboxDashboardSnapshot?
    let members: [TeamMember]
    let createUser: (String, String, String, String) async -> Void
    let updateUser: (TeamMember, String, String, String, String) async -> Void
    let deleteUser: (TeamMember) async -> Void

    var body: some View {
        MacPage(title: "Team", subtitle: "Users with access to this pobox.watch workspace.") {
            MacInfoRow(title: snapshot?.currentUser.displayName ?? "Unknown user", detail: snapshot?.currentUser.email ?? "No email loaded", systemImage: "person.crop.circle", tint: .blue)
            MacInfoRow(title: "Role", detail: snapshot?.currentUser.role ?? "Unknown", systemImage: "person.badge.key", tint: .purple)

            MacPanel(title: "Members", aside: "\(members.filter { $0.deletedAt == nil }.count) users") {
                if !members.contains(where: { $0.deletedAt == nil }) {
                    MacEmptyStateView(title: "No team list loaded", subtitle: "Refresh after signing in to load the workspace members.")
                } else {
                    ForEach(members.filter { $0.deletedAt == nil }) { member in
                        MacTeamMemberRow(
                            member: member,
                            currentUserId: snapshot?.currentUser.id,
                            canManage: snapshot?.currentUser.role == "ADMIN",
                            updateUser: updateUser,
                            deleteUser: deleteUser
                        )
                    }
                }
            }

            MacPanel(title: "Deleted Users", aside: "\(members.filter { $0.deletedAt != nil }.count) users") {
                if !members.contains(where: { $0.deletedAt != nil }) {
                    Text("No deleted users.").foregroundStyle(.secondary)
                }
                ForEach(members.filter { $0.deletedAt != nil }) { member in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(member.displayName).font(.headline)
                        Text(member.email).foregroundStyle(.secondary)
                        Text("Deleted").foregroundStyle(.secondary)
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
                MacInfoRow(title: "Admin required", detail: "Only admins can add post offices and boxes.", systemImage: "lock", tint: .orange)
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
    let canManage: Bool
    let updateUser: (TeamMember, String, String, String, String) async -> Void
    let deleteUser: (TeamMember) async -> Void
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var displayName = ""
    @State private var email = ""
    @State private var role = "MEMBER"
    @State private var status = "ACTIVE"

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
                if canManage {
                    Button {
                        displayName = member.displayName
                        email = member.email
                        role = member.role
                        status = member.status
                        editing.toggle()
                    } label: {
                        Label("Edit", systemImage: "pencil")
                    }
                    Button(member.active ? "Disable" : "Reactivate") {
                        Task {
                            await updateUser(member, member.email, member.displayName, member.role, member.active ? "DISABLED" : "ACTIVE")
                        }
                    }
                    .disabled(member.id == currentUserId)
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .disabled(member.id == currentUserId)
                } else {
                    Text("Admin required")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
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
                    Picker("Status", selection: $status) {
                        Text("Active").tag("ACTIVE")
                        Text("Invited").tag("INVITED")
                        Text("Disabled").tag("DISABLED")
                    }
                    .pickerStyle(.segmented)
                    .disabled(member.id == currentUserId)
                    Button {
                        Task {
                            await updateUser(member, email, displayName, role, status)
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
        .task(id: member.id) {
            displayName = member.displayName
            email = member.email
            role = member.role
            status = member.status
        }
        .padding(14)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .confirmationDialog("Delete \(member.displayName)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete User", role: .destructive) {
                Task { await deleteUser(member) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This disables their pobox.watch access and keeps historical audit records.")
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
                if postOffices.isEmpty {
                    Text("Create or import a post office before adding a PO box.")
                        .foregroundStyle(.secondary)
                } else {
                    Picker("Post office", selection: $postOfficeId) {
                        ForEach(postOffices) { office in
                            Text(office.name).tag(office.id)
                        }
                    }
                    .onAppear {
                        if postOfficeId.isEmpty || !postOffices.contains(where: { $0.id == postOfficeId }) {
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
            Text("This also removes its boxes from active pobox.watch views.")
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

private func hasWaitingItem(_ mailbox: Mailbox) -> Bool {
    mailbox.mailWaiting || mailbox.parcelWaiting
}

private func mailboxStatus(_ mailbox: Mailbox) -> String {
    if mailbox.mailWaiting && mailbox.parcelWaiting {
        return "Mail and parcel waiting"
    }
    if mailbox.parcelWaiting {
        return "Parcel waiting"
    }
    if mailbox.mailWaiting {
        return "Mail waiting"
    }
    return "Clear"
}

private func mailboxStatusLine(_ mailbox: Mailbox) -> String {
    hasWaitingItem(mailbox) ? "\(mailboxStatus(mailbox)) in PO Box \(mailbox.boxNumber)" : "PO Box \(mailbox.boxNumber) is clear"
}

private func appleMapsURL(for office: PostOffice) -> URL {
    postOfficeMapsURL(name: office.name, address: office.address, latitude: office.latitude, longitude: office.longitude)
}
