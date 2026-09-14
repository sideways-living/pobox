import SwiftUI
import PoboxWatchShared
import UIKit

@main
struct PoboxWatchiOSApp: App {
    var body: some Scene {
        WindowGroup {
            iPhoneRootView()
                .tint(PoboxTheme.blue)
        }
    }
}

@MainActor
final class iPhoneMailboxViewModel: ObservableObject {
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
        UIApplication.shared.open(url)
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
            try await client.collectMailbox(workspaceId: workspaceId, mailboxId: mailbox.id, source: .iPhone, expectedUpdatedAt: mailbox.updatedAt)
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

struct iPhoneRootView: View {
    @StateObject private var model = iPhoneMailboxViewModel()

    var body: some View {
        Group {
            if model.snapshot == nil {
                iPhoneLoginView(model: model)
            } else {
               iPhoneDashboardView(model: model)
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
            }
        }
        .onOpenURL { url in
            Task { await model.consumeNativeHandoff(from: url) }
        }
        .task(id: model.snapshot?.currentUser.id) {
            guard model.snapshot != nil else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
                if !model.isLoading { await model.refresh() }
            }
        }
    }
}

struct iPhoneLoginView: View {
    @ObservedObject var model: iPhoneMailboxViewModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Image("HeaderIcon")
                            .resizable()
                            .frame(width: 80, height: 80)
                            .accessibilityHidden(true)
                        Text("pobox.watch")
                            .font(.largeTitle.bold())
                        Text(model.twoFactorChallengeId == nil ? "Sign in with your passkey" : "Enter your authenticator code")
                            .font(.title2.bold())
                        Text("Secure access to your shared post offices and collection queue.")
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 14) {
                    if model.twoFactorChallengeId == nil {
                        TextField("Email", text: $model.email)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)
                            .poboxLoginField()

                        if model.passwordMode {
                            SecureField("Password", text: $model.password)
                                .textContentType(.password)
                                .poboxLoginField()
                        }
                    } else {
                        TextField("Authenticator or recovery code", text: $model.twoFactorCode)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.numberPad)
                            .poboxLoginField()
                    }

                    if model.twoFactorChallengeId != nil {
                        Button {
                            Task { await model.verifySecondFactor() }
                        } label: {
                            Label("Verify Code", systemImage: "checkmark.shield")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
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
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
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
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(model.isLoading || model.email.isEmpty)

                        Button("Use Password to Set Up Security") {
                            model.passwordMode = true
                        }
                        Link("Forgot Password?", destination: URL(string: "https://pobox.watch/?forgot-password=1")!)
                    }

                    if model.isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    }
                    }

                    Text("Passkey sign-in opens pobox.watch in Safari and returns here automatically after your account is secure.")
                        .font(.callout)
                        .foregroundStyle(.secondary)

                    if let errorMessage = model.errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(.red)
                    }
                }
                .padding(24)
                .frame(maxWidth: 560, alignment: .leading)
            }
            .background(PoboxTheme.pageBackground)
            .tint(PoboxTheme.blue)
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}

struct iPhoneDashboardView: View {
    @ObservedObject var model: iPhoneMailboxViewModel
    @State private var selection = "Overview"

    private let destinations: [(String, String)] = [
        ("Overview", "tray.full"), ("Post Offices", "mail.stack"),
        ("Map", "map"), ("History", "clock"),
        ("Activity", "list.bullet.rectangle"), ("Needs Review", "exclamationmark.triangle"),
        ("Team", "person.2"), ("Settings", "gearshape")
    ]

    var body: some View {
        NavigationStack {
          Group {
            switch selection {
            case "Overview":
                iPhoneOverviewList(model: model)

            case "Post Offices":
                iPhoneMailboxList(model: model)

            case "Map":
                iPhoneMapList(snapshot: model.snapshot, updatePostOffice: { office, name, address, phone, latitude, longitude, radius in
                    await model.updatePostOffice(office, name: name, address: address, phone: phone, latitude: latitude, longitude: longitude, geofenceRadius: radius)
                }, deletePostOffice: { office in
                    await model.deletePostOffice(office)
                })

            case "History":
                iPhoneHistoryList(snapshot: model.snapshot, mode: .history)

            case "Activity":
                iPhoneHistoryList(snapshot: model.snapshot, mode: .activity)

            case "Needs Review":
                iPhoneReviewList(
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
                iPhoneTeamView(snapshot: model.snapshot, members: model.members, createUser: { email, displayName, password, role in
                    await model.createUser(email: email, displayName: displayName, password: password, role: role)
                }, updateUser: { member, email, displayName, role, status in
                    await model.updateUser(member, email: email, displayName: displayName, role: role, status: status)
                }, deleteUser: { member in
                    await model.deleteUser(member)
                })

            default:
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
          .navigationTitle(selection)
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
              ToolbarItem(placement: .principal) {
                  HStack(spacing: 10) {
                      Image("HeaderIcon")
                          .resizable()
                          .frame(width: 32, height: 32)
                          .overlay(alignment: .topTrailing) {
                              if let count = model.snapshot?.outstandingMailboxCount, count > 0 {
                                  Text("\(count)")
                                      .font(.system(size: 11, weight: .bold))
                                      .foregroundStyle(.white)
                                      .padding(.horizontal, 5)
                                      .frame(minWidth: 20, minHeight: 20)
                                      .background(.red, in: Capsule())
                                      .offset(x: 7, y: -5)
                                      .accessibilityLabel("\(count) boxes needing collection")
                              }
                          }
                      Text("pobox.watch").font(.headline)
                  }
              }
              ToolbarItem(placement: .topBarTrailing) {
                  Menu {
                      Section("Navigate") {
                          ForEach(destinations, id: \.0) { title, symbol in
                              Button { selection = title } label: {
                                  Label(title, systemImage: selection == title ? "checkmark" : symbol)
                              }
                          }
                      }
                      Section("Signed in") {
                          Text(model.snapshot?.currentUser.displayName ?? "")
                          Text(model.snapshot?.currentUser.email ?? "")
                          Label("Refreshes every 30 seconds", systemImage: "arrow.clockwise")
                          Button {
                              Task { await model.refresh() }
                          } label: {
                              Label("Refresh Now", systemImage: "arrow.clockwise")
                          }
                          .disabled(model.isLoading)
                          Button(role: .destructive) {
                              Task { await model.logout() }
                          } label: {
                              Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                          }
                          .disabled(model.isLoading)
                      }
                  } label: {
                      Image(systemName: "line.3.horizontal")
                          .frame(width: 44, height: 44)
                  }
                  .accessibilityLabel("Open menu")
                  .accessibilityHint("Navigation, account and logout")
              }
          }
          .safeAreaInset(edge: .top, alignment: .leading, spacing: 0) {
              Text(selection)
                  .font(.title2.bold())
                  .padding(.horizontal, 20)
                  .padding(.vertical, 8)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .background(PoboxTheme.pageBackground)
          }
          .toolbarBackground(PoboxTheme.ink, for: .navigationBar)
          .toolbarBackground(.visible, for: .navigationBar)
          .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .tint(PoboxTheme.blue)
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

struct iPhoneOverviewList: View {
    @ObservedObject var model: iPhoneMailboxViewModel

    private var waitingOffices: [PostOffice] {
        model.snapshot?.postOffices.filter { $0.mailboxes.contains(where: hasWaitingItem) } ?? []
    }

    var body: some View {
        List {
            if model.snapshot != nil {
                Section("Collection Queue") {
                    if waitingOffices.isEmpty {
                        Label("All shared boxes are clear", systemImage: "checkmark.circle")
                    }
                    ForEach(waitingOffices) { office in
                        ForEach(office.mailboxes.filter(hasWaitingItem)) { mailbox in
                            iPhoneCollectionQueueRow(model: model, office: office, mailbox: mailbox)
                        }
                    }
                }
            }
        }
        .iPhoneOperationalListStyle()
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

private struct iPhoneCollectionQueueRow: View {
    @ObservedObject var model: iPhoneMailboxViewModel
    let office: PostOffice
    let mailbox: Mailbox

    private var ownsClaim: Bool { office.collectionClaim?.userId == model.snapshot?.currentUser.id }
    private var blockedBy: String? { ownsClaim ? nil : office.collectionClaim?.displayName }
    private var detectedText: String { "Mail detected \(iPhoneDisplayDate(iPhoneLatestWaitingDetection(mailbox)))" }
    private var claimActionLabel: String { blockedBy.map { "\($0) is collecting from this post office" } ?? (ownsClaim ? "Cancel I'm collecting" : "I'm collecting") }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 12) {
                copy
                    .frame(minWidth: 210, maxWidth: .infinity, alignment: .leading)
                actions(vertical: true)
            }
            VStack(alignment: .leading, spacing: 12) {
                copy
                actions(vertical: false)
            }
        }
        .padding(.vertical, 4)
    }

    private var copy: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(office.name)
                .font(.headline)
            Text("PO Box \(mailbox.boxNumber)")
                .foregroundStyle(.secondary)
            Text(office.address)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(detectedText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func actions(vertical: Bool) -> some View {
        if vertical {
            VStack(spacing: 7) { actionButtons }
        } else {
            HStack(spacing: 9) { actionButtons }
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        Link(destination: postOfficeDirectionsURL(name: office.name, address: office.address, latitude: office.latitude, longitude: office.longitude)) {
            Image(systemName: "arrow.triangle.turn.up.right.diamond.fill")
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.bordered)
        .help("Directions")
        .accessibilityLabel("Directions to \(office.name)")

        Button {
            Task {
                if ownsClaim {
                    await model.releaseClaim(office)
                } else {
                    await model.claim(office)
                }
            }
        } label: {
            Image(systemName: ownsClaim ? "person.crop.circle.badge.checkmark" : "person.badge.clock")
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.bordered)
        .tint(ownsClaim ? PoboxTheme.green : PoboxTheme.blue)
        .disabled(model.busyMailboxId == "claim:\(office.id)" || blockedBy != nil)
        .help(claimActionLabel)
        .accessibilityLabel(claimActionLabel)
        .accessibilityValue(ownsClaim ? "On" : "Off")

        Button {
            Task { await model.collect(mailbox) }
        } label: {
            Image(systemName: "checkmark.circle.fill")
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.bordered)
        .disabled(model.busyMailboxId == mailbox.id || blockedBy != nil)
        .help(blockedBy.map { "\($0) is collecting from this post office" } ?? "Collected")
        .accessibilityLabel("Mark PO Box \(mailbox.boxNumber) collected")
    }
}

struct iPhoneMailboxList: View {
    @ObservedObject var model: iPhoneMailboxViewModel

    var body: some View {
        List {
            ForEach(model.snapshot?.postOffices ?? []) { office in
                Section {
                    if office.mailboxes.contains(where: hasWaitingItem) {
                        iPhoneCollectionClaimControl(model: model, office: office)
                    }
                    Link(destination: appleMapsURL(for: office)) {
                        Label("Open \(office.name) in Apple Maps", systemImage: "map")
                    }
                    ForEach(office.mailboxes) { mailbox in
                        iPhoneMailboxRow(mailbox: mailbox, busy: model.busyMailboxId == mailbox.id, collectionBlocked: office.collectionClaim?.userId != nil && office.collectionClaim?.userId != model.snapshot?.currentUser.id, postOffices: model.snapshot?.postOffices ?? [], collect: {
                            await model.collect(mailbox)
                        }, updateMailbox: { box, postOfficeId, boxNumber in
                            await model.updateMailbox(box, postOfficeId: postOfficeId, boxNumber: boxNumber)
                        }, deleteMailbox: { box in
                            await model.deleteMailbox(box)
                        })
                    }
                    if office.mailboxes.isEmpty {
                        ContentUnavailableView("No PO box assigned", systemImage: "mail.stack", description: Text("This post office can be deleted or given a PO box."))
                    }
                } header: {
                    Label(office.name, systemImage: "building.2.fill")
                        .font(.headline)
                        .foregroundStyle(.primary)
                } footer: {
                    Text(office.address)
                }
            }
        }
        .iPhoneOperationalListStyle()
        .refreshable {
            await model.refresh()
        }
    }
}

struct iPhoneMailboxRow: View {
    let mailbox: Mailbox
    let busy: Bool
    var collectionBlocked = false
    var postOffices: [PostOffice] = []
    let collect: () async -> Void
    var updateMailbox: ((Mailbox, String, String) async -> Void)?
    var deleteMailbox: ((Mailbox) async -> Void)?
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
                VStack(alignment: .leading, spacing: 3) {
                    Text(mailbox.name)
                        .font(.headline)
                    Text(mailboxStatusLine(mailbox))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                iPhoneStatusBadge(mailbox: mailbox)
                if hasWaitingItem(mailbox) {
                    Button {
                        Task { await collect() }
                    } label: {
                        if busy {
                            ProgressView()
                        } else {
                            Label("Collected", systemImage: "checkmark.circle")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || collectionBlocked)
                    .accessibilityLabel("Mark collected")
                }
            }

            if updateMailbox != nil || deleteMailbox != nil {
                HStack {
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
                .buttonStyle(.borderless)
            }

            if editing {
                Picker("Post office", selection: $postOfficeId) {
                    ForEach(postOffices) { office in
                        Text(office.name).tag(office.id)
                    }
                }
                TextField("PO Box Number", text: $boxNumber)
                Button {
                    Task {
                        await updateMailbox?(mailbox, postOfficeId, boxNumber)
                        editing = false
                    }
                } label: {
                    Label("Save", systemImage: "checkmark")
                }
                .disabled(postOfficeId.isEmpty || boxNumber.isEmpty)
            }
        }
        .confirmationDialog("Delete PO Box \(mailbox.boxNumber)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete PO Box", role: .destructive) {
                Task { await deleteMailbox?(mailbox) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the PO box from active pobox.watch views.")
        }
    }
}

private struct iPhoneCollectionClaimControl: View {
    @ObservedObject var model: iPhoneMailboxViewModel
    let office: PostOffice

    private var ownsClaim: Bool { office.collectionClaim?.userId == model.snapshot?.currentUser.id }

    var body: some View {
        if let activeClaim = office.collectionClaim {
            if ownsClaim {
                HStack(spacing: 10) {
                    Button {
                        Task { await model.releaseClaim(office) }
                    } label: {
                        Label("I'm collecting today", systemImage: "checkmark.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(PoboxTheme.green)
                    .disabled(model.busyMailboxId == "claim:\(office.id)")
                    .accessibilityValue("On")
                    .accessibilityHint("Tap again to cancel your collection plan")
                    Text("until 3:00 am tomorrow")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                HStack(spacing: 10) {
                    Label("\(activeClaim.displayName) is collecting until 3:00 am tomorrow", systemImage: "person.badge.clock")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PoboxTheme.blue)
                    Spacer()
                    if model.snapshot?.currentUser.role == "ADMIN" {
                        Button("Cancel") { Task { await model.releaseClaim(office) } }
                        .disabled(model.busyMailboxId == "claim:\(office.id)")
                    }
                }
            }
        } else {
            Button {
                Task { await model.claim(office) }
            } label: {
                Label("I'll collect today", systemImage: "person.badge.clock")
            }
            .disabled(model.busyMailboxId == "claim:\(office.id)")
            .accessibilityValue("Off")
            .accessibilityHint("Tap to tell the team you will collect from this post office today")
        }
    }
}

struct iPhoneMapList: View {
    let snapshot: MailboxDashboardSnapshot?
    let updatePostOffice: (PostOffice, String, String, String?, Double, Double, Int) async -> Void
    let deletePostOffice: (PostOffice) async -> Void

    var body: some View {
        List {
            ForEach(snapshot?.postOffices ?? []) { office in
                iPhonePostOfficeSection(office: office, updatePostOffice: updatePostOffice, deletePostOffice: deletePostOffice)
            }
        }
        .iPhoneOperationalListStyle()
    }
}

struct iPhonePostOfficeSection: View {
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

            Button {
                name = office.name
                address = office.address
                phone = office.phone ?? ""
                latitude = String(office.latitude)
                longitude = String(office.longitude)
                geofenceRadius = String(office.geofenceRadius)
                editing.toggle()
            } label: {
                Label("Edit Post Office", systemImage: "pencil")
            }

            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Label("Delete Post Office", systemImage: "trash")
            }

            if editing {
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
                        await updatePostOffice(office, name, address, phone.isEmpty ? nil : phone, Double(latitude) ?? office.latitude, Double(longitude) ?? office.longitude, Int(geofenceRadius) ?? office.geofenceRadius)
                        editing = false
                    }
                } label: {
                    Label("Save", systemImage: "checkmark")
                }
                .disabled(name.isEmpty || address.isEmpty || Double(latitude) == nil || Double(longitude) == nil || Int(geofenceRadius) == nil)
            }
        }
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

struct iPhoneHistoryList: View {
    enum Mode {
        case history
        case activity
    }

    let snapshot: MailboxDashboardSnapshot?
    let mode: Mode

    var body: some View {
        List {
            Section {
                Text(mode == .history ? "Recent mail detections and collection records." : "Operational feed for the shared workspace.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section(mode == .history ? "History" : "Activity") {
                let events = Array(snapshot?.history.prefix(50) ?? [])
                if events.isEmpty {
                    Label("No activity yet", systemImage: "clock")
                } else {
                    ForEach(events) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Label(title(for: event), systemImage: icon(for: event))
                                .foregroundStyle(tint(for: event))
                            Text(detail(for: event))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .iPhoneOperationalListStyle()
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
            return "\(mail.sender) - confidence \(Int(mail.parserConfidence * 100))% - \(iPhoneDisplayDate(mail.processedAt))"
        case .collection(let collection):
            return "\(collection.source.rawValue) - \(iPhoneDisplayDate(collection.collectedAt))"
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

struct iPhoneReviewList: View {
    let snapshot: MailboxDashboardSnapshot?
    let reviewItems: [ReviewItem]
    let resolveReviewItem: (ReviewItem, String) async -> Void
    let createMailboxFromReview: (ReviewItem, String, String) async -> Void
    let markReviewItemResolved: (ReviewItem) async -> Void
    let dismissReviewItem: (ReviewItem) async -> Void

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
                        iPhoneReviewItemRow(
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
        .iPhoneOperationalListStyle()
    }

    private func mailboxChoices(from snapshot: MailboxDashboardSnapshot?) -> [iPhoneMailboxChoice] {
        snapshot?.postOffices.flatMap { office in
            office.mailboxes.map { mailbox in
                iPhoneMailboxChoice(id: mailbox.id, officeName: office.name, mailbox: mailbox)
            }
        } ?? []
    }
}

private struct iPhoneMailboxChoice: Identifiable {
    let id: String
    let officeName: String
    let mailbox: Mailbox

    var label: String {
        "\(officeName) - PO Box \(mailbox.boxNumber)"
    }
}

private struct iPhoneReviewItemRow: View {
    let item: ReviewItem
    let postOffices: [PostOffice]
    let mailboxChoices: [iPhoneMailboxChoice]
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
        VStack(alignment: .leading, spacing: 10) {
            Label(item.subject ?? "Unmatched mail notification", systemImage: item.notificationType == "PARCEL" ? "shippingbox.fill" : "envelope.badge.fill")
                .font(.headline)
                .foregroundStyle(.orange)

            Text(reviewSummary)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let preview = item.bodyPreview, !preview.isEmpty {
                Text(preview)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
            }

            if mailboxChoices.isEmpty {
                Label("No saved PO boxes available", systemImage: "mail.stack")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Picker("Existing PO box", selection: $selectedMailboxId) {
                    ForEach(mailboxChoices) { choice in
                        Text(choice.label).tag(choice.id)
                    }
                }

                Button {
                    Task { await resolveReviewItem(item, selectedMailboxId) }
                } label: {
                    Label("Match Existing Box", systemImage: "link")
                }
                .disabled(selectedMailboxId.isEmpty)
            }

            if item.mailboxNumber != nil || item.postOfficeName != nil {
                if postOffices.isEmpty {
                    Text("Add a post office before creating a missing PO box.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Picker("Post office", selection: $createPostOfficeId) {
                        ForEach(postOffices) { office in
                            Text(office.name).tag(office.id)
                        }
                    }

                    TextField("PO Box Number", text: $createBoxNumber)
                        .keyboardType(.numberPad)

                    Button {
                        Task { await createMailboxFromReview(item, createPostOfficeId, createBoxNumber.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    } label: {
                        Label("Create and Resolve", systemImage: "plus.circle")
                    }
                    .disabled(createPostOfficeId.isEmpty || createBoxNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            HStack {
                Button {
                    confirmResolved = true
                } label: {
                    Label("Mark Resolved", systemImage: "checkmark.circle")
                }

                Button(role: .destructive) {
                    confirmIgnore = true
                } label: {
                    Label("Ignore", systemImage: "xmark.circle")
                }
            }
            .font(.callout)
        }
        .padding(.vertical, 6)
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
            "Received \(iPhoneDisplayDate(item.receivedAt ?? item.createdAt))",
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

    private func preferredMailboxChoice() -> iPhoneMailboxChoice? {
        guard let mailboxNumber = item.mailboxNumber else { return nil }
        return mailboxChoices.first { iPhoneNormalizeBoxNumber($0.mailbox.boxNumber) == iPhoneNormalizeBoxNumber(mailboxNumber) }
    }

    private func preferredPostOffice() -> PostOffice? {
        guard let postOfficeName = item.postOfficeName else { return nil }
        return postOffices.first { iPhoneNormalizeLocationName($0.name) == iPhoneNormalizeLocationName(postOfficeName) }
    }
}

struct iPhoneTeamView: View {
    let snapshot: MailboxDashboardSnapshot?
    let members: [TeamMember]
    let createUser: (String, String, String, String) async -> Void
    let updateUser: (TeamMember, String, String, String, String) async -> Void
    let deleteUser: (TeamMember) async -> Void

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
                if !members.contains(where: { $0.deletedAt == nil }) {
                    Label("No team list loaded", systemImage: "person.2")
                } else {
                    ForEach(members.filter { $0.deletedAt == nil }) { member in
                        iPhoneTeamMemberRow(member: member, currentUserId: snapshot?.currentUser.id, canManage: snapshot?.currentUser.role == "ADMIN", updateUser: updateUser, deleteUser: deleteUser)
                    }
                }
            }

            Section("Deleted Users") {
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
                iPhoneCreateUserForm(createUser: createUser)
            } else {
                Section("Add User") {
                    Label("Admin required", systemImage: "lock")
                }
            }
        }
        .iPhoneOperationalListStyle()
    }
}

struct iPhoneTeamMemberRow: View {
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Text(String(member.displayName.prefix(1)).uppercased())
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(member.active ? PoboxTheme.blue : Color.secondary, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(member.displayName)
                        .font(.headline)
                    Text(member.email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 6) {
                        iPhoneTextBadge(text: member.status.capitalized, tint: member.active ? PoboxTheme.green : .secondary)
                        iPhoneTextBadge(text: member.role.capitalized, tint: PoboxTheme.blue)
                    }
                }
            }
            if canManage {
                HStack {
                    Button {
                        displayName = member.displayName
                        email = member.email
                        role = member.role
                        status = member.status
                        editing.toggle()
                    } label: {
                        Image(systemName: "pencil")
                    }
                    .accessibilityLabel("Edit \(member.displayName)")
                    Button {
                        Task {
                            await updateUser(member, member.email, member.displayName, member.role, member.active ? "DISABLED" : "ACTIVE")
                        }
                    } label: {
                        Image(systemName: member.active ? "person.slash" : "person.badge.plus")
                    }
                    .disabled(member.id == currentUserId)
                    .accessibilityLabel(member.active ? "Disable \(member.displayName)" : "Reactivate \(member.displayName)")
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(member.id == currentUserId)
                    .accessibilityLabel("Delete \(member.displayName)")
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)
            } else {
                Label("Admin required", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if editing {
                TextField("Name", text: $displayName)
                TextField("Email", text: $email)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                Picker("Role", selection: $role) {
                    Text("Member").tag("MEMBER")
                    Text("Admin").tag("ADMIN")
                }
                .disabled(member.id == currentUserId)
                Picker("Status", selection: $status) {
                    Text("Active").tag("ACTIVE")
                    Text("Invited").tag("INVITED")
                    Text("Disabled").tag("DISABLED")
                }
                .disabled(member.id == currentUserId)
                Button {
                    Task {
                        await updateUser(member, email, displayName, role, status)
                        editing = false
                    }
                } label: {
                    Label("Save", systemImage: "checkmark")
                }
                .disabled(displayName.isEmpty || email.isEmpty)
            }
        }
        .task(id: member.id) {
            displayName = member.displayName
            email = member.email
            role = member.role
            status = member.status
        }
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
                PasswordSettingsView(onChanged: logout)
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
                    Label("Admin required to add post offices and boxes", systemImage: "lock")
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
        .iPhoneOperationalListStyle()
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

private struct iPhoneStatusBadge: View {
    let mailbox: Mailbox

    var body: some View {
        Image(systemName: hasWaitingItem(mailbox) ? (mailbox.parcelWaiting ? "shippingbox.fill" : "envelope.fill") : "checkmark")
            .font(.caption.bold())
            .foregroundStyle(hasWaitingItem(mailbox) ? PoboxTheme.orange : PoboxTheme.green)
            .frame(width: 30, height: 30)
            .background((hasWaitingItem(mailbox) ? PoboxTheme.orange : PoboxTheme.green).opacity(0.12), in: Circle())
            .accessibilityLabel(mailboxStatus(mailbox))
    }
}

private struct iPhoneTextBadge: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
    }
}

private extension View {
    func iPhoneOperationalListStyle() -> some View {
        scrollContentBackground(.hidden)
            .background(PoboxTheme.pageBackground)
            .listStyle(.insetGrouped)
    }

    func poboxLoginField() -> some View {
        padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(PoboxTheme.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(PoboxTheme.border))
    }
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

private func iPhoneLatestWaitingDetection(_ mailbox: Mailbox) -> String? {
    [
        mailbox.mailWaiting ? mailbox.latestNotificationAt : nil,
        mailbox.parcelWaiting ? mailbox.latestParcelNotificationAt : nil
    ]
    .compactMap { $0 }
    .max { iPhoneDateValue($0) < iPhoneDateValue($1) }
}

private func iPhoneDateValue(_ value: String) -> Date {
    let withFractionalSeconds = ISO8601DateFormatter()
    withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let standard = ISO8601DateFormatter()
    standard.formatOptions = [.withInternetDateTime]
    return withFractionalSeconds.date(from: value) ?? standard.date(from: value) ?? .distantPast
}

private func appleMapsURL(for office: PostOffice) -> URL {
    postOfficeMapsURL(name: office.name, address: office.address, latitude: office.latitude, longitude: office.longitude)
}

private func iPhoneNormalizeBoxNumber(_ value: String) -> String {
    value.filter(\.isNumber)
}

private func iPhoneNormalizeLocationName(_ value: String) -> String {
    value
        .lowercased()
        .replacingOccurrences(of: "local post office", with: "")
        .replacingOccurrences(of: "post office", with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func iPhoneDisplayDate(_ value: String?) -> String {
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
