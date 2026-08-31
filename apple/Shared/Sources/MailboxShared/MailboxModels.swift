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
    public let history: [MailboxHistoryEvent]
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

public enum MailboxHistoryEvent: Codable, Identifiable, Sendable {
    case mail(MailEvent)
    case collection(CollectionEvent)

    public var id: String {
        switch self {
        case .mail(let event): event.id
        case .collection(let event): event.id
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.processedAt) {
            self = .mail(try MailEvent(from: decoder))
        } else {
            self = .collection(try CollectionEvent(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .mail(let event): try event.encode(to: encoder)
        case .collection(let event): try event.encode(to: encoder)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case processedAt
    }
}

public struct MailEvent: Codable, Identifiable, Sendable {
    public let id: String
    public let workspaceId: String
    public let mailboxId: String
    public let provider: String
    public let providerMessageId: String
    public let sender: String
    public let subject: String
    public let receivedAt: String
    public let parserConfidence: Double
    public let parserRuleId: String?
    public let processedAt: String
}

public struct CollectionEvent: Codable, Identifiable, Sendable {
    public let id: String
    public let workspaceId: String
    public let mailboxId: String
    public let collectedBy: String
    public let collectedAt: String
    public let source: MailboxCollectionSource
    public let method: String
}
