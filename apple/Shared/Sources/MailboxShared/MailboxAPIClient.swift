import Foundation

public actor MailboxAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public static let live = MailboxAPIClient(baseURL: URL(string: "https://pobox.watch")!)

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
        try validate(response)
        return try decoder.decode(LoginResult.self, from: data)
    }

    public func verifySecondFactor(challengeId: String, code: String) async throws -> LoginResult {
        let url = baseURL.appending(path: "/api/v1/auth/2fa/verify")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(TwoFactorRequest(challengeId: challengeId, code: code))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(LoginResult.self, from: data)
    }

    public func logout() async throws {
        let url = baseURL.appending(path: "/api/v1/auth/logout")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    public func dashboard(workspaceId: String) async throws -> MailboxDashboardSnapshot {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/dashboard")
        let (data, response) = try await session.data(from: url)
        try validate(response)
        return try decoder.decode(MailboxDashboardSnapshot.self, from: data)
    }

    public func collectMailbox(workspaceId: String, mailboxId: String, source: MailboxCollectionSource) async throws {
        let url = baseURL.appending(path: "/api/v1/workspaces/\(workspaceId)/mailboxes/\(mailboxId)/collect")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(["source": source.rawValue])
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    private func validate(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse, 200..<300 ~= httpResponse.statusCode else {
            throw MailboxAPIError.requestFailed
        }
    }
}

public enum MailboxAPIError: Error {
    case requestFailed
}

private struct LoginRequest: Encodable {
    let email: String
    let password: String
}

private struct TwoFactorRequest: Encodable {
    let challengeId: String
    let code: String
}

public struct LoginResult: Codable, Sendable {
    public let ok: Bool
    public let twoFactorRequired: Bool?
    public let challengeId: String?
    public let expiresAt: String
    public let previousLoginAt: String?
}
