import Foundation

public enum MailboxCollectionSource: String, Codable, Sendable {
    case iPhone = "IPHONE"
    case macOS = "MACOS"
    case web = "WEB"
    case admin = "ADMIN"
    case notification = "NOTIFICATION"
}

public struct MailboxDashboardSnapshot: Codable, Sendable {
    public let workspace: Workspace
    public let currentUser: CurrentUser
    public let outstandingMailboxCount: Int
    public let postOffices: [PostOffice]
}

public struct Workspace: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
}

public struct CurrentUser: Codable, Identifiable, Sendable {
    public let id: String
    public let email: String
    public let displayName: String
    public let role: String
}

public struct PostOffice: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let address: String
    public let latitude: Double
    public let longitude: Double
    public let geofenceRadius: Int
    public let active: Bool
    public let mailboxes: [Mailbox]
}

public struct Mailbox: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let boxNumber: String
    public let active: Bool
    public let mailWaiting: Bool
    public let latestNotificationAt: String?
    public let lastCollectedAt: String?
    public let lastCollectedBy: String?
}
