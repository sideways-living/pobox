import Foundation
import CryptoKit

public struct NativeSignInProof: Sendable {
    public let verifier: String
    public var challenge: String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    public init() {
        var generator = SystemRandomNumberGenerator()
        verifier = Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
            .base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

public actor PoboxWatchAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public static let live = PoboxWatchAPIClient(baseURL: URL(string: "https://pobox.watch")!)

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func login(email: String, password: String) async throws -> LoginResult {
        let url = baseURL.appending(path: "/api/v1/auth/login")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(LoginRequest(email: email, password: password))
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(LoginResult.self, from: data)
    }

    public func verifySecondFactor(challengeId: String, code: String) async throws -> LoginResult {
        let url = baseURL.appending(path: "/api/v1/auth/2fa/verify")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(TwoFactorRequest(challengeId: challengeId, code: code))
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(LoginResult.self, from: data)
    }

    public func consumeNativeHandoff(code: String, verifier: String) async throws -> LoginResult {
        let url = baseURL.appending(path: "/api/v1/auth/native-handoff/consume")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(NativeHandoffRequest(code: code, verifier: verifier))
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(LoginResult.self, from: data)
    }

    public func logout() async throws {
        let url = baseURL.appending(path: "/api/v1/auth/logout")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    public func dashboard(workspaceId: String) async throws -> MailboxDashboardSnapshot {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/dashboard")
        let (data, response) = try await session.data(from: url)
        try validate(response, data: data)
        return try decoder.decode(MailboxDashboardSnapshot.self, from: data)
    }

    public func reviewItems(workspaceId: String) async throws -> [ReviewItem] {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/review-items")
        let (data, response) = try await session.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([ReviewItem].self, from: data)
    }

    public func resolveReviewItem(workspaceId: String, reviewItemId: String, mailboxId: String) async throws {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/review-items/\(reviewItemId)/resolve")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(["mailboxId": mailboxId])
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    public func markReviewItemResolved(workspaceId: String, reviewItemId: String) async throws {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/review-items/\(reviewItemId)/mark-resolved")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    public func dismissReviewItem(workspaceId: String, reviewItemId: String) async throws {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/review-items/\(reviewItemId)/dismiss")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    public func teamMembers(workspaceId: String) async throws -> [TeamMember] {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/team/members")
        let (data, response) = try await session.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([TeamMember].self, from: data)
    }

    public func collectMailbox(workspaceId: String, mailboxId: String, source: MailboxCollectionSource, expectedUpdatedAt: String?) async throws {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/mailboxes/\(mailboxId)/collect")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(["source": source.rawValue, "expectedUpdatedAt": expectedUpdatedAt ?? ""])
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    public func createUser(workspaceId: String, input: CreateUserInput) async throws -> TeamMember {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/team/users")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(input)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(TeamMember.self, from: data)
    }

    public func updateUser(workspaceId: String, userId: String, input: UpdateUserInput) async throws -> TeamMember {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/team/users/\(userId)")
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(input)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(TeamMember.self, from: data)
    }

    public func deleteUser(workspaceId: String, userId: String) async throws {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/team/users/\(userId)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    public func createPostOffice(workspaceId: String, input: CreatePostOfficeInput) async throws -> PostOffice {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/post-offices")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(input)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(PostOffice.self, from: data)
    }

    public func updatePostOffice(workspaceId: String, postOfficeId: String, input: UpdatePostOfficeInput) async throws -> PostOffice {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/post-offices/\(postOfficeId)")
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(input)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(PostOffice.self, from: data)
    }

    public func deletePostOffice(workspaceId: String, postOfficeId: String) async throws {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/post-offices/\(postOfficeId)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    public func searchPostOfficeLocations(workspaceId: String, query: String) async throws -> [PostOfficeLocationResult] {
        var url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/post-office-locations/search")
        url.append(queryItems: [URLQueryItem(name: "query", value: query)])
        let (data, response) = try await session.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([PostOfficeLocationResult].self, from: data)
    }

    public func createMailbox(workspaceId: String, input: CreateMailboxInput) async throws -> Mailbox {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/mailboxes")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(input)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(Mailbox.self, from: data)
    }

    public func updateMailbox(workspaceId: String, mailboxId: String, input: UpdateMailboxInput) async throws -> Mailbox {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/mailboxes/\(mailboxId)")
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(input)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(Mailbox.self, from: data)
    }

    public func deleteMailbox(workspaceId: String, mailboxId: String) async throws {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/mailboxes/\(mailboxId)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    private func validate(_ response: URLResponse, data: Data) throws {
        if let http = response as? HTTPURLResponse, http.statusCode == 401 || (http.statusCode == 403 && http.url?.lastPathComponent == "dashboard") {
            throw PoboxWatchAPIError.authenticationRequired
        }
        guard let httpResponse = response as? HTTPURLResponse, 200..<300 ~= httpResponse.statusCode else {
            if let errorResponse = try? decoder.decode(ErrorResponse.self, from: data) {
                throw PoboxWatchAPIError.requestFailed(errorResponse.error)
            }
            throw PoboxWatchAPIError.requestFailed("Request failed. Please check your login details and connection.")
        }
    }
}

public enum PoboxWatchAPIError: LocalizedError {
    case requestFailed(String)
    case authenticationRequired

    public var errorDescription: String? {
        switch self {
        case .requestFailed(let message): message
        case .authenticationRequired: "Please sign in again. Your session or security code is no longer valid."
        }
    }
}

private struct ErrorResponse: Decodable {
    let error: String
}

private struct LoginRequest: Encodable {
    let email: String
    let password: String
}

private struct TwoFactorRequest: Encodable {
    let challengeId: String
    let code: String
}

private struct NativeHandoffRequest: Encodable {
    let code: String
    let verifier: String
}

public struct LoginResult: Codable, Sendable {
    public let ok: Bool
    public let twoFactorRequired: Bool?
    public let challengeId: String?
    public let expiresAt: String
    public let previousLoginAt: String?
}
