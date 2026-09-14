import SwiftUI
import PoboxWatchShared
import AppKit
import UniformTypeIdentifiers

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
    private var settingsWindow: NSWindow?
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
        window.contentView = NSHostingView(rootView: MacRootView(model: model).tint(PoboxTheme.blue))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        DispatchQueue.main.async { [weak self] in
            self?.installSettingsMenuAction()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func installSettingsMenuAction() {
        guard let settingsItem = NSApp.mainMenu?.items.first?.submenu?.items.first(where: { $0.keyEquivalent == "," }) else { return }
        settingsItem.target = self
        settingsItem.action = #selector(showSettingsWindow)
    }

    @objc private func showSettingsWindow() {
        if settingsWindow == nil {
            let preferences = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 460, height: 220),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            preferences.title = "pobox.watch Settings"
            preferences.isReleasedWhenClosed = false
            preferences.contentView = NSHostingView(rootView: MacPreferencesView().tint(PoboxTheme.blue))
            preferences.center()
            settingsWindow = preferences
        }
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
    @Published var snapshot: MailboxDashboardSnapshot? {
        didSet {
            let count = snapshot?.outstandingMailboxCount ?? 0
            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        }
    }
    @Published var releaseNotice: ReleaseNotice?
    @Published var reviewItems: [ReviewItem] = []
    @Published var members: [TeamMember] = []
    @Published var postOfficeLocationResults: [PostOfficeLocationResult] = []
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var busyMailboxId: String?
    @Published var passwordMode = false
    @Published var collectionConfirmation: String?

    private let client = PoboxWatchAPIClient.live
    private let workspaceId = "ws_company"
    private var loadGeneration = 0
    private var collectionConfirmationGeneration = 0
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
            showCollectionConfirmation()
            try await loadWorkspace()
        }
    }

    func claim(_ office: PostOffice) async {
        busyMailboxId = "claim:\(office.id)"
        defer { busyMailboxId = nil }
        await run {
            try await client.claimPostOffice(workspaceId: workspaceId, postOfficeId: office.id)
            try await loadWorkspace()
        }
    }

    func releaseClaim(_ office: PostOffice) async {
        busyMailboxId = "claim:\(office.id)"
        defer { busyMailboxId = nil }
        await run {
            try await client.releasePostOfficeClaim(workspaceId: workspaceId, postOfficeId: office.id)
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
            collectionConfirmationGeneration += 1
            collectionConfirmation = nil
        }
    }

    private func showCollectionConfirmation() {
        collectionConfirmationGeneration += 1
        let generation = collectionConfirmationGeneration
        withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) {
            collectionConfirmation = "Thank you. Try not to lose the mail before you get home."
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4.2))
            guard generation == collectionConfirmationGeneration else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                collectionConfirmation = nil
            }
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

    func updateUser(_ member: TeamMember, email: String, displayName: String, avatar: String, role: String, status: String) async {
        await run {
            _ = try await client.updateUser(
                workspaceId: workspaceId,
                userId: member.id,
                input: UpdateUserInput(email: email, displayName: displayName, avatar: avatar, role: role, status: status, expectedVersion: member.version)
            )
            try await loadWorkspace()
        }
    }

    func updateProfileAvatar(_ avatar: String) async {
        await run {
            try await client.updateProfileAvatar(workspaceId: workspaceId, avatar: avatar)
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

private enum MacAppearancePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "Auto"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct MacAppearancePicker: View {
    @AppStorage("macAppearancePreference") private var appearancePreference = MacAppearancePreference.system.rawValue

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Appearance", selection: $appearancePreference) {
                ForEach(MacAppearancePreference.allCases) { preference in
                    Text(preference.title).tag(preference.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text(appearancePreference == MacAppearancePreference.system.rawValue
                 ? "Auto follows your Mac's current appearance."
                 : "This appearance stays selected until you change it.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: 480, alignment: .leading)
    }
}

private struct MacPreferencesView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "circle.lefthalf.filled")
                    .font(.title2)
                    .foregroundStyle(PoboxTheme.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Appearance")
                        .font(.headline)
                    Text("Choose how pobox.watch looks on this Mac.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            MacAppearancePicker()
        }
        .padding(24)
        .frame(width: 420)
    }
}

struct MacRootView: View {
    @StateObject private var model: MacMailboxViewModel
    @AppStorage("macAppearancePreference") private var appearancePreference = MacAppearancePreference.system.rawValue

    init(model: MacMailboxViewModel = MacMailboxViewModel()) {
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        Group {
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
        .preferredColorScheme(selectedAppearance.colorScheme)
        .overlay(alignment: .top) {
            if let message = model.collectionConfirmation {
                MacCollectionConfirmationBanner(message: message)
                    .padding(.top, 18)
                    .transition(.move(edge: .top).combined(with: .opacity).combined(with: .scale(scale: 0.96)))
                    .zIndex(20)
            }
        }
    }

    private var selectedAppearance: MacAppearancePreference {
        MacAppearancePreference(rawValue: appearancePreference) ?? .system
    }
}

struct MacLoginView: View {
    @ObservedObject var model: MacMailboxViewModel

    var body: some View {
        ZStack {
            PoboxTheme.pageBackground
                .ignoresSafeArea()
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 18) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 76, height: 76)
                        .accessibilityHidden(true)
                    Text("pobox.watch")
                        .font(.system(size: 36, weight: .bold))
                    Text("Know what is waiting before you visit the post office.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 340, alignment: .leading)
                    Spacer()
                    Label("Secure shared mailbox access", systemImage: "checkmark.shield.fill")
                        .foregroundStyle(PoboxTheme.green)
                }
                .padding(44)
                .frame(minWidth: 350, maxWidth: 430, maxHeight: .infinity, alignment: .topLeading)
                .background(PoboxTheme.sky.opacity(0.55))

                VStack(alignment: .leading, spacing: 20) {
                Text(model.twoFactorChallengeId == nil ? "Sign in with your passkey" : "Enter your authenticator code")
                    .font(.title.bold())
                Text("pobox.watch requires a passkey and authenticator 2FA for every account.")
                    .foregroundStyle(.secondary)

                if model.twoFactorChallengeId == nil {
                    TextField("Email", text: $model.email)
                        .textFieldStyle(.roundedBorder)

                    if model.passwordMode {
                        SecureField("Password", text: $model.password)
                            .textFieldStyle(.roundedBorder)
                    }
                } else {
                    TextField("Authenticator or recovery code", text: $model.twoFactorCode)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 10) {
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

                    HStack(spacing: 16) {
                        Link("Forgot Password?", destination: URL(string: "https://pobox.watch/?forgot-password=1")!)
                        Button("Use Password to Set Up Security") {
                            model.passwordMode = true
                        }
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

                if let errorMessage = model.errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                }

                Spacer()
            }
            .padding(44)
            .frame(minWidth: 430, maxWidth: 560, maxHeight: .infinity, alignment: .leading)
            }
        }
        .tint(PoboxTheme.blue)
    }
}

struct MacOverviewView: View {
    @ObservedObject var model: MacMailboxViewModel
    @State private var selection = "Overview"
    private let items = ["Overview", "Post Offices", "Map", "History", "Activity", "Needs Review", "Team", "Settings"]

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                MacSidebarBrand(
                    userName: model.snapshot?.currentUser.displayName ?? "",
                    role: model.snapshot?.currentUser.role ?? "",
                    waitingCount: model.snapshot?.outstandingMailboxCount ?? 0
                )
                .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 16, trailing: 12))
                .listRowSeparator(.hidden)

                Section("Workspace") {
                    ForEach(items, id: \.self) { item in
                        Label(item, systemImage: icon(for: item))
                            .tag(item)
                            .fontWeight(selection == item ? .semibold : .regular)
                    }
                }

                Section {
                    Label("Live updates", systemImage: "dot.radiowaves.left.and.right")
                        .foregroundStyle(PoboxTheme.green)
                    Text("Refreshes every 30 seconds")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 220, ideal: 245, max: 280)
        } detail: {
            detailView(for: selection)
                .toolbar {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(model.isLoading)
                    .help("Refresh now")

                    Button {
                        Task { await model.logout() }
                    } label: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                    }
                    .disabled(model.isLoading)
                    .help("Log out")
                }
        }
        .tint(PoboxTheme.blue)
    }

    @ViewBuilder
    private func detailView(for item: String) -> some View {
        switch item {
        case "Overview":
            MacOverviewDashboardView(snapshot: model.snapshot, reviewItems: model.reviewItems, busyId: model.busyMailboxId, collect: { mailbox in
                await model.collect(mailbox)
            }, claim: { office in
                await model.claim(office)
            }, releaseClaim: { office in
                await model.releaseClaim(office)
            })
        case "Post Offices":
            MacMailboxListView(snapshot: model.snapshot, busyMailboxId: model.busyMailboxId, collect: { mailbox in
                await model.collect(mailbox)
            }, claim: { office in
                await model.claim(office)
            }, releaseClaim: { office in
                await model.releaseClaim(office)
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
            } updateUser: { member, email, displayName, avatar, role, status in
                await model.updateUser(member, email: email, displayName: displayName, avatar: avatar, role: role, status: status)
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
            }, updateProfileAvatar: { avatar in
                await model.updateProfileAvatar(avatar)
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

private struct MacSidebarBrand: View {
    let userName: String
    let role: String
    let waitingCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 92, height: 92)
                    .overlay(alignment: .topTrailing) {
                        if waitingCount > 0 {
                            Text("\(waitingCount)")
                                .font(.title3.bold())
                                .foregroundStyle(.white)
                                .frame(minWidth: 36, minHeight: 36)
                                .background(.red, in: Capsule())
                                .offset(x: 10, y: -8)
                        }
                    }
                    .accessibilityLabel("pobox.watch")
                    .accessibilityValue(waitingCount > 0 ? "\(waitingCount) mailboxes need collection" : "No mailboxes need collection")
                VStack(alignment: .leading, spacing: 2) {
                    Text("pobox.watch")
                        .font(.headline)
                    if waitingCount > 0 {
                        Text("\(waitingCount) to collect")
                            .font(.caption)
                            .foregroundStyle(PoboxTheme.orange)
                    } else {
                        Text("All boxes clear")
                            .font(.caption)
                            .foregroundStyle(PoboxTheme.green)
                    }
                }
            }
            if !userName.isEmpty {
                Text(userName)
                    .font(.callout.weight(.semibold))
                Text(role.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct MacOverviewDashboardView: View {
    let snapshot: MailboxDashboardSnapshot?
    let reviewItems: [ReviewItem]
    let busyId: String?
    let collect: (Mailbox) async -> Void
    let claim: (PostOffice) async -> Void
    let releaseClaim: (PostOffice) async -> Void

    private var waitingMailboxes: [Mailbox] {
        snapshot?.postOffices.flatMap(\.mailboxes).filter(hasWaitingItem) ?? []
    }

    var body: some View {
        MacPage(title: collectionHeading, subtitle: signedInText) {
            MacPanel(title: "Collection Queue", aside: "\(waitingMailboxes.count) waiting") {
                if waitingMailboxes.isEmpty {
                    MacEmptyStateView(title: "Nothing waiting", subtitle: "All shared boxes are currently clear.")
                } else {
                    ForEach(snapshot?.postOffices ?? []) { office in
                        ForEach(office.mailboxes.filter(hasWaitingItem)) { mailbox in
                            MacCollectionQueueRow(
                                office: office,
                                mailbox: mailbox,
                                currentUser: snapshot?.currentUser,
                                busyId: busyId,
                                collect: collect,
                                claim: claim,
                                releaseClaim: releaseClaim
                            )
                        }
                    }
                }
            }
        }
    }

    private var collectionHeading: String {
        switch waitingMailboxes.count {
        case 0: "All up to date, no mail to collect"
        case 1: "1 Mailbox to collect"
        default: "\(waitingMailboxes.count) Mailboxes to collect"
        }
    }

    private var signedInText: String {
        guard let snapshot else { return "Loading live pobox.watch data." }
        return "Signed in as \(snapshot.currentUser.displayName)."
    }
}

private struct MacCollectionQueueRow: View {
    let office: PostOffice
    let mailbox: Mailbox
    let currentUser: CurrentUser?
    let busyId: String?
    let collect: (Mailbox) async -> Void
    let claim: (PostOffice) async -> Void
    let releaseClaim: (PostOffice) async -> Void

    private var ownsClaim: Bool { office.collectionClaim?.userId == currentUser?.id }
    private var blockedBy: String? { ownsClaim ? nil : office.collectionClaim?.displayName }
    private var detectedText: String { "Mail detected \(displayDate(latestWaitingDetection(mailbox)))" }
    private var claimActionLabel: String { blockedBy.map { "\($0) is collecting from this post office" } ?? (ownsClaim ? "Cancel I'm collecting" : "I'm collecting") }

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(office.name)
                    .font(.headline)
                Text("PO Box \(mailbox.boxNumber)")
                    .foregroundStyle(.secondary)
                Text(office.address)
                    .foregroundStyle(.secondary)
                Text(detectedText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            HStack(spacing: 10) {
                Button {
                    openAppleMapsDirections(office)
                } label: {
                    MacActionIcon(systemName: "location.north.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .tint(.gray)
                .help("Directions")
                .accessibilityLabel("Directions to \(office.name)")

                Button {
                    Task {
                        if ownsClaim {
                            await releaseClaim(office)
                        } else {
                            await claim(office)
                        }
                    }
                } label: {
                    MacActionIcon(systemName: ownsClaim ? "calendar.badge.minus" : "calendar.badge.checkmark")
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .tint(ownsClaim ? PoboxTheme.green : .gray)
                .disabled(busyId == "claim:\(office.id)" || blockedBy != nil)
                .help(claimActionLabel)
                .accessibilityLabel(claimActionLabel)
                .accessibilityValue(ownsClaim ? "On" : "Off")

                Button {
                    Task { await collect(mailbox) }
                } label: {
                    MacActionIcon(systemName: "checkmark.circle.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .tint(.gray)
                .disabled(busyId == mailbox.id || blockedBy != nil)
                .help(blockedBy.map { "\($0) is collecting from this post office" } ?? "Collected")
                .accessibilityLabel("Mark PO Box \(mailbox.boxNumber) collected")
            }
        }
        .padding(14)
        .background(PoboxTheme.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(PoboxTheme.border))
    }
}

struct MacMailboxListView: View {
    let snapshot: MailboxDashboardSnapshot?
    let busyMailboxId: String?
    let collect: (Mailbox) async -> Void
    let claim: (PostOffice) async -> Void
    let releaseClaim: (PostOffice) async -> Void
    let updateMailbox: (Mailbox, String, String) async -> Void
    let deleteMailbox: (Mailbox) async -> Void

    var body: some View {
        MacPage(title: "Post Offices", subtitle: "Post offices with their assigned boxes.") {
            ForEach(snapshot?.postOffices ?? []) { office in
                MacPanel(title: office.name, aside: office.address) {
                    if office.mailboxes.contains(where: hasWaitingItem) {
                        MacCollectionClaimControl(office: office, currentUser: snapshot?.currentUser, busy: busyMailboxId == "claim:\(office.id)", claim: claim, releaseClaim: releaseClaim)
                    }
                    if office.mailboxes.isEmpty {
                        MacEmptyStateView(title: "No PO box assigned", subtitle: "This post office can be deleted or given a PO box.")
                    } else {
                        ForEach(office.mailboxes) { mailbox in
                            MacMailboxManageRow(
                                mailbox: mailbox,
                                postOffices: snapshot?.postOffices ?? [],
                                busy: busyMailboxId == mailbox.id,
                                collectionBlocked: office.collectionClaim?.userId != nil && office.collectionClaim?.userId != snapshot?.currentUser.id,
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
    let collectionBlocked: Bool
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
                    .foregroundStyle(hasWaitingItem(mailbox) ? PoboxTheme.orange : PoboxTheme.green)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(mailbox.name)
                        .font(.headline)
                    Text(mailboxStatusLine(mailbox))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                MacStatusBadge(mailbox: mailbox)
                if hasWaitingItem(mailbox) {
                    Button {
                        Task { await collect(mailbox) }
                    } label: {
                        Label("Collected", systemImage: "checkmark.circle")
                    }
                    .disabled(busy || collectionBlocked)
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
        .padding(14)
        .background(PoboxTheme.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(PoboxTheme.border))
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

private struct MacCollectionClaimControl: View {
    let office: PostOffice
    let currentUser: CurrentUser?
    let busy: Bool
    let claim: (PostOffice) async -> Void
    let releaseClaim: (PostOffice) async -> Void

    private var ownsClaim: Bool { office.collectionClaim?.userId == currentUser?.id }

    var body: some View {
        HStack(spacing: 10) {
            if let activeClaim = office.collectionClaim {
                if ownsClaim {
                    Button { Task { await releaseClaim(office) } } label: {
                        Label("I'm collecting today", systemImage: "checkmark.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(PoboxTheme.green)
                    .disabled(busy)
                    .help("Select again to cancel your collection plan")
                    .accessibilityValue("On")
                    Text("until 3:00 am tomorrow")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Label("\(activeClaim.displayName) is collecting until 3:00 am tomorrow", systemImage: "person.badge.clock")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    if currentUser?.role == "ADMIN" {
                        Button("Cancel plan") { Task { await releaseClaim(office) } }
                        .disabled(busy)
                    }
                }
            } else {
                Button { Task { await claim(office) } } label: {
                    Label("I'll collect today", systemImage: "person.badge.clock")
                }
                .buttonStyle(.borderedProminent)
                .tint(.gray)
                .disabled(busy)
                .help("Tell the team you will collect from this post office today")
                .accessibilityValue("Off")
            }
        }
        .padding(.vertical, 4)
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
    let updateUser: (TeamMember, String, String, String, String, String) async -> Void
    let deleteUser: (TeamMember) async -> Void

    var body: some View {
        MacPage(title: "Team", subtitle: "Users with access to this pobox.watch workspace.") {
            MacPanel(title: "Team Directory", aside: "\(members.filter { $0.deletedAt == nil }.count) users") {
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
                    HStack(spacing: 12) {
                        MacUserAvatar(avatar: member.avatar, name: member.displayName)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(member.displayName).font(.headline)
                            Text(member.email).foregroundStyle(.secondary)
                            Text("Deleted \(displayDate(member.deletedAt))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("Deleted")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if snapshot?.currentUser.role == "ADMIN" {
                MacCreateUserForm(createUser: createUser)
            } else {
                MacInfoRow(title: "Admin required", detail: "Only admins can create new users.", systemImage: "lock", tint: PoboxTheme.orange)
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
    let updateProfileAvatar: (String) async -> Void

    var body: some View {
        MacPage(title: "Settings", subtitle: "Configuration for this native pobox.watch client.") {
            MacProfileAvatarPanel(
                name: snapshot?.currentUser.displayName ?? "User",
                initialAvatar: snapshot?.currentUser.avatar ?? "",
                save: updateProfileAvatar
            )
            MacPanel(title: "Appearance", aside: "Mac") {
                MacAppearancePicker()
            }
            MacInfoRow(title: "Server", detail: "https://pobox.watch", systemImage: "network", tint: .blue)
            MacInfoRow(title: "Workspace", detail: snapshot?.workspace.name ?? "Unknown", systemImage: "building.2", tint: PoboxTheme.green)
            MacInfoRow(title: "Security", detail: "Passkey and authenticator setup is mandatory. Use the web app to add passkeys and manage setup.", systemImage: "key.fill", tint: PoboxTheme.orange)
            MacPanel(title: "Password", aside: "") { PasswordSettingsView(onChanged: logout) }

            if snapshot?.currentUser.role == "ADMIN" {
                MacCreatePostOfficeForm(locationResults: locationResults, searchPostOfficeLocations: searchPostOfficeLocations, createPostOffice: createPostOffice)
                MacCreateMailboxForm(postOffices: snapshot?.postOffices ?? [], createMailbox: createMailbox)
            } else {
                MacInfoRow(title: "Admin required", detail: "Only admins can add post offices and boxes.", systemImage: "lock", tint: PoboxTheme.orange)
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

private struct MacProfileAvatarPanel: View {
    let name: String
    let initialAvatar: String
    let save: (String) async -> Void
    @State private var avatar: String
    @State private var saving = false

    init(name: String, initialAvatar: String, save: @escaping (String) async -> Void) {
        self.name = name
        self.initialAvatar = initialAvatar
        self.save = save
        _avatar = State(initialValue: initialAvatar)
    }

    var body: some View {
        MacPanel(title: "Profile Image", aside: "Emoji or photo") {
            HStack(alignment: .top, spacing: 16) {
                MacUserAvatar(avatar: avatar, name: name, size: 64)
                VStack(alignment: .leading, spacing: 10) {
                    MacAvatarEditor(value: $avatar)
                    HStack {
                        Button {
                            saving = true
                            Task {
                                await save(avatar)
                                saving = false
                            }
                        } label: {
                            Label(saving ? "Saving" : "Save Profile Image", systemImage: "square.and.arrow.down")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(saving || avatar == initialAvatar)

                        if !avatar.isEmpty {
                            Button("Remove") { avatar = "" }
                        }
                    }
                }
            }
        }
        .task(id: initialAvatar) { avatar = initialAvatar }
    }
}

private struct MacAvatarEditor: View {
    @Binding var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Emoji", text: $value)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 260)
            HStack {
                Button {
                    if let selected = chooseAvatarImage() { value = selected }
                } label: {
                    Label("Choose Photo", systemImage: "photo")
                }
                Text("Use one emoji or choose a square photo.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct MacUserAvatar: View {
    let avatar: String?
    let name: String
    var size: CGFloat = 46

    var body: some View {
        Group {
            if let image = avatarImage(avatar) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Text(displayValue)
                    .font(size > 50 ? .title : .headline)
            }
        }
        .frame(width: size, height: size)
        .background(PoboxTheme.sky)
        .clipShape(Circle())
        .overlay(Circle().stroke(PoboxTheme.border))
        .accessibilityLabel("\(name) profile image")
    }

    private var displayValue: String {
        guard let avatar, !avatar.isEmpty else {
            return name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        }
        return avatar
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
    let updateUser: (TeamMember, String, String, String, String, String) async -> Void
    let deleteUser: (TeamMember) async -> Void
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var displayName = ""
    @State private var email = ""
    @State private var avatar = ""
    @State private var role = "MEMBER"
    @State private var status = "ACTIVE"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 18) {
                MacUserAvatar(avatar: member.avatar, name: member.displayName, size: 92)
                VStack(alignment: .leading, spacing: 4) {
                    Text(member.displayName)
                        .font(.headline)
                    Text(member.email)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 10) {
                    Text("\(member.active ? "Active" : member.status.capitalized) - \(member.role.capitalized)")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(member.active ? PoboxTheme.green : .secondary)

                    if canManage {
                        HStack(spacing: 8) {
                            Button {
                                openPasswordReset(for: member.email)
                            } label: {
                                MacActionIcon(systemName: "key.fill")
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .disabled(!member.active)
                            .help(member.active ? "Reset password" : "Reactivate this user before resetting their password")

                            Button {
                                displayName = member.displayName
                                email = member.email
                                avatar = member.avatar ?? ""
                                role = member.role
                                status = member.status
                                editing.toggle()
                            } label: {
                                MacActionIcon(systemName: "square.and.pencil")
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .help("Edit user")

                            Button {
                                Task {
                                    await updateUser(member, member.email, member.displayName, member.avatar ?? "", member.role, member.active ? "DISABLED" : "ACTIVE")
                                }
                            } label: {
                                MacActionIcon(systemName: member.active ? "person.crop.circle.badge.minus" : "person.crop.circle.badge.plus")
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .disabled(member.id == currentUserId)
                            .help(member.active ? "Disable user" : "Reactivate user")

                            Button(role: .destructive) {
                                confirmDelete = true
                            } label: {
                                MacActionIcon(systemName: "trash.fill")
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .tint(.red)
                            .disabled(member.id == currentUserId)
                            .help("Delete user")
                        }
                    } else {
                        Text("An administrator manages team access.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(minHeight: 100)

            if editing {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Name", text: $displayName)
                        .textFieldStyle(.roundedBorder)
                    TextField("Email", text: $email)
                        .textFieldStyle(.roundedBorder)
                    MacAvatarEditor(value: $avatar)
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
                            await updateUser(member, email, displayName, avatar, role, status)
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
            avatar = member.avatar ?? ""
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

struct MacInfoRow: View {
    let title: String
    let detail: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: systemImage)
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(tint, in: RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(14)
        .background(PoboxTheme.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(PoboxTheme.border))
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
        .padding(.bottom, 4)
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
        .background(PoboxTheme.pageBackground)
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
        .background(PoboxTheme.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(PoboxTheme.border))
    }
}

private struct MacStatusBadge: View {
    let mailbox: Mailbox

    var body: some View {
        Text(mailboxStatus(mailbox))
            .font(.caption.weight(.semibold))
            .foregroundStyle(hasWaitingItem(mailbox) ? PoboxTheme.orange : PoboxTheme.green)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background((hasWaitingItem(mailbox) ? PoboxTheme.orange : PoboxTheme.green).opacity(0.12), in: Capsule())
    }
}

private struct MacActionIcon: View {
    let systemName: String

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 44, weight: .semibold))
            .frame(width: 60, height: 60)
    }
}

private struct MacCollectionConfirmationBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(PoboxTheme.green)
                .symbolEffect(.bounce, value: message)
            VStack(alignment: .leading, spacing: 3) {
                Text("Mail collected")
                    .font(.headline)
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(PoboxTheme.green.opacity(0.55)))
        .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

private func openAppleMaps(_ office: PostOffice) {
    NSWorkspace.shared.open(appleMapsURL(for: office))
}

private func openAppleMapsDirections(_ office: PostOffice) {
    NSWorkspace.shared.open(postOfficeDirectionsURL(name: office.name, address: office.address, latitude: office.latitude, longitude: office.longitude))
}

private func openPasswordReset(for email: String) {
    var components = URLComponents(string: "https://pobox.watch/")
    components?.queryItems = [
        URLQueryItem(name: "forgot-password", value: "1"),
        URLQueryItem(name: "email", value: email)
    ]
    if let url = components?.url { NSWorkspace.shared.open(url) }
}

private func avatarImage(_ avatar: String?) -> NSImage? {
    guard let avatar,
          avatar.hasPrefix("data:image/"),
          let comma = avatar.firstIndex(of: ","),
          let data = Data(base64Encoded: String(avatar[avatar.index(after: comma)...]))
    else { return nil }
    return NSImage(data: data)
}

@MainActor
private func chooseAvatarImage() -> String? {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.image]
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    guard panel.runModal() == .OK,
          let url = panel.url,
          let source = NSImage(contentsOf: url)
    else { return nil }

    let size = NSSize(width: 256, height: 256)
    let target = NSImage(size: size)
    target.lockFocus()
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: size).fill()
    let sourceSize = source.size
    let scale = max(size.width / sourceSize.width, size.height / sourceSize.height)
    let drawSize = NSSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
    let drawOrigin = NSPoint(x: (size.width - drawSize.width) / 2, y: (size.height - drawSize.height) / 2)
    source.draw(in: NSRect(origin: drawOrigin, size: drawSize), from: .zero, operation: .copy, fraction: 1)
    target.unlockFocus()

    guard let tiff = target.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.78])
    else { return nil }
    return "data:image/jpeg;base64,\(data.base64EncodedString())"
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

private func latestWaitingDetection(_ mailbox: Mailbox) -> String? {
    [
        mailbox.mailWaiting ? mailbox.latestNotificationAt : nil,
        mailbox.parcelWaiting ? mailbox.latestParcelNotificationAt : nil
    ]
    .compactMap { $0 }
    .max { displayDateValue($0) < displayDateValue($1) }
}

private func displayDateValue(_ value: String) -> Date {
    let withFractionalSeconds = ISO8601DateFormatter()
    withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let standard = ISO8601DateFormatter()
    standard.formatOptions = [.withInternetDateTime]
    return withFractionalSeconds.date(from: value) ?? standard.date(from: value) ?? .distantPast
}

private func appleMapsURL(for office: PostOffice) -> URL {
    postOfficeMapsURL(name: office.name, address: office.address, latitude: office.latitude, longitude: office.longitude)
}
