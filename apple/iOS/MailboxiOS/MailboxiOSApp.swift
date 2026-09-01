import SwiftUI
import MailboxShared
import UIKit

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
        UIApplication.shared.open(url)
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
            try await client.collectMailbox(workspaceId: workspaceId, mailboxId: mailbox.id, source: .iPhone)
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

    func createMailbox(postOfficeId: String, boxNumber: String) async {
        await run {
            _ = try await client.createMailbox(
                workspaceId: workspaceId,
                input: CreateMailboxInput(postOfficeId: postOfficeId, boxNumber: boxNumber)
            )
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
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Sign in with your passkey")
                            .font(.title2.bold())
                        Text("pobox.watch requires a passkey and authenticator 2FA for every account.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }

                Section("Account") {
                    if model.twoFactorChallengeId == nil {
                        TextField("Email", text: $model.email)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)

                        if model.passwordMode {
                            SecureField("Password", text: $model.password)
                                .textContentType(.password)
                        }
                    } else {
                        TextField("Authenticator or recovery code", text: $model.twoFactorCode)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.numberPad)
                    }
                }

                Section {
                    if model.twoFactorChallengeId != nil {
                        Button {
                            Task { await model.verifySecondFactor() }
                        } label: {
                            Label("Verify Code", systemImage: "checkmark.shield")
                        }
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

                        Button("Use Password to Set Up Security") {
                            model.passwordMode = true
                        }
                    }

                    if model.isLoading {
                        ProgressView()
                    }
                }

                Section {
                    Text("Passkey setup and first secure sign-in currently happen at pobox.watch in Safari. After setup, use the iPhone app with the same secured account.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
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
            iPhoneTab(title: "Overview", systemImage: "tray.full") {
                iPhoneOverviewList(model: model)
            }

            iPhoneTab(title: "PO Boxes", systemImage: "mail.stack") {
                iPhoneMailboxList(model: model)
            }

            iPhoneTab(title: "Map", systemImage: "map") {
                iPhoneMapList(snapshot: model.snapshot)
            }

            iPhoneTab(title: "Needs Review", systemImage: "exclamationmark.triangle") {
                iPhoneReviewList(reviewItems: model.reviewItems)
            }

            iPhoneTab(title: "Team", systemImage: "person.2") {
                iPhoneTeamView(snapshot: model.snapshot, members: model.members, createUser: { email, displayName, password, role in
                    await model.createUser(email: email, displayName: displayName, password: password, role: role)
                })
            }

            iPhoneTab(title: "Settings", systemImage: "gearshape") {
                iPhoneSettingsView(snapshot: model.snapshot, logout: {
                    await model.logout()
                }, locationResults: model.postOfficeLocationResults, searchPostOfficeLocations: { query in
                    await model.searchPostOfficeLocations(query: query)
                }, createPostOffice: { name, address, phone, latitude, longitude, radius in
                    await model.createPostOffice(name: name, address: address, phone: phone, latitude: latitude, longitude: longitude, geofenceRadius: radius)
                }, createMailbox: { postOfficeId, boxNumber in
                    await model.createMailbox(postOfficeId: postOfficeId, boxNumber: boxNumber)
                })
            }
        }
        .overlay(alignment: .bottom) {
            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.red, in: Capsule())
                    .padding()
            }
        }
    }
}

struct iPhoneTab<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let content: Content

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title == "Overview" ? "pobox.watch" : title)
        }
        .tabItem { Label(title, systemImage: systemImage) }
    }
}

struct iPhoneOverviewList: View {
    @ObservedObject var model: iPhoneMailboxViewModel

    private var waitingMailboxes: [Mailbox] {
        model.snapshot?.postOffices.flatMap(\.mailboxes).filter(\.mailWaiting) ?? []
    }

    var body: some View {
        List {
            if let snapshot = model.snapshot {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("\(snapshot.outstandingMailboxCount)")
                            .font(.system(size: 46, weight: .bold))
                        Text(snapshot.outstandingMailboxCount == 1 ? "PO box needs checking" : "PO boxes need checking")
                            .foregroundStyle(.secondary)
                        Text("Signed in as \(snapshot.currentUser.displayName)")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }

                Section("Collection Queue") {
                    if waitingMailboxes.isEmpty {
                        Label("All shared PO boxes are clear", systemImage: "checkmark.circle")
                    } else {
                        ForEach(waitingMailboxes) { mailbox in
                            iPhoneMailboxRow(mailbox: mailbox, busy: model.busyMailboxId == mailbox.id) {
                                await model.collect(mailbox)
                            }
                        }
                    }
                }

                Section("Workspace") {
                    iPhoneDetailRow(label: "Post offices", value: "\(snapshot.postOffices.count)")
                    iPhoneDetailRow(label: "PO boxes", value: "\(snapshot.postOffices.flatMap(\.mailboxes).count)")
                    iPhoneDetailRow(label: "Needs review", value: "\(model.reviewItems.count)")
                }
            }
        }
        .refreshable {
            await model.refresh()
        }
        .toolbar {
            Button {
                Task { await model.refresh() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(model.isLoading)
        }
    }
}

struct iPhoneMailboxList: View {
    @ObservedObject var model: iPhoneMailboxViewModel

    var body: some View {
        List {
            ForEach(model.snapshot?.postOffices ?? []) { office in
                Section {
                    Link(destination: appleMapsURL(for: office)) {
                        Label("Open \(office.name) in Apple Maps", systemImage: "map")
                    }
                    ForEach(office.mailboxes) { mailbox in
                        iPhoneMailboxRow(mailbox: mailbox, busy: model.busyMailboxId == mailbox.id) {
                            await model.collect(mailbox)
                        }
                    }
                } header: {
                    Text(office.name)
                } footer: {
                    Text(office.address)
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
            Image(systemName: mailbox.mailWaiting ? "tray.full.fill" : "checkmark.circle.fill")
                .foregroundStyle(mailbox.mailWaiting ? .orange : .green)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(mailbox.name)
                    .font(.headline)
                Text(mailbox.mailWaiting ? "Mail waiting in PO Box \(mailbox.boxNumber)" : "PO Box \(mailbox.boxNumber) is clear")
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

struct iPhoneMapList: View {
    let snapshot: MailboxDashboardSnapshot?

    var body: some View {
        List {
            ForEach(snapshot?.postOffices ?? []) { office in
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(office.name, systemImage: "building.2")
                            .font(.headline)
                        Text(office.address)
                            .foregroundStyle(.secondary)
                        if let phone = office.phone {
                            Text(phone)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text("\(office.geofenceRadius)m geofence")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Link(destination: appleMapsURL(for: office)) {
                            Label("Open in Apple Maps", systemImage: "arrow.up.right.square")
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }
}

struct iPhoneReviewList: View {
    let reviewItems: [ReviewItem]

    var body: some View {
        List {
            Section {
                iPhoneDetailRow(label: "Waiting review", value: "\(reviewItems.count)")
                iPhoneDetailRow(label: "Low confidence", value: "\(reviewItems.filter { ($0.confidence ?? 1) < 0.7 }.count)")
                iPhoneDetailRow(label: "Unmatched box", value: "\(reviewItems.filter { $0.mailboxNumber == nil }.count)")
            }

            Section("Queue") {
                if reviewItems.isEmpty {
                    Label("No review items waiting", systemImage: "checkmark.circle")
                } else {
                    ForEach(reviewItems) { item in
                        VStack(alignment: .leading, spacing: 5) {
                            Label(item.subject ?? "Unmatched mail notice", systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                            Text(reviewDetail(item))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
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

struct iPhoneTeamView: View {
    let snapshot: MailboxDashboardSnapshot?
    let members: [TeamMember]
    let createUser: (String, String, String, String) async -> Void

    var body: some View {
        Form {
            Section("Current Account") {
                Text(snapshot?.currentUser.displayName ?? "Unknown user")
                Text(snapshot?.currentUser.email ?? "")
                    .foregroundStyle(.secondary)
                Text(snapshot?.currentUser.role ?? "")
                    .foregroundStyle(.secondary)
            }

            Section("Members") {
                if members.isEmpty {
                    Label("No team list loaded", systemImage: "person.2")
                } else {
                    ForEach(members) { member in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(member.displayName)
                                .font(.headline)
                            Text("\(member.email) - \(member.role) - \(member.status)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if snapshot?.currentUser.role == "ADMIN" {
                iPhoneCreateUserForm(createUser: createUser)
            } else {
                Section("Add User") {
                    Label("Admin required", systemImage: "lock")
                }
            }
        }
    }
}

struct iPhoneSettingsView: View {
    let snapshot: MailboxDashboardSnapshot?
    let logout: () async -> Void
    let locationResults: [PostOfficeLocationResult]
    let searchPostOfficeLocations: (String) async -> Void
    let createPostOffice: (String, String, String?, Double, Double, Int) async -> Void
    let createMailbox: (String, String) async -> Void

    var body: some View {
        Form {
            Section("Workspace") {
                Text(snapshot?.workspace.name ?? "Not loaded")
                Text(snapshot?.currentUser.email ?? "")
                    .foregroundStyle(.secondary)
                Text(snapshot?.currentUser.role ?? "")
                    .foregroundStyle(.secondary)
            }

            Section("Security") {
                Label("Passkey and authenticator 2FA are mandatory", systemImage: "key.fill")
                Text("Use pobox.watch in Safari to add passkeys or complete first-time security setup.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Link(destination: URL(string: "https://pobox.watch")!) {
                    Label("Open pobox.watch", systemImage: "safari")
                }
            }

            Section("Server") {
                Text("https://pobox.watch")
            }

            if snapshot?.currentUser.role == "ADMIN" {
                iPhoneCreatePostOfficeForm(locationResults: locationResults, searchPostOfficeLocations: searchPostOfficeLocations, createPostOffice: createPostOffice)
                iPhoneCreateMailboxForm(postOffices: snapshot?.postOffices ?? [], createMailbox: createMailbox)
            } else {
                Section("Admin Setup") {
                    Label("Admin required to add post offices and PO boxes", systemImage: "lock")
                }
            }

            Section {
                Button(role: .destructive) {
                    Task { await logout() }
                } label: {
                    Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
    }
}

struct iPhoneCreateUserForm: View {
    let createUser: (String, String, String, String) async -> Void
    @State private var displayName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var role = "MEMBER"

    var body: some View {
        Section("Add User") {
            TextField("Name", text: $displayName)
                .textContentType(.name)
            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
            SecureField("Temporary password", text: $password)
                .textContentType(.newPassword)
            Picker("Role", selection: $role) {
                Text("Member").tag("MEMBER")
                Text("Admin").tag("ADMIN")
            }
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
            .disabled(displayName.isEmpty || email.isEmpty || password.count < 12)
        }
    }
}

struct iPhoneCreatePostOfficeForm: View {
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
        Section("Add Post Office") {
            TextField("Search suburb, postcode, or name", text: $query)
                .textInputAutocapitalization(.words)
                .onChange(of: query) { _, newValue in
                    scheduleSearch(newValue)
                }
            Button {
                Task { await searchPostOfficeLocations(query) }
            } label: {
                Label("Search LCTR Locations", systemImage: "magnifyingglass")
            }
            .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)

            if !locationResults.isEmpty {
                ForEach(locationResults) { location in
                    Button {
                        select(location)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(location.name)
                                .font(.headline)
                            Text(location.address)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text([location.phone, location.hours].compactMap(\.self).joined(separator: " - "))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            TextField("Name", text: $name)
            TextField("Address", text: $address)
            TextField("Phone", text: $phone)
                .keyboardType(.phonePad)
            TextField("Latitude", text: $latitude)
                .keyboardType(.decimalPad)
            TextField("Longitude", text: $longitude)
                .keyboardType(.decimalPad)
            TextField("Geofence radius", text: $geofenceRadius)
                .keyboardType(.numberPad)
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
            .disabled(name.isEmpty || address.isEmpty || Double(latitude) == nil || Double(longitude) == nil || Int(geofenceRadius) == nil)
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

struct iPhoneCreateMailboxForm: View {
    let postOffices: [PostOffice]
    let createMailbox: (String, String) async -> Void
    @State private var postOfficeId = ""
    @State private var boxNumber = ""

    var body: some View {
        Section("Add PO Box") {
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
            Button {
                Task {
                    await createMailbox(postOfficeId, boxNumber)
                    boxNumber = ""
                }
            } label: {
                Label("Create PO Box", systemImage: "plus")
            }
            .disabled(postOfficeId.isEmpty || boxNumber.isEmpty)
        }
    }
}

struct iPhoneDetailRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
        }
    }
}

private func appleMapsURL(for office: PostOffice) -> URL {
    var components = URLComponents(string: "https://maps.apple.com/")!
    components.queryItems = [
        URLQueryItem(name: "ll", value: "\(office.latitude),\(office.longitude)"),
        URLQueryItem(name: "q", value: office.name)
    ]
    return components.url!
}
