import Foundation

public struct LocationReminderPolicy: Sendable {
    public let cooldownSeconds: TimeInterval

    public init(cooldownSeconds: TimeInterval = 60 * 60) {
        self.cooldownSeconds = cooldownSeconds
    }

    public func shouldPrompt(postOffice: PostOffice, now: Date, lastPromptAt: Date?) -> Bool {
        guard postOffice.mailboxes.contains(where: { $0.mailWaiting || $0.parcelWaiting }) else { return false }
        guard let lastPromptAt else { return true }
        return now.timeIntervalSince(lastPromptAt) >= cooldownSeconds
    }
}
